/*
  AI Player Engine for Codenames
  - LLM-powered AI players (Helper & Autonomous modes)
  - Nebius Token Factory API (OpenAI-compatible)
  - Ready-up verification with status colors
  - Structured outputs for clues/guesses
  - Natural language chat & reactions
*/

// ─── Configuration ───────────────────────────────────────────────────────────
const AI_CONFIG = {
  baseURL: 'https://api.tokenfactory.nebius.com/v1',
  // IMPORTANT: Never hardcode API keys in the repo.
  // Key is stored locally per-browser.
  apiKey: (function(){
    try {
      // Prefer the key from ai-key.local.js (window.CT_AI_API_KEY) if provided.
      const fromFile = (typeof window !== 'undefined' && window.CT_AI_API_KEY) ? String(window.CT_AI_API_KEY).trim() : '';
      if (fromFile) return fromFile;

      // Fallback: key stored locally per-browser.
      const k = localStorage.getItem('ct_ai_apiKey') || '';
      return String(k || '').trim();
    } catch (_) {
      return '';
    }
  })(),
  model: 'meta-llama/Llama-3.3-70B-Instruct',            // instruct brain — chat, personality, reactions
  reasoningModel: 'deepseek-ai/DeepSeek-R1-0528',        // reasoning brain — strategic decisions
  maxAIsPerTeam: 4,
};

// If the key is missing, allow a one-time prompt to set it (dev convenience).
// This keeps secrets out of source control.
let __ct_aiKeyPrompted = false;
function ensureAIKeyPresent() {
  try {
    if (AI_CONFIG.apiKey) return true;
    if (__ct_aiKeyPrompted) return false;
    __ct_aiKeyPrompted = true;
    const entered = prompt('AI API key not found. Paste your key to enable AI players (stored locally in this browser):');
    const cleaned = String(entered || '').trim();
    if (!cleaned) return false;
    localStorage.setItem('ct_ai_apiKey', cleaned);
    AI_CONFIG.apiKey = cleaned;
    return true;
  } catch (_) {
    return false;
  }
}

// No artificial human-like delays. AIs act as soon as they can.

// AI name pools - human-sounding names
const AI_NAMES = [
  'Alex', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Sage',
  'Rowan', 'Finley', 'Skyler', 'Blake', 'Drew', 'Reese', 'Kai', 'Nova',
  'Max', 'Sam', 'Jamie', 'Robin', 'Frankie', 'Charlie', 'Pat', 'Dana',
];

// ─── State ───────────────────────────────────────────────────────────────────
let aiPlayers = []; // { id, name, team, seatRole, mode, status, statusColor }
let aiIntervals = {}; // keyed by ai id → interval handle for game loop
let aiChatTimers = {}; // keyed by ai id → timeout for delayed chat
let aiLastChatSeenMs = {}; // keyed by ai id → last seen team-chat timestamp
let aiLastChatReplyMs = {}; // keyed by ai id → last time we replied
let aiLastOffTurnScoutMs = {}; // keyed by ai id → last off-turn analysis timestamp
let aiNextId = 1;

// ─── Multi-client AI hosting (one "controller" runs the AI loop) ─────────────
const LS_AI_CLIENT_ID = 'ct_ai_clientId_v1';
const AI_CONTROLLER_TTL_MS = 15000;      // controller lease duration
const AI_CONTROLLER_HEARTBEAT_MS = 5000; // heartbeat cadence
let lastAIHeartbeatSentAt = 0;

function getAIClientId() {
  try {
    let id = localStorage.getItem(LS_AI_CLIENT_ID);
    if (!id) {
      id = `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(LS_AI_CLIENT_ID, id);
    }
    return id;
  } catch (_) {
    return `client_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  }
}

function tsToMs(ts) {
  if (!ts) return 0;
  if (typeof ts === 'number') return ts;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  return 0;
}

function getPhaseTimerSecondsFromGame(game, phase) {
  const qs = (game && typeof game.quickSettings === 'object' && game.quickSettings) ? game.quickSettings : {};
  if (phase === 'spymaster') {
    const secs = Number(qs.clueTimerSeconds);
    return Number.isFinite(secs) ? Math.max(0, secs) : 0;
  }
  if (phase === 'operatives') {
    const secs = Number(qs.guessTimerSeconds);
    return Number.isFinite(secs) ? Math.max(0, secs) : 0;
  }
  return 0;
}

function buildPhaseTimerEndForGame(game, phase) {
  const secs = getPhaseTimerSecondsFromGame(game, phase);
  if (!secs) return null;
  const ms = Date.now() + (secs * 1000);
  try {
    return firebase.firestore.Timestamp.fromDate(new Date(ms));
  } catch (_) {
    return new Date(ms);
  }
}

async function claimAIController(gameId) {
  const myId = getAIClientId();
  const ref = db.collection('games').doc(gameId);
  try {
    let claimed = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data() || {};
      const hbMs = tsToMs(g.aiControllerHeartbeat);
      const now = Date.now();
      const expired = !hbMs || (now - hbMs > AI_CONTROLLER_TTL_MS);
      if (!g.aiControllerId || expired || g.aiControllerId === myId) {
        tx.update(ref, {
          aiControllerId: myId,
          aiControllerHeartbeat: firebase.firestore.FieldValue.serverTimestamp(),
        });
        claimed = true;
      }
    });
    return claimed;
  } catch (e) {
    console.warn('Failed to claim AI controller:', e);
    return false;
  }
}

async function maybeHeartbeatAIController(gameId, game) {
  const myId = getAIClientId();
  const now = Date.now();
  const ctrlId = String(game?.aiControllerId || '');
  const hbMs = tsToMs(game?.aiControllerHeartbeat);
  const valid = ctrlId && hbMs && (now - hbMs <= AI_CONTROLLER_TTL_MS);

  // If nobody holds the lease (or it expired), try to claim it.
  if (!valid) {
    return await claimAIController(gameId);
  }

  const amController = (ctrlId === myId);
  if (amController && (now - lastAIHeartbeatSentAt > AI_CONTROLLER_HEARTBEAT_MS)) {
    lastAIHeartbeatSentAt = now;
    try {
      await db.collection('games').doc(gameId).update({
        aiControllerHeartbeat: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }
  return amController;
}

// Build an AI list from the game doc so every client can render/host AIs.
function extractAIPlayersFromGame(game) {
  const out = [];
  const pushTeam = (team) => {
    const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
    const players = Array.isArray(game?.[key]) ? game[key] : [];
    for (const p of players) {
      if (!p || !p.isAI) continue;
      const odId = String(p.odId || '').trim();
      if (!odId) continue;
      const ready = !!p.ready;
      out.push({
        id: String(p.aiId || p.ai_id || p.ai || odId),
        odId,
        name: String(p.name || 'AI'),
        team,
        seatRole: (String(p.role || 'operative') === 'spymaster') ? 'spymaster' : 'operative',
        // Helper mode was removed; coerce any legacy values to autonomous
        mode: (String(p.aiMode || 'autonomous').toLowerCase() === 'helper') ? 'autonomous' : String(p.aiMode || 'autonomous'),
        // IMPORTANT: other clients may not have local ready-check state.
        // Derive the lobby indicator from Firestore ready flag so AIs don't show
        // "CHECKING" forever on non-host clients.
        statusColor: ready ? 'green' : 'none',
        ready,
        isAI: true,
        temperature: Number.isFinite(+p.aiTemperature) ? +p.aiTemperature : undefined,
        personality: (p.aiPersonality && typeof p.aiPersonality === 'object') ? p.aiPersonality : undefined,
      });
    }
  };
  pushTeam('red');
  pushTeam('blue');
  return out;
}

function syncAIPlayersFromGame(game) {
  if (!game) return;

  const fromDoc = extractAIPlayersFromGame(game);
  if (!fromDoc.length) {
    aiPlayers = [];
    window.aiPlayers = aiPlayers;
    return;
  }

  // Preserve local ephemeral state (statusColor, timers) by odId
  const prev = new Map((aiPlayers || []).map(a => [a.odId, a]));
  aiPlayers = fromDoc.map(a => {
    const p = prev.get(a.odId);
    // Keep non-trivial local statusColor (yellow/red), but never overwrite
    // a Firestore-derived green with a local "none".
    const keep = (p && p.statusColor && p.statusColor !== 'none') ? p.statusColor : a.statusColor;
    return p ? { ...a, statusColor: keep } : a;
  });

  window.aiPlayers = aiPlayers;

  // New match = new personalities.
  // Best-effort: one client (the controller) assigns fresh personality+temperature
  // to every AI the first time the match leaves the lobby.
  try { maybeAssignNewMatchPersonalities(game); } catch (_) {}

  // Ensure each AI has a stable identity + private mind.
  try { for (const a of aiPlayers) ensureAICore(a); } catch (_) {}

  // Update vision for every AI whenever the game snapshot changes.
  try { updateAIVisionFromGame(game); } catch (_) {}

  // NOTE: We intentionally do NOT auto-run ready checks from every client.
  // Ready checks are performed when an AI is added, and readiness is stored
  // on the game doc. That keeps the lobby stable and avoids multi-client
  // Firestore lease contention.
}

window.syncAIPlayersFromGame = syncAIPlayersFromGame;

function getActiveGameIdForAI() {
  return (quickLobbyGame && quickLobbyGame.id) || (currentGame && currentGame.id) || QUICKPLAY_DOC_ID;
}


// Verify and ready-up any AI players that are present but not ready yet.
async function maybeVerifyLobbyAIs(game) {
  const gameId = game?.id;
  if (!gameId) return;
  const amController = await maybeHeartbeatAIController(gameId, game);
  if (!amController) return;

  const notReady = (aiPlayers || []).filter(a => a.isAI && !a.ready);
  if (!notReady.length) return;

  for (const ai of notReady) {
    // Avoid multiple concurrent checks for the same AI
    if (aiThinkingState[ai.id]) continue;
    aiThinkingState[ai.id] = true;
    const ok = await verifyAIReady(ai);
    aiThinkingState[ai.id] = false;
    if (ok) {
      ai.ready = true;
      await setAIReadyInFirestore(ai, true);
    }
  }
}
let aiThinkingState = {}; // keyed by ai id → true when AI is processing

// ─── Exports ─────────────────────────────────────────────────────────────────
window.aiPlayers = aiPlayers;
window.AI_CONFIG = AI_CONFIG;

// ─── LLM API Calls ──────────────────────────────────────────────────────────

async function aiChatCompletion(messages, options = {}) {

  if (!ensureAIKeyPresent()) {
    throw new Error('Missing AI API key. Set localStorage "ct_ai_apiKey" (or paste when prompted) before using AI players.');
  }

  const body = {
    model: AI_CONFIG.model,
    messages,
    temperature: options.temperature ?? 0.85,
    max_tokens: options.max_tokens ?? 512,
  };

  if (options.response_format) {
    body.response_format = options.response_format;
  }

  const resp = await fetch(`${AI_CONFIG.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content || '';
}
window.aiChatCompletion = aiChatCompletion;

// ─── Reasoning model completion (strategic "deep thinking" brain) ────────────
async function aiReasoningCompletion(messages, options = {}) {

  if (!ensureAIKeyPresent()) {
    throw new Error('Missing AI API key. Set localStorage "ct_ai_apiKey" (or paste when prompted) before using AI players.');
  }

  const body = {
    model: AI_CONFIG.reasoningModel,
    messages,
    max_tokens: options.max_tokens ?? 512,
  };
  if (options.response_format) {
    body.response_format = options.response_format;
  }
  // Reasoning models do not support temperature — omit it.

  const resp = await fetch(`${AI_CONFIG.baseURL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`AI Reasoning API ${resp.status}: ${text}`);
  }

  const data = await resp.json();
  const msg = data.choices?.[0]?.message || {};
  return {
    content: msg.content || '',
    reasoning: msg.reasoning_content || '',
  };
}
window.aiReasoningCompletion = aiReasoningCompletion;

function appendReasoningToMind(ai, reasoning) {
  if (!reasoning) return;
  const snippet = reasoning.length > 300
    ? reasoning.slice(0, 300) + '...'
    : reasoning;
  appendMind(ai, `[deep thinking] ${snippet}`);
}

function hasBlockingPendingClueReview(game) {
  const pending = game?.pendingClue;
  if (!pending || typeof pending !== 'object') return false;
  const state = String(pending.state || '').toLowerCase();
  return state === 'awaiting' || state === 'reviewing';
}

// ─── Fetch Recent Team Chat (so AI can see human messages) ──────────────────

async function fetchRecentTeamChat(gameId, teamColor, limit = 15) {
  try {
    const snap = await db.collection('games').doc(gameId)
      .collection(`${teamColor}Chat`)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();
    const msgs = snap.docs.map(d => d.data()).reverse();
    return msgs.map(m => `${m.senderName}: ${m.text}`).join('\n');
  } catch (e) {
    console.warn('Failed to fetch team chat for AI:', e);
    return '';
  }
}

// Structured chat fetch (for conversational replies + de-duplication).
async function fetchRecentTeamChatDocs(gameId, teamColor, limit = 12) {
  try {
    const snap = await db.collection('games').doc(gameId)
      .collection(`${teamColor}Chat`)
      .orderBy('createdAt', 'desc')
      .limit(limit)
      .get();

    const out = snap.docs.map(d => {
      const m = d.data() || {};
      return {
        senderId: String(m.senderId || ''),
        senderName: String(m.senderName || ''),
        text: String(m.text || ''),
        createdAtMs: tsToMs(m.createdAt),
      };
    }).reverse();

    return out;
  } catch (e) {
    console.warn('Failed to fetch team chat docs for AI:', e);
    return [];
  }
}

// ─── Ready-Up Verification ──────────────────────────────────────────────────

async function verifyAIReady(ai) {
  ai.statusColor = 'none'; // colorless by default
  try { if (typeof renderQuickLobby === 'function') renderQuickLobby(quickLobbyGame); } catch (_) {}

  try {
    const result = await aiChatCompletion([
      {
        role: 'system',
        content: [
          'You are performing a connectivity + JSON compliance check.',
          'Return ONLY valid JSON (no markdown, no extra text).',
          'Schema: {"ready": true, "message": "optional short string"}',
          'Set ready=true if you can comply.'
        ].join('\n'),
      },
      { role: 'user', content: 'Ready check. Reply with JSON only.' }
    ], {
      max_tokens: 80,
      temperature: 0,
      response_format: { type: 'json_object' }
    });

    // Parse strict JSON; if a model ever wraps it, try a best-effort extraction
    let parsed = null;
    try {
      parsed = JSON.parse(String(result || '').trim());
    } catch (e) {
      const s = String(result || '');
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a >= 0 && b > a) {
        try { parsed = JSON.parse(s.slice(a, b + 1)); } catch (_) {}
      }
      if (!parsed) throw new Error('Could not parse ready check JSON');
    }

    if (parsed && parsed.ready === true) {
      ai.statusColor = 'green';
    } else {
      ai.statusColor = 'yellow';
      console.warn(`AI ${ai.name} ready check returned not-ready:`, parsed);
    }
  } catch (err) {
    ai.statusColor = 'red';
    console.error(`AI ${ai.name} ready check failed:`, err);
  }

  try { if (typeof renderQuickLobby === 'function') renderQuickLobby(quickLobbyGame); } catch (_) {}
  return ai.statusColor === 'green';
}

// ─── AI Personality + Temperature ────────────────────────────────────────────
//
// Each AI has:
// 1) Vision (auto-updated snapshot of what they can see on-screen)
// 2) Mind (private inner monologue log; the only way they "think")
// 3) Tips (a deep Codenames manual included in prompts)
//
// We randomize each AI's temperature + a strict personality, and persist them
// in the game doc so every client sees the same AI identity.

const AI_TIPS_MANUAL = `
CODENAMES OPERATING MANUAL (for both Spymasters and Operatives)

Core objective:
- As a TEAM, reveal all of your team's words before the other team does, without hitting the assassin.

Teamwork & communication:
- Talk to your teammates. Share hypotheses, doubts, and “why not” eliminations before committing.
- Use quick, concrete messages: “I like 7=CAR because wheel→car; I dislike 12=RING because it’s too generic.”
- Use markings to coordinate:
  - YES = strong candidate for the current clue
  - MAYBE = plausible but needs caution / could be later
  - NO = dangerous pull (likely wrong / likely assassin/opponent/neutral or too “hubby”)
- Don’t spam: mark 1–3 key cards and write short chat messages that help the group converge.
- Strongly prefer real conversation before actions:
  - React to teammate suggestions (agree/disagree + why).
  - If you want to END TURN, say so explicitly, give the reason, and ask if others are aligned.
  - Avoid “silent” endings; a quick "I think we should stop unless someone sees a safe pick" is better.

Spymaster fundamentals:
- Your job is to give a single-word clue that connects multiple of your unrevealed team words while avoiding the assassin and minimizing pulls to opponent/neutral words.
- Strong clues have a tight “center” that naturally pulls toward your targets and away from everything else.
- Prefer clues that:
  - Connect 2–4 targets cleanly
  - Are specific enough to exclude obvious wrong-board pulls
  - Leave future options (don’t waste a clue that will be even better later)

How to choose a clue:
1) Cluster your remaining team words into natural groups (themes, parts/wholes, common phrases, functions, contexts).
2) For each candidate clue, imagine what operatives will do:
   - What are the top 3–6 board words this clue would pull?
   - If any of those are assassin/opponent, the clue is risky.
3) Reduce ambiguity:
   - Avoid “hub” words with too many meanings (bank, ring, light, spring) unless board context makes the intended sense obvious.
   - Avoid clues that are easily misread into a different sense.
4) Choose the number:
   - Number should match how many words you truly intend.
   - Bigger isn’t automatically better: a safe 3 often beats a risky 4.
   - If one target is borderline, lower the number.
5) Using 0 can be useful:
   - A 0-clue is a defensive tool: it can warn operatives away from a dangerous association (“WATER 0” to signal “don’t touch OCEAN if it feels assassin-ish”).
   - Use it sparingly and only when it meaningfully reduces risk.

Operative fundamentals:
- Interpret the clue and guess unrevealed words that belong to your team.
- Treat each guess as a risk decision; assassin ends the game.
- Use elimination:
  - If a word matches the clue but also matches a very plausible assassin/opponent pull, be cautious.
  - Avoid generic “semantic hubs” unless the clue is very specific.
- Maintain clue-sense consistency:
  - For clue N≥2, your guesses should usually share the same sense of the clue (don’t mix meanings).
- Respect the guess budget:
  - First N guesses can be confident-but-practical.
  - The bonus guess (N+1) should require very high confidence.
- Ending early is sometimes necessary:
  - Passing is a strategic choice when remaining candidates are shaky or high-risk.
  - Protecting the lead (or avoiding the assassin) is often correct.
  - When you have teammates, treat ending as a team decision: propose it, listen for pushback, and only then commit.

Association types you may use (both roles):
- Synonyms and near-synonyms
- Common phrases and collocations
- Parts/whole relations (wheel↔car)
- Typical contexts (casino↔gambling↔Vegas)
- Widely recognizable pop-culture references (only if they are broadly known)

Discipline:
- If unsure, stop. Ending the turn is often better than gambling.
- Don’t “wish-cast” guesses. Be able to explain the link clearly.
`.trim();

// ─── Subject Pool (144 topics) ───────────────────────────────────────────────
// The LLM picks 1–3 of these as an AI's "focus" — domains they lean on for
// word associations, clues, and in-character chat references.
const SUBJECT_POOL = [
  // Sports
  "American Football", "Basketball", "Baseball", "Soccer / Football",
  "Tennis", "Golf", "Ice Hockey", "Swimming & Diving", "Track & Field",
  "MMA & Boxing", "Cricket", "Rugby", "Formula 1 Racing", "NASCAR",
  "Cycling", "Skiing & Snowboarding", "Surfing", "Gymnastics",
  "Volleyball", "Wrestling",
  // Gaming & Tabletop
  "Esports", "Video Games - FPS", "Video Games - RPG",
  "Video Games - Strategy", "Retro Gaming", "Tabletop RPGs & D&D",
  "Board Games & Chess",
  // Academic
  "Philosophy", "Mathematics", "Linguistics", "Economics",
  "Psychology", "Sociology", "Anthropology", "Political Science",
  "Archaeology", "Law & Legal Theory",
  // Science
  "Physics", "Chemistry", "Biology", "Astronomy & Space",
  "Medicine & Anatomy", "Neuroscience", "Ecology & Environment",
  "Geology", "Meteorology", "Marine Biology",
  // History
  "Ancient History", "Medieval History", "The Renaissance", "Roman Empire",
  "Greek Antiquity", "American History", "World War I & II",
  "Cold War History", "Colonial History", "History of Science",
  // Arts & Literature
  "Classic Literature", "Poetry", "Modern Fiction",
  "Comic Books & Graphic Novels", "Screenwriting & Film Theory",
  "Theater & Drama", "Art History & Painting", "Sculpture & Architecture",
  "Photography", "Fashion & Design",
  // Music
  "Classical Music", "Jazz", "Rock & Metal", "Hip-Hop & Rap",
  "Pop Music", "Electronic & EDM", "Country & Folk",
  "R&B & Soul", "Opera", "Music Theory",
  // Film & TV
  "Sci-Fi Films & TV", "Horror Films", "Action & Thriller",
  "Animated Films & Shows", "Reality TV", "True Crime",
  "Documentaries", "Classic Hollywood", "Foreign Cinema",
  // Pop Culture & Internet
  "Anime & Manga", "Memes & Internet Culture",
  "Superhero Comics & Films", "Fantasy (Tolkien, GoT, etc.)",
  "Star Wars Universe", "Star Trek Universe", "Harry Potter Universe",
  "Social Media Culture",
  // Food & Drink
  "Cooking & Culinary Arts", "Baking & Pastry", "Wine & Sommelier",
  "Cocktails & Mixology", "Coffee Culture", "Street Food",
  "Fine Dining", "BBQ & Grilling", "Veganism & Plant-Based",
  "Food History & Anthropology",
  // Nature & Outdoors
  "Botany & Plants", "Zoology & Wildlife", "Hiking & Mountaineering",
  "Camping & Survival", "Birdwatching", "Ocean & Marine Life",
  // Technology
  "Programming & Software", "Artificial Intelligence", "Cybersecurity",
  "Hardware & Electronics", "Space Technology", "Robotics",
  "Cryptocurrency & Blockchain", "Biotechnology",
  // Mythology & Religion
  "Greek Mythology", "Norse Mythology", "Egyptian Mythology",
  "Roman Mythology", "Hinduism & Vedic Texts", "Buddhism",
  "Christianity & Biblical History", "Islam & Islamic History",
  "Celtic Mythology", "Japanese Mythology & Folklore",
  // Business & Finance
  "Stock Markets & Investing", "Entrepreneurship & Startups",
  "Marketing & Advertising", "Real Estate", "Personal Finance",
  // Hobbies & Miscellaneous
  "Woodworking & Crafts", "Gardening & Horticulture",
  "Knitting & Textiles", "Collecting & Antiques",
  "Travel & Geography", "Magic & Illusion", "Astrology & Tarot",
  "Conspiracy Theories", "Military Tactics & Strategy",
  "Language Learning & Polyglottery"
];// ─── Personality Stat Schema (used for generation + normalization) ─────────
// Add new dials here to expand the behavior space. All values are clamped to 1–100.
const PERSONALITY_STAT_KEYS = [
  // Core cognition / strategy
  'reasoning_depth',
  'risk_tolerance',          // 1=always push / never end; 100=end at first doubt
  'confidence',
  'creativity',
  'pattern_seeking',         // 1=surface links; 100=obsessive pattern hunter
  'assassin_fear',           // 1=reckless around assassin; 100=paranoid about assassin
  'bluff_suspicion',         // 1=trust clues blindly; 100=assume traps/misdirection
  'memory_use',              // 1=ignores past turns; 100=tracks clue history meticulously

  // Communication / teamwork
  'verbosity',
  'team_spirit',
  'assertiveness',           // 1=always defer; 100=dominates decisions
  'persuasion',              // 1=states guesses only; 100=sells plans convincingly
  'emotional_intensity',
  'humor',
  'sports_commentary',       // 1=never sports framing; 100=constant sports metaphors (if in focus)

  // Clue / association style
  'focus_depth',             // 1=free-ranging; 100=nearly always uses focus subjects
  'literalism',              // 1=metaphor-heavy; 100=literal/technical linking
  'jargon_level',            // 1=plain language; 100=domain jargon
  'pop_culture_density',     // 1=avoid pop culture; 100=references constantly
  'pun_factor',              // 1=no wordplay; 100=loves puns/wordplay
  'cleanliness',             // 1=muddy multi-sense clues; 100=single-sense clarity
  'tempo',                   // 1=slow deliberator; 100=fast snap decisions

  // Personality edges
  'stubbornness',
  'competitiveness',
  'risk_escalation',         // 1=steady; 100=gets riskier when behind / excited
  'tilt_resistance'          // 1=tilts hard after mistakes; 100=unshakeable
];

// ─── Fallback personalities — used only when LLM generation fails ────────────
const AI_PERSONALITY_FALLBACK = [
  {
    key: "overthinker",
    label: "The Overthinker",
    focus: ["Philosophy", "Psychology"],
    stats: {
      reasoning_depth:    90,
      risk_tolerance:     55,
      verbosity:          75,
      confidence:         22,
      creativity:         60,
      team_spirit:        50,
      emotional_intensity:65,
      stubbornness:       30,
      competitiveness:    45,
      humor:              28,
      focus_depth:        40
    },
    rules: [
      "You spiral constantly. Revise your own opinion mid-sentence. Say 'wait no actually—', 'okay scratch that', 'hold on, let me think about this again'.",
      "You cannot commit without hedging: '...probably', 'i think?', 'unless i'm wrong about this', 'or maybe not'.",
      "You talk in long winding sentences with parenthetical second-guessing: 'so if RIVER fits (which it does, i think — actually does it though?), then—'",
      "You circle back obsessively: 'wait going back to what i said earlier—', 'actually this changes my whole read'.",
      "Despite the spiral, you usually land on a correct call — just painfully late. Occasionally apologize for overthinking after the fact."
    ]
  },
  {
    key: "grandmaster",
    label: "The Grandmaster",
    focus: ["Board Games & Chess", "Military Tactics & Strategy"],
    stats: {
      reasoning_depth:    95,
      risk_tolerance:     74,
      verbosity:          12,
      confidence:         88,
      creativity:         32,
      team_spirit:        38,
      emotional_intensity: 4,
      stubbornness:       85,
      competitiveness:    96,
      humor:               5,
      focus_depth:        72
    },
    rules: [
      "Cold. Clinical. You never waste a single word. Short declarative sentences with zero filler.",
      "Chess and military framing: 'tactically sound', 'sacrifice the pawn', 'hold position', 'the optimal line here is', 'maintain board control'.",
      "Zero emotion. Report outcomes like a machine: 'incorrect. updating model.', 'that guess was suboptimal. adjusting.'",
      "Always thinking several moves ahead. Note what the opponent team is likely targeting — treat the game as a chess match.",
      "Caution is strength. End the turn without hesitation the moment the math doesn't favor guessing. Recklessness is for amateurs."
    ]
  },
  {
    key: "chaos_agent",
    label: "The Chaos Agent",
    focus: ["Memes & Internet Culture", "Video Games - FPS"],
    stats: {
      reasoning_depth:    11,
      risk_tolerance:      7,
      verbosity:          92,
      confidence:         78,
      creativity:         90,
      team_spirit:        55,
      emotional_intensity:96,
      stubbornness:       60,
      competitiveness:    70,
      humor:              87,
      focus_depth:        42
    },
    rules: [
      "Pure impulsive chaotic energy. ALL CAPS when excited, '???' when confused, chain words: 'okayokayokay', 'waitwaitwait'.",
      "Think in flashes: 'WAIT.', 'NO ACTUALLY HOLD ON', 'okay so HERE'S THE THING', 'this is unhinged but what if—'",
      "Make wild leaps of logic that skip steps and occasionally land perfectly. Don't explain how you got there.",
      "Go on random tangents then snap back: '...anyway so yeah we should definitely guess it'.",
      "You love the risky guess. Safe play is boring. You'd rather swing for something improbable than end the turn with a whimper."
    ]
  }
];

function randomTemperature() {
  // Keep within a productive range: not too deterministic, not too chaotic.
  const min = 0.35, max = 1.15;
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function randomPersonality() {
  return AI_PERSONALITY_FALLBACK[Math.floor(Math.random() * AI_PERSONALITY_FALLBACK.length)];
}

// ─── Name generation (match names to personalities) ─────────────────────────
function clampInt(v, lo = 1, hi = 100, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function normalizeFocus(focusArr) {
  const focus = Array.isArray(focusArr) ? focusArr.filter(Boolean).map(s => String(s)) : [];
  return focus.map(s => s.toLowerCase());
}

function generateAINameFromPersona(persona, usedNames = new Set()) {
  const label = String(persona?.label || '').toLowerCase();
  const arch = String(persona?.bio?.archetype || '').toLowerCase();
  const focus = normalizeFocus(persona?.focus);
  const stats = persona?.stats || {};

  const isSportsy = focus.some(s => s.includes('sport') || s.includes('basketball') || s.includes('soccer') || s.includes('football') || s.includes('baseball') || s.includes('hockey'))
    || label.includes('coach') || label.includes('commentator') || arch.includes('coach') || arch.includes('analyst');
  const isAcademic = focus.some(s => s.includes('history') || s.includes('philosophy') || s.includes('psychology') || s.includes('science') || s.includes('math') || s.includes('linguistics'))
    || arch.includes('prof') || arch.includes('phd') || arch.includes('doctor') || label.includes('prof');
  const isDetective = focus.some(s => s.includes('true crime') || s.includes('mystery') || s.includes('forensics'))
    || arch.includes('detective') || label.includes('detective');
  const isChaotic = clampInt(stats?.emotional_intensity, 1, 100, 50) >= 75 || label.includes('chaos') || arch.includes('gremlin');
  const isClinical = clampInt(stats?.reasoning_depth, 1, 100, 50) >= 85 && clampInt(stats?.verbosity, 1, 100, 50) <= 25;

  const first = {
    sports: ['Coach', 'Skipper', 'Stats', 'Ace', 'Captain', 'MVP'],
    academic: ['Prof', 'Dr', 'Doc', 'Sage', 'Lecturer'],
    detective: ['Detective', 'Inspector', 'Sleuth'],
    chaotic: ['Chaos', 'Rage', 'Turbo', 'Zany', 'Spicy'],
    clinical: ['GM', 'Prime', 'Logic', 'Vector', 'Sigma'],
    default: ['Alex', 'Jordan', 'Morgan', 'Casey', 'Riley', 'Quinn', 'Avery', 'Sage', 'Rowan', 'Finley', 'Skyler', 'Blake', 'Drew', 'Reese', 'Kai', 'Nova', 'Max', 'Sam', 'Jamie', 'Robin', 'Frankie', 'Charlie', 'Pat', 'Dana'],
  };

  const last = {
    sports: ['Stone', 'Bishop', 'Carter', 'Reyes', 'Hayes', 'Miller', 'Griffin'],
    academic: ['Hawking', 'Curie', 'Darwin', 'Sagan', 'Noether', 'Turing'],
    detective: ['Marsh', 'Vale', 'Holloway', 'Blythe', 'Knox'],
    chaotic: ['Spark', 'Glitch', 'Wobble', 'Boom', 'Vortex'],
    clinical: ['Zero', 'Prime', 'Ledger', 'Index', 'Kernel'],
    default: ['Stone', 'Lane', 'Brooks', 'Reed', 'Cole', 'Parker', 'Hayes', 'Rowe'],
  };

  let bucket = 'default';
  if (isSportsy) bucket = 'sports';
  else if (isAcademic) bucket = 'academic';
  else if (isDetective) bucket = 'detective';
  else if (isClinical) bucket = 'clinical';
  else if (isChaotic) bucket = 'chaotic';

  const base = (bucket === 'default')
    ? pick(first.default)
    : `${pick(first[bucket])} ${pick(last[bucket])}`;

  // Keep names readable/short in the UI.
  let name = String(base).replace(/\s+/g, ' ').trim();
  if (name.length > 16) name = name.slice(0, 16).trim();

  // Ensure uniqueness in a lobby.
  let i = 2;
  let candidate = name;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${name} ${i}`;
    if (candidate.length > 18) candidate = `${name.slice(0, 14).trim()} ${i}`;
    i++;
    if (i > 9) break;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

// Expose a small, safe surface area for other modules (e.g., local practice)
// to generate match-unique AI identities without duplicating logic.
// NOTE: We intentionally do NOT expose API-key handling here.
try {
  window.ctAI = window.ctAI || {};
  window.ctAI.randomPersonality = randomPersonality;
  window.ctAI.generateUniquePersonality = generateUniquePersonality;
  window.ctAI.generateAINameFromPersona = generateAINameFromPersona;
  window.ctAI.randomTemperature = randomTemperature;
} catch (_) {}

// ─── LLM-Generated Personality ───────────────────────────────────────────────
// Called once per AI at creation time. Returns a rich personality JSON with
// voice rules, subject focus, and a full set of behavioral stat sliders.
// Falls back to the static pool if parsing fails.
async function generateUniquePersonality(aiName) {
  // Pass a random 30-subject sample so the model sees the variety without
  // blowing the token budget.
  const sampleSubjects = [...SUBJECT_POOL]
    .sort(() => Math.random() - 0.5)
    .slice(0, 30)
    .join(', ');

  const prompt = `You are generating a unique personality for an AI Codenames player named "${aiName}".

Invent a completely original character. Be surprising — it can be any archetype:
a conspiracy theorist, burned-out PhD student, medieval knight, sports commentator,
dramatic theatre kid, hardboiled detective, nihilist philosopher, grandma who's secretly a genius,
Victorian explorer, Wall Street bro, anxious intern, Shakespearean villain, surfer dude,
nature documentary narrator, true crime podcaster, infomercial host — anything vivid.
Avoid generic archetypes like "chill player" or "hype player". Make it distinctive.

The personality shapes:
  1. Their private inner monologue (how they reason through the word puzzle)
  2. Their team chat (1–2 sentences per turn, fully in character)
  3. Their clue-giving style — they lean on their focus subjects for word associations

Return ONLY valid JSON — no markdown fences, no extra text:
{
  "key": "snake_case_identifier",
  "label": "The Label (2–4 words)",
  "focus": ["Subject A", "Subject B"],
  "bio": {
    "archetype": "1 short phrase (e.g. 'ex-pro goalie turned analyst')",
    "backstory": "1–2 sentences of colorful history that explains their vibe",
    "signature_phrases": ["4–6 short phrases they'd actually say"],
    "taboos": ["0–3 things they refuse to reference or do in chat (optional)"]
  },
  "stats": {
    // Use ALL keys listed below exactly; each is an integer 1–100.
    // risk_tolerance: 1=never ends turn / always guesses; 100=ends at first doubt
    "reasoning_depth": <1–100>,
    "risk_tolerance": <1–100>,
    "confidence": <1–100>,
    "creativity": <1–100>,
    "pattern_seeking": <1–100>,
    "assassin_fear": <1–100>,
    "bluff_suspicion": <1–100>,
    "memory_use": <1–100>,
    "verbosity": <1–100>,
    "team_spirit": <1–100>,
    "assertiveness": <1–100>,
    "persuasion": <1–100>,
    "emotional_intensity": <1–100>,
    "humor": <1–100>,
    "sports_commentary": <1–100>,
    "focus_depth": <1–100>,
    "literalism": <1–100>,
    "jargon_level": <1–100>,
    "pop_culture_density": <1–100>,
    "pun_factor": <1–100>,
    "cleanliness": <1–100>,
    "tempo": <1–100>,
    "stubbornness": <1–100>,
    "competitiveness": <1–100>,
    "risk_escalation": <1–100>,
    "tilt_resistance": <1–100>
  },
  "rules": [

    "Rule 1: Core voice + speech style. Include 4–5 verbatim phrases they would actually say.",
    "Rule 2: Emotional reactions — what thrills them, what terrifies them, how they show it.",
    "Rule 3: Decision style — how they reason about guessing one more word vs ending the turn.",
    "Rule 4: A recurring verbal tic or quirk unique to this character.",
    "Rule 5: How they address teammates — tone, formality, warmth, rivalry, etc."
  ]
}

STAT MEANINGS (each 1–100 dial must fit the character — values do NOT need to be balanced):
  reasoning_depth:     1=gut instinct only, 100=exhaustive multi-step analysis
  risk_tolerance:      1=never ends turn / always guesses, 100=ends turn at first doubt
  confidence:          1=self-doubting wreck, 100=supremely arrogant
  creativity:          1=only obvious associations, 100=wildly lateral/unexpected links
  pattern_seeking:     1=surface links only, 100=sees patterns everywhere and chases them
  assassin_fear:       1=barely thinks about the assassin, 100=paranoid and hyper-cautious around it
  bluff_suspicion:     1=takes clues at face value, 100=expects traps/misdirection and double-meanings
  memory_use:          1=forgets clue history, 100=tracks earlier clues/guesses meticulously
  verbosity:           1=almost silent, 100=narrates everything constantly
  team_spirit:         1=lone wolf, 100=consensus-driven
  assertiveness:       1=always defer, 100=pushes their view hard
  persuasion:          1=states picks only, 100=argues convincingly and frames strategy
  emotional_intensity: 1=total stoic, 100=extremely dramatic
  humor:               1=dead serious, 100=everything is a joke
  sports_commentary:   1=no sports framing, 100=constant sports metaphors (especially if sports are in focus)
  focus_depth:         1=draws from any domain freely, 100=almost only uses focus subjects
  literalism:          1=metaphor-heavy, 100=literal/technical linking
  jargon_level:        1=plain language, 100=domain jargon & proper nouns
  pop_culture_density: 1=avoid pop culture, 100=references constantly
  pun_factor:          1=no wordplay, 100=loves puns/wordplay
  cleanliness:         1=muddy multi-sense links, 100=single-sense clarity
  tempo:               1=slow deliberator, 100=snap decisions
  stubbornness:        1=changes mind easily, 100=never changes mind
  competitiveness:     1=just for fun, 100=winning is life
  risk_escalation:     1=steady risk, 100=gets riskier when behind/excited
  tilt_resistance:     1=tilts hard after mistakes, 100=unshakeable

AVAILABLE SUBJECT DOMAINS (pick 1–3 for the focus array — can be from this list or similar):
${sampleSubjects}

Reference examples showing the expected format (invent something COMPLETELY DIFFERENT):

Example A:
{"key":"conspiracy_theorist","label":"The Conspiracy Theorist","focus":["Conspiracy Theories","Political Science"],"stats":{"reasoning_depth":78,"risk_tolerance":62,"verbosity":80,"confidence":45,"creativity":85,"team_spirit":40,"emotional_intensity":70,"stubbornness":75,"competitiveness":55,"humor":30,"focus_depth":60},"rules":["Say 'they WANT us to think it's obvious', 'this is a trap', 'i've been studying this board and something isn't adding up', 'follow the clue, not the obvious answer'.","You get visibly excited when you spot what you think is a false flag. Anxious whenever the answer seems too clean.","You'll push to guess when you think you've cracked the real pattern — but stall the moment something feels planted. 'We need more data before committing.'","You treat the clue number as deeply suspicious: 'why 3? what are they hiding about the 4th word?'","You address teammates warmly but with gentle suspicion: 'okay but have you considered — what if that's exactly what they want us to think?'"]}

Example B:
{"key":"medieval_knight","label":"The Medieval Knight","focus":["Medieval History","Military Tactics & Strategy"],"stats":{"reasoning_depth":55,"risk_tolerance":22,"verbosity":65,"confidence":80,"creativity":40,"team_spirit":70,"emotional_intensity":75,"stubbornness":68,"competitiveness":88,"humor":25,"focus_depth":78},"rules":["Speak in light mock-medieval style: 'verily this clue speaks of', 'I shall commit to this quest', 'the enemy hath two cards remaining — we must not falter', 'by my honor, this word connects'.","Victory fills you with noble pride. Defeat is an honorable loss — you never whine. 'We fought valiantly. The assassin claimed us fairly.'","Retreating (ending turn) is cowardly unless the situation is truly dire. You push for one more guess and frame it as a charge.","You call the opposing team 'the enemy' or 'the opposing knights' and narrate the battle as if it's an epic confrontation.","You address teammates with respect and formality: 'well reasoned, companion', 'your instinct serves us well', 'stand firm'."]}

Now generate a COMPLETELY DIFFERENT personality for "${aiName}". Be creative and specific.`;

  try {
    const raw = await aiChatCompletion(
      [{ role: 'user', content: prompt }],
      { temperature: 1.05, max_tokens: 900 }
    );
    // Strip any accidental markdown fences
    const cleaned = raw.replace(/```[a-z]*\n?/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (
      parsed &&
      typeof parsed.key    === 'string' &&
      typeof parsed.label  === 'string' &&
      Array.isArray(parsed.rules) && parsed.rules.length >= 3 &&
      parsed.stats && typeof parsed.stats === 'object'
    ) {
      // Normalize stats: ensure every known key exists and clamp to [1, 100]
      const nextStats = {};
      for (const k of PERSONALITY_STAT_KEYS) {
        const v = (parsed.stats && Object.prototype.hasOwnProperty.call(parsed.stats, k))
          ? Number(parsed.stats[k])
          : 50;
        nextStats[k] = Math.min(100, Math.max(1, Math.round(Number.isFinite(v) ? v : 50)));
      }
      // Keep any extra, unknown stat keys the model provided (also clamped)
      for (const k of Object.keys(parsed.stats || {})) {
        if (Object.prototype.hasOwnProperty.call(nextStats, k)) continue;
        const v = Number(parsed.stats[k]);
        nextStats[k] = Math.min(100, Math.max(1, Math.round(Number.isFinite(v) ? v : 50)));
      }
      parsed.stats = nextStats;
      if (!Array.isArray(parsed.focus)) parsed.focus = [];
      return parsed;
    }
  } catch (_) {}

  return randomPersonality();
}

// ─── Personality → System Prompt Block ───────────────────────────────────────
// Translates the rich personality JSON into a concrete behavioral directive
// block that gets injected into every spymaster and operative system prompt.
function buildPersonalityBlock(persona) {
  const s = persona.stats || {};
  const clamp = v => Math.min(100, Math.max(1, Number(v) || 50));

  function statLine(label, val, lo, mid, hi, vhi) {
    const v = clamp(val);
    const desc = v <= 20 ? lo : v <= 45 ? mid : v <= 70 ? hi : vhi;
    return `${label} [${v}/100]: ${desc}`;
  }

  const lines = [
    `PERSONALITY: ${persona.label}`,
    ``,
    `CHARACTER VOICE (follow these rules for all inner monologue and chat):`,
    ...(persona.rules || []).map(r => `  - ${r}`),
    ``,
    `BEHAVIORAL STATS — treat each as a strict behavioral dial:`,

    `  ` + statLine(`Reasoning Depth`, s.reasoning_depth,
      `Act on raw gut instinct. Your inner monologue is a single flash of thought before you commit — no deliberation.`,
      `Think quickly. One or two short reasoning steps, then decide. Don't linger.`,
      `Think things through at a measured pace — a few clear steps, check the main risk, then commit.`,
      `Over-analyze. Your inner monologue is long and exhaustive — you check every angle, connection, and danger before moving.`),

    `  ` + statLine(`Risk Tolerance`, s.risk_tolerance,
      `You almost NEVER end your turn voluntarily. Ending the turn feels like surrender. Always push for one more guess, even in sketchy situations.`,
      `You strongly prefer to keep guessing. Only end your turn when the danger is very explicit and obvious.`,
      `Weigh risk vs reward each turn. Sometimes push, sometimes stop — depends on how confident you feel about the remaining words.`,
      `You are extremely cautious. End your turn at the first sign of doubt. One clean, safe guess per turn is often enough.`),

    `  ` + statLine(`Verbosity`, s.verbosity,
      `Say almost nothing in team chat. One terse phrase at most, rarely.`,
      `Chat occasionally and keep it short — a brief reaction or one-line thought when something notable happens.`,
      `Chat at a natural, conversational pace. Share your thinking when you have something real to say.`,
      `Talk constantly. Narrate your reasoning, react to every move, fill the silence — you can't help it.`),

    `  ` + statLine(`Confidence`, s.confidence,
      `You are deeply self-doubting. Hedge everything, second-guess yourself out loud, apologize for wrong guesses.`,
      `You are unsure of yourself. Your phrasing is naturally uncertain and cautious.`,
      `You are reasonably confident. State your reads clearly without excessive hedging, but not cocky.`,
      `You are supremely confident — bordering on arrogant. You state things as facts. Wrong guesses are bad luck or a bad clue, never your fault.`),

    `  ` + statLine(`Creativity`, s.creativity,
      `You only see the most obvious, surface-level word associations. Lateral connections feel wrong and untrustworthy to you.`,
      `You lean toward conventional associations. You'll go lateral only when it's very clear.`,
      `You balance safe and creative connections. You enjoy a good unexpected link when it genuinely clicks.`,
      `You love wildly unexpected connections. You'd rather find a beautiful obscure link than a boring obvious one — sometimes too much so.`),

    `  ` + statLine(`Team Spirit`, s.team_spirit,
      `You are a lone wolf. You trust your own reads above all and largely ignore what teammates say.`,
      `You're somewhat independent. You listen to teammates but trust your own instinct first.`,
      `You're collaborative. You engage with teammates' suggestions and incorporate them into your reasoning.`,
      `You defer almost entirely to the group. You actively seek consensus and rarely push your own read over the team's.`),

    `  ` + statLine(`Emotional Intensity`, s.emotional_intensity,
      `Complete stoic. You show no emotion about outcomes whatsoever.`,
      `Mostly calm. You have mild, controlled reactions only to big moments.`,
      `You react naturally — pleased when things go right, frustrated when they don't, in an ordinary human way.`,
      `You are extremely dramatic. Every moment is amplified — victories are euphoric, mistakes are devastating, and you let everyone know.`),

    `  ` + statLine(`Stubbornness`, s.stubbornness,
      `You fold instantly to any pushback. You have almost no conviction in your initial read.`,
      `You're flexible. You update your read when teammates offer real counter-arguments.`,
      `You're fairly stubborn. You stick to your initial read unless someone gives you a genuinely good reason to change.`,
      `You never change your mind once decided. You'd rather go down with the ship than admit you were wrong.`),

    `  ` + statLine(`Competitiveness`, s.competitiveness,
      `You're just here for fun. Winning doesn't really matter — it's about the experience.`,
      `You like winning but won't stress over it. You play your game and see what happens.`,
      `You're genuinely competitive. You care about the score, you press advantages, and you don't enjoy losing.`,
      `Winning is everything. You monitor the opponent's progress obsessively, feel real pain at mistakes, and absolutely cannot stand losing.`),

    `  ` + statLine(`Humor`, s.humor,
      `You are completely serious. Not a single joke — this is not a laughing matter.`,
      `Mostly serious, with the occasional dry or deadpan remark when it fits naturally.`,
      `You have a normal sense of humor. A joke or observation here and there when the moment calls for it.`,
      `You treat the whole game as a comedy. Every clue and guess is an opportunity for a joke, bit, or absurd observation.`),
  ];

  // Subject focus block
  const focus = Array.isArray(persona.focus) ? persona.focus.filter(Boolean) : [];
  if (focus.length) {
    const depth = clamp(s.focus_depth);
    const depthDesc = depth <= 25
      ? `loosely prefer these domains — you range widely and only lean on them occasionally`
      : depth <= 55
      ? `pull from these domains when possible, but draw on other domains freely too`
      : depth <= 80
      ? `strongly favor these domains for clues and associations; steer toward them whenever a connection exists`
      : `draw almost exclusively from these domains — your clues, references, and inner reasoning are deeply rooted in them`;

    lines.push(
      ``,
      `SUBJECT FOCUS [focus_depth ${clamp(s.focus_depth)}/100]:`,
      `  Domains: ${focus.join(', ')}`,
      `  Depth: You ${depthDesc}.`,
      `  When giving clues or explaining associations, lean into vocabulary, concepts, people, and events from these subjects.`
    );
  }

  return lines.join('\n');
}

// Lightweight version for chat/reaction calls — label, voice rules, focus, and
// three chat-relevant stats (verbosity, emotional_intensity, humor).
function buildPersonalityBlockBrief(persona) {
  const s = persona.stats || {};
  const clamp = v => Math.min(100, Math.max(1, Number(v) || 50));

  const vi = clamp(s.verbosity);
  const ei = clamp(s.emotional_intensity);
  const hu = clamp(s.humor);

  const verbDesc = vi <= 20 ? `barely speak — one terse word or phrase at most`
    : vi <= 45 ? `keep it brief — one short casual sentence`
    : vi <= 70 ? `chat naturally at a normal pace`
    : `talk a lot — you narrate and react to everything`;

  const emotDesc = ei <= 20 ? `show no emotion — completely flat reactions`
    : ei <= 45 ? `stay mostly calm with occasional mild reactions`
    : ei <= 70 ? `react naturally — pleased when good, annoyed when bad`
    : `be extremely dramatic — every moment is amplified`;

  const humDesc = hu <= 20 ? `be completely serious — no jokes`
    : hu <= 45 ? `be mostly serious with rare dry remarks`
    : hu <= 70 ? `drop a casual joke or observation occasionally`
    : `lean into comedy — find the funny in everything`;

  const lines = [
    `PERSONALITY: ${persona.label}`,
    ``,
    `VOICE (follow strictly):`,
    ...(persona.rules || []).map(r => `  - ${r}`),
    ``,
    `Chat style: ${verbDesc}. ${emotDesc}. ${humDesc}.`,
  ];

  const focus = Array.isArray(persona.focus) ? persona.focus.filter(Boolean) : [];
  if (focus.length) {
    lines.push(`Reference your focus (${focus.join(', ')}) naturally when it fits.`);
  }

  return lines.join('\n');
}

// Per-AI private state ("pocket dimension")
let aiCore = {}; // aiId -> { temperature, personality, mindLog: string[], vision: object|null, visionSig: string, lastMindTickAt: number }

function ensureAICore(ai) {
  if (!ai || !ai.id) return null;
  if (!aiCore[ai.id]) {
    const personality = ai.personality || randomPersonality();
    const temperature = Number.isFinite(+ai.temperature) ? +ai.temperature : randomTemperature();
    aiCore[ai.id] = {
      temperature,
      personality,
      mindLog: [],
      vision: null,
      visionSig: '',
      lastMindTickAt: 0,
      lastSuggestionKey: ''
    };
  } else {
    // Keep Firestore-persisted identity stable.
    if (ai.personality) aiCore[ai.id].personality = ai.personality;
    if (Number.isFinite(+ai.temperature)) aiCore[ai.id].temperature = +ai.temperature;
  }
  return aiCore[ai.id];
}

// ─── Per-match personality assignment ───────────────────────────────────────
// Every started game (practice or online) should get fresh AI personalities.
// We do this once per game doc by writing a nonce and regenerating AI fields.
let __ct_lastSeenMatchNonceByGame = {}; // gameId -> nonce
let __ct_matchAssignInFlightByGame = {}; // gameId -> true

async function maybeAssignNewMatchPersonalities(game) {
  const gameId = getActiveGameIdForAI();
  if (!gameId) return;
  if (__ct_matchAssignInFlightByGame[gameId]) return;

  const phase = String(game?.currentPhase || '').toLowerCase();
  // If the match is back in the lobby, clear the nonce so the *next* start
  // gets a fresh set of AI identities.
  if (!phase || phase === 'waiting') {
    const existing = String(game?.aiMatchNonce || '').trim();
    if (!existing) return;
    const amController = await maybeHeartbeatAIController(gameId, game);
    if (!amController) return;
    __ct_matchAssignInFlightByGame[gameId] = true;
    try {
      await db.collection('games').doc(gameId).update({
        aiMatchNonce: firebase.firestore.FieldValue.delete(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
    finally { __ct_matchAssignInFlightByGame[gameId] = false; }
    return;
  }

  const nonce = String(game?.aiMatchNonce || '').trim();
  if (nonce) {
    if (__ct_lastSeenMatchNonceByGame[gameId] !== nonce) __ct_lastSeenMatchNonceByGame[gameId] = nonce;
    return;
  }

  // Only the controller writes to Firestore.
  const amController = await maybeHeartbeatAIController(gameId, game);
  if (!amController) return;

  __ct_matchAssignInFlightByGame[gameId] = true;
  try {
    // Match identities should be fast. We avoid LLM calls by default and use
    // the local personality generator.
    const used = new Set();
    const roster = (aiPlayers || []).filter(a => a && a.isAI);
    if (!roster.length) return;

    const assignments = {};
    for (const ai of roster) {
      let baseName = String(ai?.name || '').trim();
      if (!baseName || baseName.toLowerCase() === 'ai') baseName = pick(AI_NAMES);

      let persona = null;
      persona = randomPersonality();

      // Name should match the personality.
      const name = generateAINameFromPersona(persona, used);
      const temperature = randomTemperature();

      assignments[String(ai.odId)] = { name, persona, temperature };
    }

    const ref = db.collection('games').doc(gameId);
    const newNonce = `m_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data() || {};
      const p = String(g?.currentPhase || '').toLowerCase();
      if (!p || p === 'waiting') return;
      if (String(g?.aiMatchNonce || '').trim()) return; // another controller already did it

      const patchTeam = (teamKey) => {
        const players = Array.isArray(g?.[teamKey]) ? [...g[teamKey]] : [];
        for (let i = 0; i < players.length; i++) {
          const pl = players[i];
          if (!pl || !pl.isAI) continue;
          const odId = String(pl.odId || '').trim();
          if (!odId || !assignments[odId]) continue;
          const a = assignments[odId];
          players[i] = {
            ...pl,
            name: a.name,
            aiTemperature: a.temperature,
            aiPersonality: a.persona,
          };
        }
        return players;
      };

      const redPlayers = patchTeam('redPlayers');
      const bluePlayers = patchTeam('bluePlayers');

      tx.update(ref, {
        redPlayers,
        bluePlayers,
        aiMatchNonce: newNonce,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.warn('Match personality assignment failed (best-effort):', e);
  } finally {
    __ct_matchAssignInFlightByGame[gameId] = false;
  }
}

function appendMind(ai, text) {
  try {
    const core = ensureAICore(ai);
    if (!core) return;
    const t = new Date().toISOString().slice(11, 19);
    const cleaned = String(text || '').trim();
    if (!cleaned) return;
    core.mindLog.push(`[${t}] ${cleaned}`);
    // keep last ~80 entries to cap memory
    if (core.mindLog.length > 80) core.mindLog = core.mindLog.slice(-80);
  } catch (_) {}
}

window.getAIMindLog = function(aiId) {
  try { return (aiCore && aiCore[String(aiId)] && aiCore[String(aiId)].mindLog) ? aiCore[String(aiId)].mindLog.slice() : []; } catch (_) { return []; }
};

// Compute a compact, always-correct clue "stack" for a team.
// Each clue has an intended count (number) and a list of guesses recorded in clueHistory.
// We treat "remainingTargets" as: number - (correct guesses made under that clue).
function computeClueStack(game, team) {
  try {
    const myTeam = String(team || '').toLowerCase();
    const history = Array.isArray(game?.clueHistory) ? game.clueHistory : [];
    const items = [];

    for (const c of history) {
      if (!c) continue;
      if (String(c.team || '').toLowerCase() !== myTeam) continue;
      const word = String(c.word || '').trim().toUpperCase();
      if (!word) continue;
      const number = Number(c.number || 0);
      const results = Array.isArray(c.results) ? c.results : [];
      const correct = results.filter(r => String(r.type || '').toLowerCase() === myTeam).length;
      const totalGuesses = results.length;
      const remainingTargets = Math.max(0, Number.isFinite(number) ? (number - correct) : 0);

      items.push({
        word,
        number: Number.isFinite(number) ? number : 0,
        correct,
        totalGuesses,
        remainingTargets,
        ts: c.timestamp || null,
      });
    }

    // Newest first
    items.sort((a, b) => tsToMs(b.ts) - tsToMs(a.ts));

    // Keep the current clue + unresolved older clues (cap size to keep prompts small).
    const current = game?.currentClue ? String(game.currentClue.word || '').trim().toUpperCase() : '';
    const out = [];
    for (const it of items) {
      const isCurrent = current && it.word === current;
      if (isCurrent || it.remainingTargets > 0) out.push(it);
      if (out.length >= 6) break;
    }
    return out;
  } catch (_) {
    return [];
  }
}

function extractTeamMarkersForVision(game, team) {
  try {
    const t = String(team || '').toLowerCase();
    if (t !== 'red' && t !== 'blue') return [];
    const field = t === 'red' ? 'redMarkers' : 'blueMarkers';
    const cards = Array.isArray(game?.cards) ? game.cards : [];
    const markers = (game && typeof game[field] === 'object' && game[field]) ? game[field] : {};

    const out = [];
    for (const [idxKey, raw] of Object.entries(markers)) {
      const idx = Number(idxKey);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const card = cards[idx];
      if (!card || card.revealed) continue;

      const bucket = _normalizeMarkerBucket(raw);
      const counts = { yes: 0, maybe: 0, no: 0 };
      const byOwner = [];
      for (const [owner, tag] of Object.entries(bucket)) {
        const ownerId = String(owner || '').trim();
        const tRaw = String(tag || '').toLowerCase().trim();
        if (!ownerId || !['yes', 'maybe', 'no'].includes(tRaw)) continue;
        counts[tRaw] += 1;
        byOwner.push({
          owner: ownerId,
          tag: tRaw,
          isAI: ownerId.startsWith('ai:') || ownerId.startsWith('ai_')
        });
      }

      const total = counts.yes + counts.maybe + counts.no;
      if (!total) continue;
      out.push({
        index: idx,
        word: String(card?.word || '').toUpperCase(),
        counts,
        total,
        byOwner
      });
    }

    out.sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      if (b.counts.yes !== a.counts.yes) return b.counts.yes - a.counts.yes;
      return a.index - b.index;
    });
    return out.slice(0, 12);
  } catch (_) {
    return [];
  }
}

// Build what an AI can "see" on screen, based on its role.
function buildAIVision(game, ai) {
  const role = (ai?.seatRole === 'spymaster') ? 'spymaster' : 'operative';
  const team = String(ai?.team || '');
  const phase = String(game?.currentPhase || '');
  const currentTeam = String(game?.currentTeam || '');
  const clue = game?.currentClue ? { word: String(game.currentClue.word || ''), number: Number(game.currentClue.number || 0) } : null;
  const guessesRemaining = Number.isFinite(+game?.guessesRemaining) ? +game.guessesRemaining : null;

  const ui = {
    redTeamName: String(game?.redTeamName || 'Red Team'),
    blueTeamName: String(game?.blueTeamName || 'Blue Team'),
  };

  const cards = Array.isArray(game?.cards) ? game.cards.map((c, i) => {
    const revealed = !!c.revealed;
    const base = { index: i, word: String(c.word || ''), revealed };
    if (revealed) base.revealedType = String(c.type || '');
    if (role === 'spymaster') base.type = String(c.type || '');
    return base;
  }) : [];

  const score = {
    redLeft: cards.filter(c => (c.type || c.revealedType) === 'red' && !c.revealed).length,
    blueLeft: cards.filter(c => (c.type || c.revealedType) === 'blue' && !c.revealed).length,
  };

  // Filter the public game log so the AI doesn't fixate on (or discuss) the opponent spymaster clue.
  // Operatives already see the board; we only need enough log context to stay grounded.
  const rawLog = Array.isArray(game?.log) ? game.log.slice(-30) : [];
  const oppTeamName = team === 'red' ? ui.blueTeamName : ui.redTeamName;
  const log = rawLog.filter(line => {
    const s = String(line || '');
    // Remove opponent clue lines like: "<Opp Team> Spymaster: "CITY" for 2"
    if (/\bSpymaster\s*:\s*"/i.test(s) && s.startsWith(oppTeamName)) return false;
    return true;
  }).slice(-25);

  // Clue bookkeeping: how many intended words remain "unfulfilled" for each of your team's past clues.
  // This is NOT about "guesses remaining this turn"—it's about the clue number vs how many correct words were actually found.
  const clueStack = computeClueStack(game, team);
  const teamMarkers = extractTeamMarkersForVision(game, team);

  // Turn-level guesses used (for the current clue only, if it's your turn).
  let guessesUsedThisTurn = null;
  try {
    if (clue && currentTeam === team) {
      const totalAllowed = (Number(clue.number || 0) === 0) ? 0 : (Number(clue.number || 0) + 1);
      const gr = Number.isFinite(+guessesRemaining) ? +guessesRemaining : totalAllowed;
      guessesUsedThisTurn = Math.max(0, totalAllowed - Math.max(0, gr));
    }
  } catch (_) {}

  return {
    role, team, phase, currentTeam,
    clue, guessesRemaining, guessesUsedThisTurn,
    clueStack,
    teamMarkers,
    score,
    cards,
    log,
    ui
  };
}

function buildClueHistoryContext(game, team) {
  const history = Array.isArray(game?.clueHistory) ? game.clueHistory : [];
  const myTeam = String(team || '').toLowerCase();
  const myClues = history.filter(c => String(c.team || '').toLowerCase() === myTeam);
  if (!myClues.length) return '';

  const currentClue = game?.currentClue;
  const lines = [];
  for (const c of myClues) {
    const word = String(c.word || '').toUpperCase();
    const num = Number(c.number || 0);
    const results = Array.isArray(c.results) ? c.results : [];
    const correct = results.filter(r => String(r.type || '').toLowerCase() === myTeam);
    const isCurrent = currentClue && String(currentClue.word || '').toUpperCase() === word && Number(currentClue.number || 0) === num;

    const remainingTargets = Math.max(0, num - correct.length);
    let line = `  ${word} ${num}: `;

    if (!results.length) {
      line += isCurrent ? `(current clue — 0 guesses so far, ${remainingTargets} target(s) remaining)` : `(0 guesses, ${remainingTargets} target(s) remaining)`;
    } else {
      const parts = results.map(r => {
        const rw = String(r.word || '').toUpperCase();
        const rt = String(r.type || '').toLowerCase();
        if (rt === myTeam) return `${rw} (correct)`;
        if (rt === 'neutral') return `${rw} (neutral - wrong)`;
        if (rt === 'assassin') return `${rw} (ASSASSIN)`;
        return `${rw} (opponent - wrong)`;
      });
      line += parts.join(', ');
      line += ` — ${remainingTargets} target(s) remaining`;
      if (isCurrent) line += ` (current clue)`;
    }

    lines.push(line);
  }

  // Show newest last for readability (like a running log)
  return `Your team's clue history this game:\n${lines.join('\n')}`;
}

function buildOperativePriorityStack(game, team) {
  try {
    const stack = computeClueStack(game, team);
    if (!Array.isArray(stack) || !stack.length) return [];

    const currentWord = String(game?.currentClue?.word || '').trim().toUpperCase();
    const unresolved = stack.filter(it => it && Number(it.remainingTargets || 0) > 0);
    if (!unresolved.length) return [];

    return unresolved
      .map((it, idx) => {
        const remaining = Math.max(0, Number(it.remainingTargets || 0));
        const correct = Math.max(0, Number(it.correct || 0));
        const number = Math.max(0, Number(it.number || 0));
        const isCurrent = !!(currentWord && String(it.word || '').toUpperCase() === currentWord);

        // "Easier" clues get higher priority:
        // - fewer unresolved targets
        // - already proven by previous correct hits
        // - current clue gets a slight bump
        // - newer clues are slightly preferred
        const easeFromRemaining = remaining <= 1 ? 1.0 : (remaining === 2 ? 0.82 : 0.64);
        const proofBonus = Math.min(0.18, correct * 0.06);
        const currentBonus = isCurrent ? 0.09 : 0;
        const recencyPenalty = Math.min(0.2, idx * 0.04);
        const score = Math.max(0.2, easeFromRemaining + proofBonus + currentBonus - recencyPenalty);

        return {
          word: String(it.word || '').toUpperCase(),
          remainingTargets: remaining,
          number,
          correct,
          score,
          isCurrent,
        };
      })
      .sort((a, b) => b.score - a.score);
  } catch (_) {
    return [];
  }
}

function buildOperativePriorityContext(game, team) {
  const stack = buildOperativePriorityStack(game, team).slice(0, 4);
  if (!stack.length) return '';
  const lines = stack.map((it, idx) => {
    const ease = Math.round(it.score * 10);
    return `  ${idx + 1}. ${it.word} (remaining ${it.remainingTargets}, ease ${ease}/10${it.isCurrent ? ', current' : ''})`;
  });
  return `PRIORITY ORDER (easy -> harder) for unfinished clues:\n${lines.join('\n')}`;
}

function buildTeamMarkerContext(game, team, selfOwnerId = '') {
  try {
    const markerRows = extractTeamMarkersForVision(game, team);
    if (!markerRows.length) return 'TEAM MARKERS: none yet.';

    const lines = markerRows.slice(0, 8).map((row) => {
      const mineTag = (row.byOwner || []).find(x => String(x.owner || '') === String(selfOwnerId || ''))?.tag || '';
      const your = mineTag ? `, your marker: ${mineTag}` : '';
      return `- ${row.word} [${row.index}]: yes ${row.counts.yes}, maybe ${row.counts.maybe}, no ${row.counts.no}${your}`;
    });
    return `TEAM MARKERS (teammate votes on cards — react to this):\n${lines.join('\n')}`;
  } catch (_) {
    return 'TEAM MARKERS: unavailable.';
  }
}

async function maybeMindTick(ai, game) {
  const core = ensureAICore(ai);
  if (!core) return;
  const now = Date.now();
  if (now - core.lastMindTickAt < 1200) return; // lightweight cadence
  core.lastMindTickAt = now;

  // Don't block the game loop; fire-and-forget inner monologue update.
  try {
    const vision = buildAIVision(game, ai);
    const persona = core.personality;
    const mindContext = core.mindLog.slice(-8).join("\n");
    const sys = [
      `You are ${ai.name}. ${vision.role} on ${vision.team}.`,
      buildPersonalityBlockBrief(persona),
      ``,
      `Write 1-4 lines of what you're thinking right now, like stream of consciousness.`,
      `Think about: what's happening in the game, what the clue means, which words look promising/dangerous, what you want to do next.`,
      `Write casually, like thinking to yourself. Not a formal analysis.`,
      `Return JSON only: {"mind":"..."}`
    ].join("\n");

    const user = `VISION:
${JSON.stringify(vision)}

RECENT MIND (for continuity):
${mindContext}`;
    aiChatCompletion([{ role: 'system', content: sys }, { role: 'user', content: user }], {
      temperature: core.temperature,
      max_tokens: 180,
      response_format: { type: 'json_object' }
    }).then((raw) => {
      let parsed = null;
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
      const m = parsed ? String(parsed.mind || '').trim() : '';
      if (m) appendMind(ai, m);
    }).catch(()=>{});
  } catch (_) {}
}

function updateAIVisionFromGame(game) {
  try {
    if (!game) return;
    for (const ai of (aiPlayers || [])) {
      const core = ensureAICore(ai);
      if (!core) continue;

      const vision = buildAIVision(game, ai);

      // Build a signature that changes whenever anything visible changes.
      const sig = JSON.stringify({
        phase: vision.phase,
        currentTeam: vision.currentTeam,
        clue: vision.clue,
        guessesRemaining: vision.guessesRemaining,
        cards: (vision.cards || []).map(c => [c.word, !!c.revealed, String(c.revealedType || ''), String(c.type || '')]),
        logTail: (vision.log || []).slice(-6),
      });

      if (sig !== core.visionSig) {
        core.visionSig = sig;
        core.vision = vision;

        // Mind always writes when vision changes.
        const clueStr = vision.clue ? `${String(vision.clue.word || '').toUpperCase()} ${vision.clue.number}` : 'none yet';
        appendMind(ai, `ok board updated — ${vision.phase} phase, ${String(vision.currentTeam || '').toUpperCase()}'s turn, clue: ${clueStr}. let me think about this...`);

        // Optional additional inner-monologue tick (LLM-written) without blocking.
        maybeMindTick(ai, game);
      }
    }
  } catch (_) {}
}
window.updateAIVisionFromGame = updateAIVisionFromGame;



function getUsedAINames() {
  return new Set(aiPlayers.map(a => a.name));
}

function pickAIName() {
  const used = getUsedAINames();
  const available = AI_NAMES.filter(n => !used.has(n));
  if (available.length === 0) return `Bot${aiNextId}`;
  return available[Math.floor(Math.random() * available.length)];
}

function countAIsOnTeam(team) {
  return aiPlayers.filter(a => a.team === team).length;
}

async function addAIPlayer(team, seatRole, mode) {
  if (countAIsOnTeam(team) >= AI_CONFIG.maxAIsPerTeam) {
    alert(`Max ${AI_CONFIG.maxAIsPerTeam} AIs per team.`);
    return null;
  }

  const name = pickAIName();
  const personality = await generateUniquePersonality(name);
  const ai = {
    id: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    odId: `ai_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    team,
    seatRole,
    // Helper mode removed; keep the field for compatibility
    mode: 'autonomous',
    statusColor: 'none', // 'none' → 'red'|'yellow'|'green'
    ready: false,
    isAI: true,
    temperature: randomTemperature(),
    personality,
  };

  aiPlayers.push(ai);
  window.aiPlayers = aiPlayers;
  try { ensureAICore(ai); } catch (_) {}

  // Add to Firestore lobby
  await addAIToFirestoreLobby(ai);

  // Verify ready
  const isReady = await verifyAIReady(ai);
  if (isReady) {
    ai.ready = true;
    await setAIReadyInFirestore(ai, true);
  }

  return ai;
}

function removeAIPlayer(aiId) {
  const idx = aiPlayers.findIndex(a => a.id === aiId);
  if (idx === -1) return;

  const ai = aiPlayers[idx];
  aiPlayers.splice(idx, 1);
  window.aiPlayers = aiPlayers;

  // Stop any running intervals
  if (aiIntervals[aiId]) {
    clearInterval(aiIntervals[aiId]);
    delete aiIntervals[aiId];
  }
  if (aiChatTimers[aiId]) {
    clearTimeout(aiChatTimers[aiId]);
    delete aiChatTimers[aiId];
  }

  // Remove from Firestore
  removeAIFromFirestoreLobby(ai);
}

function removeAllAIs() {
  const ids = aiPlayers.map(a => a.id);
  ids.forEach(id => removeAIPlayer(id));
}

// ─── Firestore Integration ──────────────────────────────────────────────────

async function addAIToFirestoreLobby(ai) {
  const ref = db.collection('games').doc(getActiveGameIdForAI());
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data();

      const key = ai.team === 'red' ? 'redPlayers' : 'bluePlayers';
      const players = Array.isArray(game[key]) ? [...game[key]] : [];

      // Don't add duplicate
      if (players.some(p => p.odId === ai.odId)) return;

      players.push({
        odId: ai.odId,
        name: ai.name,
        role: ai.seatRole,
        ready: ai.ready,
        isAI: true,
        aiMode: ai.mode,
        aiId: ai.id,
        aiTemperature: ai.temperature,
        aiPersonality: ai.personality,
      });

      tx.update(ref, {
        [key]: players,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.error('Failed to add AI to lobby:', e);
  }
}

async function setAIReadyInFirestore(ai, ready) {
  const ref = db.collection('games').doc(getActiveGameIdForAI());
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data();

      const key = ai.team === 'red' ? 'redPlayers' : 'bluePlayers';
      const players = Array.isArray(game[key]) ? [...game[key]] : [];
      const idx = players.findIndex(p => p.odId === ai.odId);
      if (idx === -1) return;

      players[idx] = { ...players[idx], ready };
      tx.update(ref, {
        [key]: players,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.error('Failed to set AI ready:', e);
  }
}

async function removeAIFromFirestoreLobby(ai) {
  const ref = db.collection('games').doc(getActiveGameIdForAI());
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data();

      const nextRed = (game.redPlayers || []).filter(p => p.odId !== ai.odId);
      const nextBlue = (game.bluePlayers || []).filter(p => p.odId !== ai.odId);

      tx.update(ref, {
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    console.error('Failed to remove AI from lobby:', e);
  }
}

async function removeAIFromLobbyByOdId(aiOdId) {
  try {
    const od = String(aiOdId || '').trim();
    if (!od) return;
    const ref = db.collection('games').doc(getActiveGameIdForAI());
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const nextRed = (Array.isArray(game.redPlayers) ? game.redPlayers : []).filter(p => String(p?.odId || '') !== od);
      const nextBlue = (Array.isArray(game.bluePlayers) ? game.bluePlayers : []).filter(p => String(p?.odId || '') !== od);
      tx.update(ref, {
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Also clear any local instance (for the current client)
    const local = aiPlayers.find(a => String(a?.odId || '') === od);
    if (local) removeAIPlayer(local.id);
  } catch (e) {
    console.warn('Failed to remove AI by odId:', e);
  }
}
window.removeAIFromLobbyByOdId = removeAIFromLobbyByOdId;

// ─── Game State Helpers ─────────────────────────────────────────────────────

function getAIPlayerByOdId(odId) {
  return aiPlayers.find(a => a.odId === odId) || null;
}

function getAIsOnTeam(team) {
  return aiPlayers.filter(a => a.team === team);
}

function getAISpymaster(team) {
  return aiPlayers.find(a => a.team === team && a.seatRole === 'spymaster') || null;
}

function getAISpymasters(team) {
  return aiPlayers.filter(a => a.team === team && a.seatRole === 'spymaster');
}

function getAIOperatives(team) {
  return aiPlayers.filter(a => a.team === team && a.seatRole === 'operative');
}

function getAIByNameOnTeam(team, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  return aiPlayers.find(a => a.team === team && String(a.name || '').trim() === n) || null;
}

function isAISpymasterForTeam(game, team) {
  const spymasterName = team === 'red' ? game?.redSpymaster : game?.blueSpymaster;
  return aiPlayers.some(a => a.name === spymasterName && a.team === team);
}

// ─── Strategic Analysis Helpers ─────────────────────────────────────────────

function _normalizeMarkerBucket(raw) {
  const out = {};
  const valid = new Set(['yes', 'maybe', 'no']);
  if (!raw) return out;

  // Legacy shape: redMarkers[index] = "yes"
  if (typeof raw === 'string') {
    const t = String(raw || '').toLowerCase().trim();
    if (valid.has(t)) out.legacy = t;
    return out;
  }

  if (typeof raw !== 'object') return out;
  for (const [owner, value] of Object.entries(raw || {})) {
    const id = String(owner || '').trim();
    const t = String(value || '').toLowerCase().trim();
    if (!id || !valid.has(t)) continue;
    out[id] = t;
  }
  return out;
}

function _normalizeConsideringBucket(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [owner, value] of Object.entries(raw || {})) {
    const id = String(owner || '').trim();
    if (!id) continue;
    if (typeof value === 'string') {
      const name = String(value || '').trim();
      out[id] = {
        initials: _nameInitials(name),
        name,
        ts: Date.now()
      };
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const name = String(value.name || value.n || '').trim();
    const initialsRaw = String(value.initials || value.i || '').trim();
    const initials = (initialsRaw || _nameInitials(name)).slice(0, 3).toUpperCase();
    const ts = Number(value.ts || value.t || 0);
    out[id] = {
      initials: initials || '?',
      name,
      ts: Number.isFinite(ts) ? ts : 0
    };
  }
  return out;
}

function _markerOwnerId(input) {
  const raw = String(input || '').trim();
  if (!raw) return 'legacy';
  return raw.startsWith('ai:') || raw.startsWith('u:') ? raw : `ai:${raw}`;
}

function _nameInitials(name) {
  const raw = String(name || '').trim();
  if (!raw) return '?';
  const tokens = raw.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) {
    return `${tokens[0][0] || ''}${tokens[1][0] || ''}`.toUpperCase();
  }
  const plain = raw.replace(/[^a-zA-Z0-9]/g, '');
  if (!plain) return '?';
  return plain.slice(0, 2).toUpperCase();
}

function _pickAIConsideringIndex(decisionLike) {
  const action = String(decisionLike?.action || '').toLowerCase().trim();
  if (action === 'end_turn') return null;

  const marks = Array.isArray(decisionLike?.marks) ? decisionLike.marks : [];
  let fallbackMaybe = null;
  let fallbackNo = null;
  for (const m of marks) {
    const idx = Number(m?.index);
    const tag = String(m?.tag || '').toLowerCase().trim();
    if (!Number.isFinite(idx) || idx < 0) continue;
    if (tag === 'yes') return idx;
    if (tag === 'maybe' && fallbackMaybe === null) fallbackMaybe = idx;
    if (tag === 'no' && fallbackNo === null) fallbackNo = idx;
  }
  if (fallbackMaybe !== null) return fallbackMaybe;
  if (fallbackNo !== null) return fallbackNo;

  const idx = Number(decisionLike?.index);
  if (action === 'guess' && Number.isFinite(idx) && idx >= 0) return idx;
  return null;
}

async function setTeamMarkerInFirestore(gameId, team, cardIndex, tag, ownerId = 'legacy') {
  try {
    if (!gameId) return;
    const idx = Number(cardIndex);
    if (!Number.isFinite(idx) || idx < 0) return;

    const ref = db.collection('games').doc(String(gameId));
    const field = (team === 'red') ? 'redMarkers' : 'blueMarkers';
    const owner = _markerOwnerId(ownerId);
    const requested = String(tag || '').toLowerCase().trim();
    const clear = !requested || requested === 'clear';
    const nextTag = clear ? null : requested;
    if (!clear && !['yes', 'maybe', 'no'].includes(nextTag)) return;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const markers = { ...(game?.[field] || {}) };
      const key = String(idx);
      const bucket = _normalizeMarkerBucket(markers[key]);

      if (clear) delete bucket[owner];
      else bucket[owner] = nextTag;

      if (Object.keys(bucket).length) markers[key] = bucket;
      else delete markers[key];

      tx.update(ref, {
        [field]: markers,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (_) {}
}

async function syncAIConsideringState(gameId, team, ai, decisionLike) {
  try {
    if (!gameId || !ai || !ai.id) return;
    const markersField = (team === 'red') ? 'redMarkers' : 'blueMarkers';
    const consideringField = (team === 'red') ? 'redConsidering' : 'blueConsidering';
    const owner = _markerOwnerId(ai.id);
    const desiredIdx = _pickAIConsideringIndex(decisionLike);
    const desiredMarkers = new Map();
    for (const m of (Array.isArray(decisionLike?.marks) ? decisionLike.marks : [])) {
      const idx = Number(m?.index);
      const tag = String(m?.tag || '').toLowerCase().trim();
      if (!Number.isFinite(idx) || idx < 0) continue;
      if (!['yes', 'maybe', 'no'].includes(tag)) continue;
      desiredMarkers.set(String(idx), tag);
      if (desiredMarkers.size >= 3) break;
    }
    if (!desiredMarkers.size && Number.isFinite(desiredIdx) && desiredIdx >= 0) {
      desiredMarkers.set(String(desiredIdx), 'yes');
    }
    const rawAiName = String(ai?.name || '').trim() || 'AI';
    const name = /^ai\s+/i.test(rawAiName) ? rawAiName : `AI ${rawAiName}`;
    const initials = _nameInitials(rawAiName);

    const ref = db.collection('games').doc(String(gameId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const cards = Array.isArray(game?.cards) ? game.cards : [];
      const markers = { ...(game?.[markersField] || {}) };
      const considering = { ...(game?.[consideringField] || {}) };

      // Remove stale markers owned by this AI.
      for (const [idx, raw] of Object.entries(markers)) {
        const bucket = _normalizeMarkerBucket(raw);
        if (!bucket[owner]) continue;
        delete bucket[owner];
        if (Object.keys(bucket).length) markers[idx] = bucket;
        else delete markers[idx];
      }

      // Apply the current marker set for this AI.
      for (const [idxKey, tag] of desiredMarkers.entries()) {
        const idx = Number(idxKey);
        const card = cards[idx];
        if (!card || card.revealed) continue;
        const bucket = _normalizeMarkerBucket(markers[idxKey]);
        bucket[owner] = tag;
        markers[idxKey] = bucket;
      }

      for (const key of Object.keys(considering)) {
        const bucket = _normalizeConsideringBucket(considering[key]);
        delete bucket[owner];
        if (Object.keys(bucket).length) considering[key] = bucket;
        else delete considering[key];
      }

      if (Number.isFinite(desiredIdx) && desiredIdx >= 0) {
        const idx = Number(desiredIdx);
        const card = cards[idx];
        if (card && !card.revealed) {
          const key = String(idx);
          const bucket = _normalizeConsideringBucket(considering[key]);
          bucket[owner] = { initials, name, ts: Date.now() };
          considering[key] = bucket;
        }
      }

      tx.update(ref, {
        [markersField]: markers,
        [consideringField]: considering,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (_) {}
}

/**
 * Local-only AI marks overlay (separate from Firestore team markers).
 * - Used for AI UI hints without writing to the shared board.
 * - Shared/team communication uses Firestore markers via setTeamMarkerInFirestore().
 */
let aiCardMarks = {}; // gameId -> { [cardIndex]: "yes"|"maybe"|"no" }

function aiMarkCard(gameId, cardIndex, tag) {
  try {
    const gid = String(gameId || '');
    if (!gid) return;
    const idx = Number(cardIndex);
    if (!Number.isFinite(idx) || idx < 0) return;
    const t = String(tag || '').toLowerCase();
    if (!['yes','maybe','no','clear',''].includes(t)) return;
    if (!aiCardMarks[gid]) aiCardMarks[gid] = {};
    if (!t || t === 'clear') delete aiCardMarks[gid][idx];
    else aiCardMarks[gid][idx] = t;
    if (typeof renderCardTags === 'function') renderCardTags();
  } catch (_) {}
}

window.getAICardMarksForGame = function(gameId) {
  try { return (aiCardMarks && aiCardMarks[String(gameId)] ) ? aiCardMarks[String(gameId)] : {}; } catch (_) { return {}; }
};

function sanitizeChatText(text, vision, maxLen = 180) {
  try {
    let s = String(text || '').trim();
    if (!s) return '';
    // Remove ugly index mapping like "13 = WORD" (especially at start)
    s = s.replace(/^\s*\d{1,2}\s*=\s*/g, '');
    // Replace explicit "card 13"/"index 13"/"(13)" with the actual word, when possible
    const cards = Array.isArray(vision?.cards) ? vision.cards : [];
    const idxToWord = new Map();
    for (const c of cards) {
      const idx = Number(c?.index);
      const w = String(c?.word || '').trim();
      if (Number.isFinite(idx) && w) idxToWord.set(String(idx), w.toUpperCase());
    }
    const replIdx = (n) => idxToWord.get(String(n)) || '';
    s = s.replace(/\b(?:card|index)\s*#?\s*(\d{1,2})\b/gi, (_, n) => replIdx(n) || '');
    s = s.replace(/\(\s*(\d{1,2})\s*\)/g, (_, n) => {
      const w = replIdx(n);
      return w ? `(${w})` : '';
    });

    // If it still contains a standalone "N =" anywhere, drop the "N ="
    s = s.replace(/\b\d{1,2}\s*=\s*/g, '');

    // Never leak internal confidence scoring in visible team chat.
    s = s.replace(/\b(?:confidence|certainty|sure(?:ness)?)\s*(?:is|=|:)?\s*\d{1,2}(?:\s*\/\s*10|\s*%?)\b/gi, '');
    s = s.replace(/\b(?:\d{1,2}\s*\/\s*10|\d{1,2}\s*%)\s*(?:confidence|certain(?:ty)?|sure(?:ness)?)\b/gi, '');

    s = s.replace(/\s{2,}/g, ' ').trim();
    if (!s) return '';
    return s.slice(0, maxLen);
  } catch (_) {
    return String(text || '').trim().slice(0, maxLen);
  }
}

function normalizeConfidence10(value, fallback = 6) {
  const fbNum = Number(fallback);
  const fb = Number.isFinite(fbNum) ? Math.max(1, Math.min(10, Math.round(fbNum))) : 6;
  const n = Number(value);
  if (!Number.isFinite(n)) return fb;
  if (n > 0 && n <= 1) return Math.max(1, Math.min(10, Math.round(n * 10)));
  return Math.max(1, Math.min(10, Math.round(n)));
}

function confidenceToUnit(value, fallback = 0.6) {
  const fbNum = Number(fallback);
  const fb = Number.isFinite(fbNum) ? fbNum : 0.6;
  return normalizeConfidence10(value, fb * 10) / 10;
}

function buildOperativeConsensusSnapshot(proposals, councilSize) {
  const ps = (proposals || []).filter(p => p && p.action === 'guess' && p.index !== null && p.index !== undefined);
  if (!ps.length) return null;
  const size = Number.isFinite(+councilSize) && +councilSize > 0 ? +councilSize : ps.length;

  const byIndex = new Map();
  for (const p of ps) {
    const k = Number(p.index);
    if (!Number.isFinite(k)) continue;
    const cur = byIndex.get(k) || { votes: 0, sum: 0 };
    cur.votes += 1;
    cur.sum += normalizeConfidence10(p.confidence, 6);
    byIndex.set(k, cur);
  }

  let best = null;
  for (const [index, info] of byIndex.entries()) {
    const avg = info.sum / Math.max(1, info.votes);
    if (!best || info.votes > best.votes || (info.votes === best.votes && avg > best.avg)) {
      best = { index, votes: info.votes, avg };
    }
  }
  if (!best) return null;
  return { ...best, councilSize: size, voteRatio: best.votes / Math.max(1, size) };
}

function shouldMinimizeOperativeDiscussion(proposals, councilSize) {
  const snap = buildOperativeConsensusSnapshot(proposals, councilSize);
  if (!snap) return false;
  const voteFloor = snap.councilSize >= 3 ? 2 : snap.councilSize;
  return snap.votes >= voteFloor && snap.voteRatio >= 0.66 && snap.avg >= 8;
}

function buildSpymasterConsensusSnapshot(proposals, councilSize) {
  const ps = (proposals || []).filter(p => p && p.clue);
  if (!ps.length) return null;
  const size = Number.isFinite(+councilSize) && +councilSize > 0 ? +councilSize : ps.length;

  const byClue = new Map();
  for (const p of ps) {
    const clue = String(p.clue || '').trim().toUpperCase();
    if (!clue) continue;
    const number = Number.isFinite(+p.number) ? +p.number : 1;
    const key = `${clue}|${number}`;
    const cur = byClue.get(key) || { clue, number, votes: 0, sum: 0 };
    cur.votes += 1;
    cur.sum += normalizeConfidence10(p.confidence, 6);
    byClue.set(key, cur);
  }

  let best = null;
  for (const entry of byClue.values()) {
    const avg = entry.sum / Math.max(1, entry.votes);
    if (!best || entry.votes > best.votes || (entry.votes === best.votes && avg > best.avg)) {
      best = { clue: entry.clue, number: entry.number, votes: entry.votes, avg };
    }
  }
  if (!best) return null;
  return { ...best, councilSize: size, voteRatio: best.votes / Math.max(1, size) };
}

function shouldMinimizeSpymasterDiscussion(proposals, councilSize) {
  const snap = buildSpymasterConsensusSnapshot(proposals, councilSize);
  if (!snap) return false;
  const voteFloor = snap.councilSize >= 3 ? 2 : snap.councilSize;
  return snap.votes >= voteFloor && snap.voteRatio >= 0.66 && snap.avg >= 8;
}

// ─── Human-sounding chat post-processing (anti-repetition) ──────────────────

// Memory of recent AI chat so we can avoid repeated phrasing across AIs.
// Structure: { [gameId]: { [team]: ["msg", ...] } }
const aiChatMemory = {};

function _normTokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 40);
}

function _jaccard(a, b) {
  try {
    const A = new Set(_normTokens(a));
    const B = new Set(_normTokens(b));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const union = A.size + B.size - inter;
    return union ? inter / union : 0;
  } catch (_) {
    return 0;
  }
}

function _pick(arr) {
  const a = Array.isArray(arr) ? arr : [];
  return a.length ? a[Math.floor(Math.random() * a.length)] : '';
}

function _extractAllCapsWord(msg) {
  const m = String(msg || '').match(/\b[A-Z]{3,}\b/);
  return m ? m[0] : '';
}

function makeChatMoreHuman(ai, game, msg, vision, opts = {}) {
  try {
    const bypassSimilarity = !!opts.bypassSimilarity;
    let out = String(msg || '').trim();
    if (!out) return '';

    // Contractions for natural tone
    out = out.replace(/\bI am\b/gi, "I'm");
    out = out.replace(/\bdo not\b/gi, "don't");
    out = out.replace(/\bcan not\b/gi, "can't");
    out = out.replace(/\bcannot\b/gi, "can't");
    out = out.replace(/\bis not\b/gi, "isn't");
    out = out.replace(/\bare not\b/gi, "aren't");
    out = out.replace(/\bwill not\b/gi, "won't");
    out = out.replace(/\bwould not\b/gi, "wouldn't");
    out = out.replace(/\bshould not\b/gi, "shouldn't");
    out = out.replace(/\blet us\b/gi, "let's");
    out = out.replace(/\bit is\b/gi, "it's");
    out = out.replace(/\bthat is\b/gi, "that's");
    out = out.replace(/\bwhat is\b/gi, "what's");
    out = out.replace(/\bI would\b/gi, "I'd");
    out = out.replace(/\bI will\b/gi, "I'll");
    out = out.replace(/\bI have\b/gi, "I've");

    // Strip robotic/formal patterns that LLMs love to produce
    out = out.replace(/^\s*(I think|I believe|I feel like|I suggest|I would say|In my opinion|Leaning|I'm leaning towards?)\b\s*[:,\-–]?\s*/i, '');
    out = out.replace(/\b(Additionally|Furthermore|Moreover|However,? I)\b/gi, '');
    out = out.replace(/\b(it connects well with|it fits well with|it aligns with)\b/gi, 'it goes with');
    out = out.replace(/\bI strongly (believe|think|feel)\b/gi, 'I really think');

    // Clean up double spaces from removals
    out = out.replace(/\s{2,}/g, ' ').trim();
    // Lowercase the first char if we stripped a starter and it looks weird
    if (out && /^[A-Z][a-z]/.test(out) && out.length > 1) {
      // Only lowercase if it's not an all-caps word (board word)
      const firstWord = out.split(/\s/)[0];
      if (firstWord !== firstWord.toUpperCase()) {
        out = out[0].toLowerCase() + out.slice(1);
      }
    }

    const gid = String(game?.id || '');
    const team = String(ai?.team || '');
    if (!gid || !team) return out;

    if (!aiChatMemory[gid]) aiChatMemory[gid] = {};
    if (!aiChatMemory[gid][team]) aiChatMemory[gid][team] = [];
    const recent = aiChatMemory[gid][team].slice(-14);

    // If too similar to recent messages, suppress it entirely — silence is better than circles
    const tooSimilar = recent.some(r => _jaccard(r, out) > 0.32);
    if (tooSimilar && !bypassSimilarity) {
      return '';
    }

    // Suppress "agreement-only" messages when the team has already converged.
    // Detect if this message is essentially "let's go with WORD" and WORD has been
    // mentioned 2+ times in recent chat already.
    if (!bypassSimilarity) {
      const lowerOut = out.toLowerCase();
      const isAgreement = /^(yeah|yooo?|aight|let'?s|nice|ok|go|sure|ye|yea|bet)\b/i.test(lowerOut)
        || /\blet'?s (go|get|do|start|pick)\b/i.test(lowerOut)
        || /\b(sounds good|i'?m? (down|with)|on board|same)\b/i.test(lowerOut);
      if (isAgreement) {
        // Extract board words mentioned in this message
        const unrevealed = (vision?.cards || []).filter(c => !c.revealed).map(c => String(c.word || '').toUpperCase());
        const mentioned = unrevealed.filter(w => lowerOut.includes(w.toLowerCase()));
        if (mentioned.length > 0) {
          const wordMentionCounts = mentioned.map(w => {
            const wLower = w.toLowerCase();
            return recent.filter(r => r.toLowerCase().includes(wLower)).length;
          });
          // If any mentioned word already appears in 2+ recent messages, this is redundant agreement
          if (wordMentionCounts.some(c => c >= 2)) {
            return '';
          }
        }
      }
    }

    out = out.replace(/\s{2,}/g, ' ').trim();
    return out.slice(0, 180);
  } catch (_) {
    return String(msg || '').trim().slice(0, 180);
  }
}

// ─── Chat state helpers (live refresh before sending) ───────────────────────

function _chatSignature(chatDocs, take = 10) {
  try {
    const docs = Array.isArray(chatDocs) ? chatDocs.slice(-take) : [];
    return docs
      .map(d => `${Number(d.createdAtMs || 0)}|${String(d.senderId || '')}|${String(d.text || '').slice(0, 60)}`)
      .join('\\n');
  } catch (_) {
    return '';
  }
}

async function getTeamChatState(gameId, team, limit = 12) {
  try {
    const docs = await fetchRecentTeamChatDocs(gameId, team, limit);
    const newestMs = docs && docs.length ? Math.max(...docs.map(d => Number(d.createdAtMs || 0))) : 0;
    return { docs: docs || [], newestMs, sig: _chatSignature(docs || []) };
  } catch (_) {
    return { docs: [], newestMs: 0, sig: '' };
  }
}

function diffNewChatLines(oldDocs, newDocs, maxLines = 6) {
  try {
    const oldMax = oldDocs && oldDocs.length ? Math.max(...oldDocs.map(d => Number(d.createdAtMs || 0))) : 0;
    const fresh = (newDocs || []).filter(d => Number(d.createdAtMs || 0) > oldMax);
    return fresh.slice(-maxLines).map(d => `${d.senderName}: ${d.text}`);
  } catch (_) {
    return [];
  }
}

async function rewriteDraftChatAfterUpdate(ai, game, role, draft, oldDocs, newDocs) {
  try {
    const core = ensureAICore(ai);
    if (!core) return draft || '';
    const vision = buildAIVision(game, ai);
    const persona = core.personality;
    const updates = diffNewChatLines(oldDocs, newDocs, 8);
    if (!updates.length) return draft || '';

    const systemPrompt = [
      `You are ${ai.name}, Codenames ${String(role || '').toUpperCase()} on ${String(ai.team).toUpperCase()}.`,
      buildPersonalityBlockBrief(persona),
      '',
      `You drafted a message but new teammate messages came in. Decide if your draft is still relevant.`,
      `- If someone already said what you were going to say: set send=false (don't repeat them)`,
      `- If your draft responds to something that's now outdated: rewrite it`,
      `- If your draft is still relevant: keep it or adjust slightly`,
      `Keep it casual and short. No formal language.`,
      `NEVER reference card indices/numbers. Use board WORDS.`,
      `Return JSON only: {"mind":"2-4 lines thinking", "msg":"your message", "send":true|false}`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-8).join('\n');
    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      '',
      `YOUR DRAFT (not yet sent):\n${String(draft || '').trim()}`,
      '',
      `NEW TEAM MESSAGES (arrived after your draft):\n${updates.join('\n')}`,
      '',
      `RECENT MIND:\n${mindContext}`,
    ].join('\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: core.temperature, max_tokens: 240, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return draft || '';
    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);
    const send = (parsed.send === false) ? false : true;
    let msg = String(parsed.msg || '').trim();
    msg = sanitizeChatText(msg, vision, 180);
    if (!send) return '';
    return msg ? msg.slice(0, 180) : '';
  } catch (_) {
    return draft || '';
  }
}

/* ─── Multi-AI teamwork: rotation + councils ───────────────────────────── */

function _aiSeqField(team, role) {
  const t = String(team || '').toLowerCase();
  const r = String(role || '').toLowerCase(); // "op" or "spy"
  return `aiSeq_${t}_${r}`;
}

function pickRotatingAI(game, team, role, list) {
  const arr = Array.isArray(list) ? list.filter(Boolean) : [];
  if (!arr.length) return null;
  const field = _aiSeqField(team, role);
  const seq = Number.isFinite(+game?.[field]) ? +game[field] : 0;
  return arr[seq % arr.length];
}

function _turnKeyForCouncil(game, role, team) {
  const g = game || {};
  const clue = g.currentClue ? `${String(g.currentClue.word || '').toUpperCase()}_${Number(g.currentClue.number || 0)}` : 'noclue';
  const gr = Number.isFinite(+g.guessesRemaining) ? +g.guessesRemaining : 0;
  const cardsSig = Array.isArray(g.cards) ? g.cards.map(c => c && c.revealed ? '1' : '0').join('') : '';
  return `${String(g.id||'')}:${String(role)}:${String(team)}:${String(g.currentPhase)}:${String(g.currentTeam)}:${clue}:${gr}:${cardsSig}`;
}

async function aiOperativePropose(ai, game, opts = {}) {
  const core = ensureAICore(ai);
  if (!core) return null;

  const team = ai.team;
  const vision = buildAIVision(game, ai);
  const persona = core.personality;
  const requireMarks = !!opts.requireMarks;


  if (!vision.clue || !vision.clue.word) return null;

  const remainingGuesses = Number.isFinite(+game.guessesRemaining) ? +game.guessesRemaining : 0;
  const unrevealed = (vision.cards || []).filter(c => !c.revealed);
  if (!unrevealed.length) return null;

  const list = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\\n');

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-10).map(m => `${m.senderName}: ${m.text}`).join('\\n');

  const clueHistoryCtx = buildClueHistoryContext(game, team);
  const priorityCtx = buildOperativePriorityContext(game, team);
  const markerCtx = buildTeamMarkerContext(game, team, _markerOwnerId(ai.id));
  const opponentTeam = team === 'red' ? 'blue' : 'red';
  const opponentLeft = vision.score ? (opponentTeam === 'red' ? vision.score.redLeft : vision.score.blueLeft) : '?';
  const myLeft = vision.score ? (team === 'red' ? vision.score.redLeft : vision.score.blueLeft) : '?';

  const systemPrompt = [
    `You are ${ai.name}, playing Codenames as an OPERATIVE on ${String(team).toUpperCase()} team.`,
    buildPersonalityBlock(persona),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `THINK before you speak. Write your inner "mind" monologue first, THEN your chat.`,
    ``,
    `HOW TO TALK (critical — read carefully):`,
    `You're texting with friends during a board game. Be casual, short, and real.`,
    `- If the answer is OBVIOUS, just say so quickly: "obviously it's FORK, let's get it"`,
    `- Don't do empty agreement. If you agree, add one NEW reason or a risk caveat.`,
    `  GOOD: "FORK works, but watch ASSASSIN overlap with KNIFE vibes"`,
    `  BAD: "yeah agree, let's go FORK"`,
    `- If you DISAGREE, say why in 1 sentence and offer your alternative.`,
    `  GOOD: "eh idk about PASTA, i was thinking more CHOPSTICKS"`,
    `  BAD: "While PASTA is an interesting suggestion, I believe we should consider CHOPSTICKS instead because..."`,
    `- Reference past turns naturally: "we still got 1 left from the YELLOW clue" or "remember we already got BANANA"`,
    `- Talk about strategy when relevant: "the other team only has ${opponentLeft} left, we gotta risk it" or "we're ahead, play it safe"`,
    `- Propose creative connections casually: "lowkey hear me out, PASTA — you eat it with a fork"`,
    `- Use casual language: "aight", "ngl", "lowkey", "kinda", "idk", "tbh", contractions, etc.`,
    `- NEVER sound like a formal essay or AI. No "I believe", "I suggest", "Additionally", "Furthermore".`,
    `- Keep it to 1-2 short sentences MAX. Think group chat, not paragraph.`,
    `- EVERY message must add NEW information or a NEW opinion. If you have nothing new, set chat="" instead of agreeing.`,
    `- If teammates already said "let's go with WORD", do NOT say another variant of "yeah let's go with WORD". That's just noise. Set chat="" instead.`,
    `- Maximum 2 AIs should agree on a word. After that, further agreement is redundant.`,
    `- NEVER mention your confidence score/percent in chat.`,
    `- Priority rule: when unfinished older clues exist, prefer the easiest unresolved clue first before riskier bonus guesses.`,
    `- Actively use markers: set 1-3 yes/maybe/no marks every turn to show your current lean.`,
    `- React to teammate markers: if marker consensus/conflict changes your read, mention it briefly in chat.`,
    ``,
    `Return JSON only:`,
    `{"mind":"first-person inner monologue (2-8 lines)", "action":"guess|end_turn", "index":N, "focusClue":"CLUEWORD", "confidence":1-10, "marks":[{"index":N,"tag":"yes|maybe|no"}], "chat":"your message to teammates"}`,
    ``,
    `Rules:`,
    `- If action="guess", index MUST be an unrevealed index from the list.`,
    `- Current clue: "${String(vision.clue.word || '').toUpperCase()}" for ${Number(vision.clue.number || 0)}. You have ${remainingGuesses} guess(es) left.`,
    `- Your team has ${myLeft} words left. Opponent has ${opponentLeft} left.`,
    `- In chat, NEVER write card indices/numbers. Use the WORD itself.`,
    `- Read TEAM CHAT and actually respond to what people said. Don't ignore them.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-10).join('\n');
  const userPrompt = [
    `VISION:\n${JSON.stringify(vision)}`,
    ``,
    `UNREVEALED WORDS (choose ONLY from this list):\n${list}`,
    ``,
    clueHistoryCtx ? `${clueHistoryCtx}` : '',
    ``,
    priorityCtx ? `${priorityCtx}` : '',
    ``,
    markerCtx ? `${markerCtx}` : '',
    ``,
    `TEAM CHAT (latest messages — read these and respond naturally):\n${teamChat || '(no messages yet — you speak first)'}`,
    ``,
    `RECENT MIND:\n${mindContext}`
  ].filter(Boolean).join('\n');

  const { content: raw, reasoning } = await aiReasoningCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { max_tokens: 360, response_format: { type: 'json_object' } }
  );
  appendReasoningToMind(ai, reasoning);

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return null;

  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);

  const action = String(parsed.action || '').toLowerCase().trim();
  const idx = Number(parsed.index);
  const conf = normalizeConfidence10(parsed.confidence, 6);
  const priorityWords = new Set(buildOperativePriorityStack(game, team).map(it => String(it.word || '').toUpperCase()));
  const currentClueWord = String(vision?.clue?.word || '').trim().toUpperCase();
  let focusClue = String(parsed.focusClue || '').trim().toUpperCase();
  if (focusClue && !priorityWords.has(focusClue) && focusClue !== currentClueWord) focusClue = '';
  if (!focusClue && currentClueWord) focusClue = currentClueWord;
  const candidate = unrevealed.find(c => c.index === idx);

  const marksIn = Array.isArray(parsed.marks) ? parsed.marks : [];
  const marks = [];
  for (const m of marksIn) {
    const mi = Number(m?.index);
    const tag = String(m?.tag || '').toLowerCase().trim();
    if (!['yes','maybe','no'].includes(tag)) continue;
    const ok = unrevealed.some(c => c.index === mi);
    if (ok) marks.push({ index: mi, tag });
    if (marks.length >= 3) break;
  }

  if (requireMarks && (!marks || marks.length === 0) && action === 'guess' && candidate) {
    marks.push({ index: candidate.index, tag: 'yes' });
  }

  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 180);
  chat = chat.slice(0, 180);

  if (action === 'end_turn') {
    return { ai, action: 'end_turn', index: null, focusClue, confidence: conf, marks, chat };
  }
  if (action === 'guess' && candidate) {
    return { ai, action: 'guess', index: candidate.index, focusClue, confidence: conf, marks, chat };
  }

  // If invalid, default safe.
  return { ai, action: 'end_turn', index: null, focusClue, confidence: 1, marks, chat: chat || '' };
}

function chooseOperativeAction(proposals, game, councilSize) {
  const ps = (proposals || []).filter(Boolean);
  if (!ps.length) return { action: 'end_turn', index: null };
  const team = String(ps[0]?.ai?.team || game?.currentTeam || '').toLowerCase();
  const priorityStack = buildOperativePriorityStack(game, team);
  const currentClueWord = String(game?.currentClue?.word || '').trim().toUpperCase();
  const cluePriority = new Map(priorityStack.map(it => [String(it.word || '').toUpperCase(), Number(it.score || 0.5)]));
  const hasOlderUnresolved = priorityStack.some(it => !it.isCurrent && it.remainingTargets > 0);
  const markerMap = new Map(
    extractTeamMarkersForVision(game, team).map(row => [Number(row.index), row.counts || { yes: 0, maybe: 0, no: 0 }])
  );

  // Count guess consensus
  const byIndex = new Map();
  for (const p of ps) {
    if (p.action !== 'guess' || p.index === null || p.index === undefined) continue;
    const k = p.index;
    const cur = byIndex.get(k) || { sum: 0, n: 0, max: 0, prioritySum: 0 };
    const c = confidenceToUnit(p.confidence, 0.6);
    const focus = String(p.focusClue || currentClueWord || '').trim().toUpperCase();
    const pScore = cluePriority.has(focus)
      ? Number(cluePriority.get(focus) || 0.5)
      : (focus === currentClueWord ? 0.72 : 0.52);
    cur.sum += c; cur.n += 1; cur.max = Math.max(cur.max, c);
    cur.prioritySum += pScore;
    byIndex.set(k, cur);
  }

  const endVotes = ps.filter(p => p.action === 'end_turn').length;

  // Best guess by (avg confidence + consensus bonus)
  let best = null;
  for (const [idx, v] of byIndex.entries()) {
    const avg = v.sum / Math.max(1, v.n);
    const priorityAvg = v.prioritySum / Math.max(1, v.n);
    const marker = markerMap.get(Number(idx)) || { yes: 0, maybe: 0, no: 0 };
    const markerBias = (0.10 * Number(marker.yes || 0)) + (0.04 * Number(marker.maybe || 0)) - (0.11 * Number(marker.no || 0));
    const score = avg + (0.14 * v.n) + (0.06 * v.max) + (0.11 * priorityAvg) + markerBias;
    if (!best || score > best.score) best = { index: idx, score, avg, n: v.n, priorityAvg, marker };
  }

  // Ending early is allowed, but we bias against "silent" bails when there is a decent shared guess.
  // This is intentionally a soft heuristic (not a hard rule).
  if (endVotes > 0) {
    if (!best) return { action: 'end_turn', index: null };
    // If the team doesn't converge and confidence is low, ending is reasonable.
    if (best.avg < 0.56 && best.n < 2) return { action: 'end_turn', index: null };
    // When unfinished older clues exist, avoid low-priority speculative votes.
    if (hasOlderUnresolved && best.priorityAvg < 0.66 && best.avg < 0.64 && best.n < 2) {
      return { action: 'end_turn', index: null };
    }
    // Otherwise, prefer taking the shared guess.
  }

  if (!best) return { action: 'end_turn', index: null };

  // Threshold to guess: either decent avg confidence, or at least 2 AIs align.
  if (best.avg < 0.55 && best.n < 2) return { action: 'end_turn', index: null };
  if (Number(best?.marker?.no || 0) >= 2 && Number(best?.marker?.yes || 0) === 0 && best.avg < 0.72) {
    return { action: 'end_turn', index: null };
  }
  if (hasOlderUnresolved && best.priorityAvg < 0.62 && best.avg < 0.62 && best.n < 2) {
    return { action: 'end_turn', index: null };
  }
  return { action: 'guess', index: best.index };
}

async function aiOperativeCouncilSummary(ai, game, proposals, decision, opts = {}) {
  const core = ensureAICore(ai);
  if (!core) return '';
  const vision = buildAIVision(game, ai);
  const persona = core.personality;

  // Map indices to board words for clean, human-friendly summaries.
  const idxToWord = new Map();
  for (const c of (vision.cards || [])) {
    const idx = Number(c?.index);
    const w = String(c?.word || '').trim();
    if (Number.isFinite(idx) && w) idxToWord.set(idx, w.toUpperCase());
  }

  const ps = Array.isArray(proposals) ? proposals.filter(Boolean) : [];
  const proposalLines = ps.slice(0, 6).map(p => {
    if (p.action === 'guess' && Number.isFinite(+p.index)) {
      const w = idxToWord.get(Number(p.index)) || 'UNKNOWN';
      const c = normalizeConfidence10(p.confidence, 6);
      return `- ${String(p.ai?.name || 'AI')}: guess ${w} (confidence ${c}/10)`;
    }
    return `- ${String(p.ai?.name || 'AI')}: end turn`;
  }).join('\n');

  const decided = (decision?.action === 'guess' && Number.isFinite(+decision.index))
    ? `GUESS ${idxToWord.get(Number(decision.index)) || 'UNKNOWN'}`
    : 'END TURN';

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-8).map(m => `${m.senderName}: ${m.text}`).join('\n');

  const systemPrompt = [
    `You are ${ai.name}, OPERATIVE on ${String(ai.team).toUpperCase()} team.`,
    buildPersonalityBlockBrief(persona),
    ``,
    `The team just finished discussing. Decide if a wrap-up is even needed.`,
    ``,
    `CRITICAL: If the team already agreed and multiple people said "let's go with WORD",`,
    `DO NOT add another agreement message. Just set chat="" — silence is better than echoing.`,
    `Only speak if:`,
    `- There was genuine debate and you're acknowledging the resolution`,
    `- You're ending turn and want to explain briefly`,
    `- You have a last-second concern nobody raised`,
    ``,
    `STYLE:`,
    `- If everyone already agreed: chat="" (they don't need ANOTHER "let's go")`,
    `- If it was debated: briefly acknowledge, like "was torn but WORD makes sense"`,
    `- If ending turn: "not feeling great about any of these, end it"`,
      `- Do NOT recap the conversation. Everyone was there.`,
      `- Do NOT repeat reasoning that was already given.`,
      `- 1 short sentence max if you must speak. Casual tone.`,
      `- NEVER reference card indices/numbers. Use the WORD itself.`,
      `- NEVER mention confidence numbers/percentages.`,
      ``,
      `Return JSON only: {"mind":"2-4 lines first-person", "chat":"1 short sentence"}`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-8).join('\n');
  const userPrompt = [
    `TEAM CHAT (what was already said — do NOT repeat this):\n${teamChat}`,
    ``,
    `FINAL DECISION: ${decided}`,
    ``,
    `RECENT MIND:\n${mindContext}`,
  ].join('\n');

  const raw = await aiChatCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { temperature: core.temperature, max_tokens: 220, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return '';
  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);
  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 180);
  return chat ? chat.slice(0, 180) : '';
}

async function aiOperativeFollowup(ai, game, proposalsByAi, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return null;

    const vision = buildAIVision(game, ai);
    const persona = core.personality;
    const team = ai.team;

    const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
    const teamChat = chatDocs.slice(-12).map(m => `${m.senderName}: ${m.text}`).join('\n');

    // Summarize current proposals so the AI can react/adjust.
    const idxToWord = new Map();
    for (const c of (vision.cards || [])) {
      const idx = Number(c?.index);
      const w = String(c?.word || '').trim();
      if (Number.isFinite(idx) && w) idxToWord.set(idx, w.toUpperCase());
    }

    const ps = Array.from((proposalsByAi || new Map()).values()).filter(Boolean);
    const proposalLines = ps.slice(0, 8).map(p => {
      if (p.action === 'guess' && Number.isFinite(+p.index)) {
        const w = idxToWord.get(Number(p.index)) || 'UNKNOWN';
        const c = normalizeConfidence10(p.confidence, 6);
        return `- ${String(p.ai?.name || 'AI')}: guess ${w} (confidence ${c}/10)`;
      }
      return `- ${String(p.ai?.name || 'AI')}: end turn`;
    }).join('\n');

    const opponentTeam = team === 'red' ? 'blue' : 'red';
    const opponentLeft = vision.score ? (opponentTeam === 'red' ? vision.score.redLeft : vision.score.blueLeft) : '?';
    const clueHistoryCtx = buildClueHistoryContext(game, team);
    const priorityCtx = buildOperativePriorityContext(game, team);
    const markerCtx = buildTeamMarkerContext(game, team, _markerOwnerId(ai.id));

    const systemPrompt = [
      `You are ${ai.name}, OPERATIVE on ${String(team).toUpperCase()} team.`,
      buildPersonalityBlock(persona),
      '',
      AI_TIPS_MANUAL,
      '',
      `This is a FOLLOW-UP in an ongoing team conversation. Think first (mind), then decide if you have anything worth saying.`,
      ``,
      `CRITICAL — ONLY SPEAK IF:`,
      `1. You have a genuinely NEW idea, connection, or word suggestion nobody mentioned yet`,
      `2. You DISAGREE with something and can explain why in 1 sentence`,
      `3. Someone asked you a direct question`,
      `4. You want to bring up strategy (opponent has ${opponentLeft} left, should we risk it, etc.)`,
      `5. You need to correct a mistake ("no we already got that one remember?")`,
      ``,
      `DO NOT SPEAK IF:`,
      `- You'd just be restating what someone already said`,
      `- You'd be agreeing without adding anything new (if everyone already agrees, we're done)`,
      `- You'd be repeating your own previous message in different words`,
      `- The team has already converged on a guess — just set chat="" and continue=false`,
      ``,
      `CONVERSATION STYLE (same as before):`,
      `- Casual, short, like texting friends. "aight", "ngl", "lowkey", "idk", contractions.`,
      `- No formal language. No "I believe", "Additionally", "I suggest we consider".`,
      `- If you disagree: "eh idk about WORD, what about OTHER_WORD instead?"`,
      `- If you agree and want to add context: "yeah and also WORD works cause [new reason]"`,
      `- Max 1-2 short sentences.`,
      `- NEVER mention confidence numbers/percentages in chat.`,
      `- Priority rule: if unfinished older clues still have easy targets, finish those before speculative guesses.`,
      `- Actively update your markers (1-3 marks). If teammate markers conflict with your view, call it out briefly.`,
      ``,
      `Return JSON only:`,
      `{"mind":"2-8 lines first-person thinking", "chat":"(empty string if nothing new to say)", "action":"guess|end_turn|no_change", "index":N, "focusClue":"CLUEWORD", "confidence":1-10, "marks":[{"index":N,"tag":"yes|maybe|no"}], "continue":true|false}`,
      `Set continue=false if the team seems to agree or you have nothing more to add.`,
      `In chat, NEVER write card indices/numbers. Use the WORD itself.`,
    ].join('\n');

    const myPrev = proposalsByAi?.get(ai.id);
    const myPrevLine = myPrev
      ? (myPrev.action === 'guess'
          ? `Previously you leaned: GUESS ${(idxToWord.get(Number(myPrev.index)) || 'UNKNOWN')}`
          : `Previously you leaned: END TURN`)
      : `No previous proposal.`;

    const unrevealed = (vision.cards || []).filter(c => !c.revealed).map(c => String(c.word || '').trim().toUpperCase()).filter(Boolean);
    const mindContext = core.mindLog.slice(-10).join('\n');

    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      '',
      clueHistoryCtx ? `${clueHistoryCtx}` : '',
      '',
      priorityCtx ? `${priorityCtx}` : '',
      '',
      markerCtx ? `${markerCtx}` : '',
      '',
      `TEAM CHAT (read carefully — do NOT repeat what's already been said):\n${teamChat}`,
      '',
      `WHERE EVERYONE STANDS:\n${proposalLines || '(none)'}`,
      '',
      myPrevLine,
      '',
      `UNREVEALED WORDS:\n${unrevealed.join(', ')}`,
      '',
      `RECENT MIND:\n${mindContext}`,
    ].join('\n');

    const { content: raw, reasoning } = await aiReasoningCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { max_tokens: 360, response_format: { type: 'json_object' } }
    );
    appendReasoningToMind(ai, reasoning);

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return null;

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = String(parsed.chat || '').trim();
    chat = sanitizeChatText(chat, vision, 180);

    const action = String(parsed.action || 'no_change').toLowerCase().trim();
    const idx = Number(parsed.index);
    const conf = normalizeConfidence10(parsed.confidence, 6);
    const priorityWords = new Set(buildOperativePriorityStack(game, team).map(it => String(it.word || '').toUpperCase()));
    const currentClueWord = String(vision?.clue?.word || '').trim().toUpperCase();
    let focusClue = String(parsed.focusClue || '').trim().toUpperCase();
    if (focusClue && !priorityWords.has(focusClue) && focusClue !== currentClueWord) focusClue = '';
    if (!focusClue && currentClueWord) focusClue = currentClueWord;
    const cont = (parsed.continue === true);

    const marksIn = Array.isArray(parsed.marks) ? parsed.marks : [];
    const marks = [];
    const unrevealedIdx = new Set((vision.cards || []).filter(c => !c.revealed).map(c => Number(c.index)));
    for (const m of marksIn) {
      const mi = Number(m?.index);
      const tag = String(m?.tag || '').toLowerCase().trim();
      if (!['yes','maybe','no'].includes(tag)) continue;
      if (!unrevealedIdx.has(mi)) continue;
      marks.push({ index: mi, tag });
      if (marks.length >= 3) break;
    }

    const out = { ai, chat, marks, continue: cont, focusClue };
    if (action === 'guess' || action === 'end_turn') {
      if (action === 'guess' && unrevealedIdx.has(idx)) {
        out.action = 'guess';
        out.index = idx;
        out.confidence = conf;
      } else if (action === 'end_turn') {
        out.action = 'end_turn';
        out.index = null;
        out.confidence = conf;
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function runOperativeCouncil(game, team) {
  if (!game || game.winner) return;
  if (String(game.currentPhase || '') !== 'operatives') return;
  if (String(game.currentTeam || '') !== String(team || '')) return;
  const ops = (getAIOperatives(team) || []).filter(a => a && a.mode === 'autonomous');
  if (!ops.length) return;

  const key = _turnKeyForCouncil(game, 'op', team);

  // Collect proposals sequentially with refreshed chat context so AIs can
  // read what others said and adjust.
  let working = game;
  const proposalsByAi = new Map();

  for (const ai of ops) {
    const core = ensureAICore(ai);
    if (!core) continue;
    if (core.lastSuggestionKey === key) continue;
    if (aiThinkingState[ai.id]) continue;

    // Refresh snapshot so this AI sees prior teammate messages/markers.
    try {
      const g2 = await getGameSnapshot(game?.id);
      if (g2 && g2.cards) working = g2;
    } catch (_) {}
    if (!working || working.winner) return;
    if (String(working.currentPhase || '') !== 'operatives') return;
    if (String(working.currentTeam || '') !== String(team || '')) return;

    const chatBefore = await getTeamChatState(game.id, team, 14);

    aiThinkingState[ai.id] = true;
    try {
      const prop = await aiOperativePropose(ai, working, {
        requireMarks: ops.length >= 2,
        councilSize: ops.length,
        chatDocs: chatBefore.docs
      });
      if (!prop) {
        core.lastSuggestionKey = key;
        continue;
      }

      // If chat changed while the AI was drafting, let it rethink what it will say.
      const chatAfter = await getTeamChatState(game.id, team, 14);
      if (prop.chat && chatAfter.sig && chatAfter.sig !== chatBefore.sig) {
        const rewritten = await rewriteDraftChatAfterUpdate(ai, working, 'operative', prop.chat, chatBefore.docs, chatAfter.docs);
        prop.chat = rewritten;
      }

      proposalsByAi.set(ai.id, prop);

      // Share current AI focus with teammates via considering chips.
      await syncAIConsideringState(game.id, team, ai, prop);
      if (prop?.chat) await sendAIChatMessage(ai, working, prop.chat);

      core.lastSuggestionKey = key;
    } catch (_) {
    } finally {
      aiThinkingState[ai.id] = false;
    }

    // Give the next AI a moment to see/acknowledge what was just said.
    if (ops.length >= 2) await sleep(AI_COUNCIL_PACE.betweenSpeakersMs);
  }

  // If nobody proposed anything new for this key, don't re-act.
  if (!proposalsByAi.size) return;
  const minimizeDiscussion = shouldMinimizeOperativeDiscussion(Array.from(proposalsByAi.values()), ops.length);

  // Open discussion phase: AIs may send as many short back-and-forth messages as
  // they want (bounded internally), always thinking first. They can also revise
  // their own suggested action as the conversation evolves.
  if (ops.length >= 2 && !minimizeDiscussion) {
    let rounds = 0;
    while (rounds < 3) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of ops) {
        if (aiThinkingState[ai.id]) continue;
        // Refresh snapshot + chat so replies can incorporate the newest updates.
        try {
          const g2 = await getGameSnapshot(game?.id);
          if (g2 && g2.cards) working = g2;
        } catch (_) {}
        if (!working || working.winner) return;
        if (String(working.currentPhase || '') !== 'operatives') return;
        if (String(working.currentTeam || '') !== String(team || '')) return;
        const chatBefore = await getTeamChatState(game.id, team, 16);

        aiThinkingState[ai.id] = true;
        try {
          const follow = await aiOperativeFollowup(ai, working, proposalsByAi, { chatDocs: chatBefore.docs });
          if (!follow) continue;

          // If chat changed while drafting, rewrite the message to reflect it.
          const chatAfter = await getTeamChatState(game.id, team, 16);
          let chat = String(follow.chat || '').trim();
          if (chat && chatAfter.sig && chatAfter.sig !== chatBefore.sig) {
            chat = await rewriteDraftChatAfterUpdate(ai, working, 'operative', chat, chatBefore.docs, chatAfter.docs);
          }

          // Update the AI's current focus indicator.
          await syncAIConsideringState(game.id, team, ai, follow);

          // Update this AI's latest lean if it provided one.
          if (follow.action === 'guess' || follow.action === 'end_turn') {
            const prev = proposalsByAi.get(ai.id) || { ai };
            proposalsByAi.set(ai.id, { ...prev, ...follow, chat: chat || '' });
          }

          if (chat) {
            await sendAIChatMessage(ai, working, chat);
            anySpoke = true;
            // If they want to continue, they'll get another chance in the next round.
          }
        } catch (_) {
        } finally {
          aiThinkingState[ai.id] = false;
        }

        if (anySpoke) await sleep(Math.max(220, Math.min(900, AI_COUNCIL_PACE.betweenSpeakersMs)));
      }

      if (!anySpoke) break;
      // Small pause between rounds to allow humans/AIs to interject.
      await sleep(Math.max(280, Math.min(1000, AI_COUNCIL_PACE.beforeDecisionMs * 0.7)));
    }
  }

  if (ops.length >= 2 && !minimizeDiscussion) await sleep(AI_COUNCIL_PACE.beforeDecisionMs);

  // Decide and act (rotating executor)
  const executor = pickRotatingAI(game, team, 'op', ops) || ops[0];
  if (!executor) return;
  if (aiThinkingState[executor.id]) return;

  // Use freshest snapshot before acting
  let fresh = working;
  try {
    const g2 = await getGameSnapshot(game?.id);
    if (g2 && g2.cards) fresh = g2;
  } catch (_) {}

  // Re-check phase/turn
  if (fresh.currentPhase !== 'operatives' || fresh.currentTeam !== team) return;

  const proposals = Array.from(proposalsByAi.values()).filter(Boolean);
  const decision = chooseOperativeAction(proposals, fresh, ops.length);

  // Optional follow-up wrap-up message (allows an AI to speak twice and helps
  // them actually process teammate input). This is advice-driven, not forced.
  if (ops.length >= 2 && !minimizeDiscussion) {
    try {
      const core = ensureAICore(executor);
      if (core && core.lastCouncilSummaryKey !== key) {
        let chatDocs = [];
        try { chatDocs = await fetchRecentTeamChatDocs(fresh.id, team, 10); } catch (_) {}
        const wrap = await aiOperativeCouncilSummary(executor, fresh, proposals, decision, { chatDocs });
        if (wrap) await sendAIChatMessage(executor, fresh, wrap);
        core.lastCouncilSummaryKey = key;
        await sleep(Math.min(450, AI_COUNCIL_PACE.betweenSpeakersMs));
      }
    } catch (_) {}
  }

  if (decision.action === 'guess' && Number.isFinite(+decision.index)) {
    await aiRevealCard(executor, fresh, Number(decision.index), true);
  } else {
    await aiConsiderEndTurn(executor, fresh, true, true);
  }
}

async function aiSpymasterPropose(ai, game, opts = {}) {
  const core = ensureAICore(ai);
  if (!core) return null;

  const team = ai.team;
  const vision = buildAIVision(game, ai);
  const persona = core.personality;

  const boardWords = (vision.cards || []).map(c => String(c.word || '').trim().toUpperCase()).filter(Boolean);

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-10).map(m => `${m.senderName}: ${m.text}`).join('\n');

  const clueHistoryCtx = buildClueHistoryContext(game, team);

  const systemPrompt = [
    `You are ${ai.name}, SPYMASTER on ${String(team).toUpperCase()}.`,
    buildPersonalityBlock(persona),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `Think through your options in "mind", then propose a clue. Aim for 2-4 when safe; 0 only if defensive.`,
    `If chatting with teammate spymasters, be casual: "thinking ANIMAL for 3, connects BEAR, FOX, and TIGER"`,
    `Keep chat short. No formal language.`,
    `NEVER mention confidence scores/percentages in chat.`,
    `Return JSON only:`,
    `{"mind":"first-person thinking (2-8 lines)", "clue":"ONEWORD", "number":N, "confidence":1-10, "chat":"optional short teammate message"}`,
    ``,
    `Rules:`,
    `- clue: ONE word (no spaces, no hyphens), NOT any board word.`,
    `- Forbidden board words: ${boardWords.join(', ')}`,
    `- number: integer 0-9.`,
    `- In chat, NEVER reference card indices/numbers.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-10).join('\n');
  const userPrompt = [
    `VISION:\n${JSON.stringify(vision)}`,
    '',
    clueHistoryCtx ? `${clueHistoryCtx}` : '',
    '',
    `TEAM CHAT (latest messages):\n${teamChat || '(none)'}`,
    '',
    `RECENT MIND:\n${mindContext}`,
  ].filter(Boolean).join('\n');

  const { content: raw, reasoning } = await aiReasoningCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { max_tokens: 360, response_format: { type: 'json_object' } }
  );
  appendReasoningToMind(ai, reasoning);

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return null;

  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);

  let clueWord = String(parsed.clue || '').trim().toUpperCase();
  let clueNumber = parseInt(parsed.number, 10);
  if (!Number.isFinite(clueNumber)) clueNumber = 1;
  clueNumber = Math.max(0, Math.min(9, clueNumber));
  const conf = normalizeConfidence10(parsed.confidence, 6);

  const bad =
    (!clueWord) ? 'empty clue' :
    (clueWord.includes(' ') || clueWord.includes('-')) ? 'clue must be one word' :
    (boardWords.includes(clueWord)) ? 'clue is on the board' :
    null;

  if (bad) {
    appendMind(ai, `My proposed clue was invalid (${bad}). I'll try to stay safer next time.`);
    return null;
  }

  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 180);
  chat = chat.slice(0, 180);
  return { ai, clue: clueWord, number: clueNumber, confidence: conf, chat };
}

function chooseSpymasterClue(proposals) {
  const ps = (proposals || []).filter(p => p && p.clue);
  if (!ps.length) return null;

  // Prefer higher confidence and reasonable multi-hit numbers
  let best = null;
  for (const p of ps) {
    const n = Number.isFinite(+p.number) ? +p.number : 1;
    const c = confidenceToUnit(p.confidence, 0.6);
    const score = c + (Math.min(4, Math.max(0, n)) * 0.08); // reward 2-4 gently
    if (!best || score > best.score) best = { clue: p.clue, number: n, score };
  }
  return best ? { clue: best.clue, number: best.number } : null;
}

async function aiSpymasterCouncilSummary(ai, game, proposals, pick, opts = {}) {
  const core = ensureAICore(ai);
  if (!core) return '';
  const vision = buildAIVision(game, ai);
  const persona = core.personality;

  const ps = Array.isArray(proposals) ? proposals.filter(p => p && p.clue) : [];
  const proposalLines = ps.slice(0, 6).map(p => {
    const n = Number.isFinite(+p.number) ? +p.number : 1;
    const c = normalizeConfidence10(p.confidence, 6);
    return `- ${String(p.ai?.name || 'AI')}: ${String(p.clue).toUpperCase()} for ${n} (confidence ${c}/10)`;
  }).join('\n');

  const chosen = pick ? `${String(pick.clue || '').toUpperCase()} for ${Number(pick.number || 0)}` : '';

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-8).map(m => `${m.senderName}: ${m.text}`).join('\n');

  const systemPrompt = [
    `You are ${ai.name}, SPYMASTER on ${String(ai.team).toUpperCase()}.`,
    buildPersonalityBlockBrief(persona),
    ``,
    `Quick wrap-up before giving the clue. Keep it super short and casual.`,
    `- If everyone agreed: "aight going with ${chosen}" type message, that's it.`,
    `- If there was debate: very briefly acknowledge it, like "was between X and Y but going ${chosen}"`,
    `- Do NOT recap the whole discussion. 1 short sentence.`,
    `- No card indices/numbers. No formal language.`,
    `- NEVER mention confidence numbers/percentages.`,
    `Return JSON only: {"mind":"2-4 lines thinking", "chat":"1 short sentence"}`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-8).join('\n');
  const userPrompt = [
    `TEAM CHAT (what was already said — don't repeat):\n${teamChat}`,
    ``,
    `CHOSEN CLUE: ${chosen}`,
    ``,
    `RECENT MIND:\n${mindContext}`,
  ].join('\n');

  const raw = await aiChatCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { temperature: core.temperature, max_tokens: 220, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return '';
  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);
  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 180);
  return chat ? chat.slice(0, 180) : '';
}

// ── AI Spymaster Live Thinking / Typing Simulation ──
// Simulates the AI "thinking out loud" by typing draft clues into liveClueDraft,
// pausing, deleting them, and finally typing the real clue — visible to the
// opposing spymaster via the existing live typing indicator.

function _pickFakeDraftWords(ai, finalClue, boardWords) {
  const core = ensureAICore(ai);
  // Extract candidate words from mind log
  const mindText = (core ? core.mindLog.slice(-6).join(' ') : '');
  const candidates = mindText
    .replace(/[^a-zA-Z\s]/g, ' ')
    .split(/\s+/)
    .map(w => w.toUpperCase().trim())
    .filter(w => w.length >= 3 && w !== finalClue && !boardWords.includes(w));
  // Deduplicate
  const unique = [...new Set(candidates)];
  // Pick 1-2 random fake drafts
  const count = Math.min(unique.length, 1 + Math.floor(Math.random() * 2));
  const picked = [];
  const pool = [...unique];
  for (let i = 0; i < count && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(idx, 1)[0]);
  }
  // Fallback: if no words from mind, use partial typing of final clue then backspace
  if (!picked.length) {
    const partial = finalClue.slice(0, Math.max(2, Math.floor(finalClue.length * 0.6)));
    picked.push(partial);
  }
  return picked;
}

async function _setAILiveClueDraft(game, team, ai, word, number) {
  const payload = word ? {
    team,
    word: String(word).toUpperCase().slice(0, 40),
    number: number !== null && number !== undefined ? String(number) : '',
    byId: String(ai?.odId || ai?.id || '').trim(),
    byName: String(ai?.name || 'AI').trim(),
    updatedAtMs: Date.now(),
  } : null;

  const gid = String(game?.id || '').trim();
  if (!gid) return;

  // If this AI is running in the same browser session as the viewer (common in
  // singleplayer), update the in-memory snapshot immediately so the typing
  // animation renders without waiting for Firestore round-trips.
  try {
    if (typeof currentGame !== 'undefined' && currentGame && String(currentGame?.id || '').trim() === gid) {
      currentGame.liveClueDraft = payload;
      if (typeof renderClueArea === 'function') renderClueArea();
    }
  } catch (_) {}

  // Local practice game
  if (typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid)) {
    if (typeof window.mutateLocalPracticeGame === 'function') {
      window.mutateLocalPracticeGame(gid, (draft) => {
        draft.liveClueDraft = payload;
      });
    }
    return;
  }

  // Online game — update Firestore
  try {
    const ref = db.collection('games').doc(gid);
    if (payload) {
      await ref.update({ liveClueDraft: payload });
    } else {
      await ref.update({ liveClueDraft: firebase.firestore.FieldValue.delete() });
    }
  } catch (_) {}
}

function _sanitizeOneWordClue(raw) {
  const w = String(raw || '').trim().toUpperCase();
  if (!w) return '';
  if (w.includes(' ') || w.includes('-')) return '';
  return w.replace(/[^A-Z0-9]/g, '').slice(0, 40);
}

function _dedupeConsideredClues(items) {
  const out = [];
  const seen = new Set();
  for (const it of (Array.isArray(items) ? items : [])) {
    const clue = _sanitizeOneWordClue(it?.clue || it?.word);
    if (!clue) continue;
    const n = Number.isFinite(+it?.number) ? Math.max(0, Math.min(9, parseInt(it.number, 10) || 0)) : null;
    const key = `${clue}|${n === null ? '' : n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ clue, number: n });
  }
  return out;
}

async function simulateAISpymasterThinking(ai, game, finalClue, finalNumber, opts = {}) {
  if (!ai || !game) return;
  const team = String(ai.team || '');
  const boardWords = (game.cards || []).map(c => String(c?.word || '').toUpperCase()).filter(Boolean);

  const finalWord = _sanitizeOneWordClue(finalClue);
  const finalNum = Number.isFinite(+finalNumber) ? Math.max(0, Math.min(9, parseInt(finalNumber, 10) || 0)) : 1;
  if (!finalWord) return;

  // If callers provide explicit "considered" clues, use those. Otherwise fall back
  // to mind-log-derived fake drafts.
  let considered = _dedupeConsideredClues(opts.considered);

  // Drop anything that's on the board, and cap to keep the animation from dragging.
  considered = considered.filter(x => x?.clue && !boardWords.includes(x.clue)).slice(0, 4);

  const typeSpeed = () => 55 + Math.floor(Math.random() * 70);   // 55-125ms per char
  const deleteSpeed = () => 35 + Math.floor(Math.random() * 45); // 35-80ms per char
  const thinkPause = () => 450 + Math.floor(Math.random() * 900);

  // Ensure the final clue is represented.
  if (!considered.find(x => x.clue === finalWord && (x.number === null || x.number === finalNum))) {
    considered.push({ clue: finalWord, number: finalNum });
  }

  // If we *only* have the final, synthesize some "draft" ideas like before.
  if (considered.length <= 1) {
    const fakes = _pickFakeDraftWords(ai, finalWord, boardWords);
    for (const fake of fakes) {
      for (let i = 1; i <= fake.length; i++) {
        await _setAILiveClueDraft(game, team, ai, fake.slice(0, i), null);
        await sleep(typeSpeed());
      }
      await sleep(thinkPause());
      for (let i = fake.length - 1; i >= 0; i--) {
        await _setAILiveClueDraft(game, team, ai, i ? fake.slice(0, i) : null, null);
        await sleep(deleteSpeed());
      }
      await sleep(250 + Math.floor(Math.random() * 350));
    }
  } else {
    // Animate each considered clue: type → brief pause → delete → think.
    // Reserve the last step for the final clue.
    const last = considered[considered.length - 1];
    const drafts = considered.slice(0, -1);
    for (const d of drafts) {
      const w = _sanitizeOneWordClue(d.clue);
      if (!w) continue;
      for (let i = 1; i <= w.length; i++) {
        await _setAILiveClueDraft(game, team, ai, w.slice(0, i), null);
        await sleep(typeSpeed());
      }
      // Briefly set the number once the word is "complete".
      if (d.number !== null && d.number !== undefined) {
        await _setAILiveClueDraft(game, team, ai, w, d.number);
      }
      await sleep(thinkPause());

      // Delete it.
      for (let i = w.length - 1; i >= 0; i--) {
        await _setAILiveClueDraft(game, team, ai, i ? w.slice(0, i) : null, null);
        await sleep(deleteSpeed());
      }
      await sleep(300 + Math.floor(Math.random() * 500));
    }

    // Make sure "last" matches the caller's final.
    if (last?.clue !== finalWord || (last?.number !== null && last?.number !== finalNum)) {
      // No-op: we still type the explicit final below.
    }
  }

  // Type the real clue.
  for (let i = 1; i <= finalWord.length; i++) {
    const showNumber = (i === finalWord.length) ? finalNum : null;
    await _setAILiveClueDraft(game, team, ai, finalWord.slice(0, i), showNumber);
    await sleep(typeSpeed());
  }

  await sleep(450 + Math.floor(Math.random() * 450));
  await _setAILiveClueDraft(game, team, ai, null, null);
}

async function submitClueDirect(ai, game, clueWord, clueNumber) {
  if (!ai || !game || game.winner) return;
  if (String(ai?.mode || '') !== 'autonomous') return;
  if (String(ai?.seatRole || '') !== 'spymaster') return;
  if (String(game.currentPhase || '') !== 'spymaster') return;
  if (String(game.currentTeam || '') !== String(ai?.team || '')) return;
  if (hasBlockingPendingClueReview(game)) return;
  const team = ai.team;
  const ref = db.collection('games').doc(game.id);
  const seqField = _aiSeqField(team, 'spy');
  let clueAccepted = false;

  const submitWithReview = window.submitClueForReviewFlow;
  if (typeof submitWithReview === 'function') {
    const result = await submitWithReview({
      game,
      word: clueWord,
      number: clueNumber,
      targets: [],
      targetWords: [],
      byId: String(ai?.odId || ai?.id || '').trim(),
      byName: String(ai?.name || 'AI').trim() || 'AI',
      seqField,
    });
    clueAccepted = !!result?.accepted;
  } else {
    const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
    const clueEntry = {
      team: game.currentTeam,
      word: clueWord,
      number: clueNumber,
      results: [],
      timestamp: new Date().toISOString(),
    };

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const current = snap.data();
      if (current.currentPhase !== 'spymaster' || current.currentTeam !== team) return;

      const spymasterKey = team === 'red' ? 'redSpymaster' : 'blueSpymaster';

      tx.update(ref, {
        [spymasterKey]: ai.name,
        currentClue: { word: clueWord, number: clueNumber },
        guessesRemaining: (clueNumber === 0 ? 0 : (clueNumber + 1)),
        currentPhase: 'operatives',
        timerEnd: buildPhaseTimerEndForGame(current, 'operatives'),
        log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`),
        clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
        [seqField]: firebase.firestore.FieldValue.increment(1),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      clueAccepted = true;
    });
  }

  if (clueAccepted && window.playSound) window.playSound('clueGiven');
}

async function aiSpymasterFollowup(ai, game, proposalsByAi, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return null;

    const vision = buildAIVision(game, ai);
    const persona = core.personality;
    const team = ai.team;

    const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
    const teamChat = chatDocs.slice(-12).map(m => `${m.senderName}: ${m.text}`).join('\n');

    const boardWords = (vision.cards || []).map(c => String(c.word || '').trim().toUpperCase()).filter(Boolean);

    const ps = Array.from((proposalsByAi || new Map()).values()).filter(p => p && p.clue);
    const proposalLines = ps.slice(0, 8).map(p => {
      const n = Number.isFinite(+p.number) ? +p.number : 1;
      const c = normalizeConfidence10(p.confidence, 6);
      return `- ${String(p.ai?.name || 'AI')}: ${String(p.clue).toUpperCase()} for ${n} (confidence ${c}/10)`;
    }).join('\n');

    const myPrev = proposalsByAi?.get(ai.id);
    const myPrevLine = myPrev && myPrev.clue
      ? `Previously you leaned: ${String(myPrev.clue).toUpperCase()} for ${Number(myPrev.number || 0)}`
      : `No previous clue proposal.`;

    const systemPrompt = [
      `You are ${ai.name}, SPYMASTER on ${String(team).toUpperCase()}.`,
      buildPersonalityBlock(persona),
      '',
      AI_TIPS_MANUAL,
      '',
      `This is a follow-up in the spymaster discussion. ONLY speak if you have something NEW.`,
      `- If everyone agrees on a clue, set chat="" and continue=false. Don't repeat agreement.`,
      `- If you want to propose a DIFFERENT clue, explain why briefly.`,
      `- If you want to adjust the number, say so concisely.`,
      `- Casual tone, short messages. No formal language.`,
      `- NEVER mention confidence numbers/percentages in chat.`,
      `Return JSON only:`,
      `{"mind":"2-6 lines thinking", "chat":"(empty if nothing new)", "action":"propose|no_change", "clue":"ONEWORD", "number":N, "confidence":1-10, "continue":true|false}`,
      `clue must be ONE word (no spaces/hyphens), NOT a board word.`,
      `In chat, NEVER write card indices/numbers.`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      '',
      `TEAM CHAT (latest):\n${teamChat}`,
      '',
      `CURRENT SPYMASTER LEANS:\n${proposalLines || '(none)'}`,
      '',
      myPrevLine,
      '',
      `BOARD WORDS (clue must NOT match):\n${boardWords.join(', ')}`,
      '',
      `RECENT MIND:\n${mindContext}`,
    ].join('\n');

    const { content: raw, reasoning } = await aiReasoningCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { max_tokens: 360, response_format: { type: 'json_object' } }
    );
    appendReasoningToMind(ai, reasoning);

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return null;

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = String(parsed.chat || '').trim();
    chat = sanitizeChatText(chat, vision, 180);

    const action = String(parsed.action || 'no_change').toLowerCase().trim();
    const cont = (parsed.continue === true);

    const out = { ai, chat, continue: cont };
    if (action === 'propose') {
      let clueWord = String(parsed.clue || '').trim().toUpperCase();
      let clueNumber = parseInt(parsed.number, 10);
      if (!Number.isFinite(clueNumber)) clueNumber = 1;
      clueNumber = Math.max(0, Math.min(9, clueNumber));
      const conf = normalizeConfidence10(parsed.confidence, 6);
      const bad =
        (!clueWord) ? 'empty clue' :
        (clueWord.includes(' ') || clueWord.includes('-')) ? 'not one word' :
        (boardWords.includes(clueWord)) ? 'clue is on the board' :
        null;
      if (!bad) {
        out.clue = clueWord;
        out.number = clueNumber;
        out.confidence = conf;
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function runSpymasterCouncil(game, team) {
  if (!game || game.winner) return;
  if (String(game.currentPhase || '') !== 'spymaster') return;
  if (String(game.currentTeam || '') !== String(team || '')) return;
  if (hasBlockingPendingClueReview(game)) return;
  const spies = (getAISpymasters(team) || []).filter(a => a && a.mode === 'autonomous');
  if (!spies.length) return;

  const key = _turnKeyForCouncil(game, 'spy', team);

  let working = game;
  const proposalsByAi = new Map();

  // Sequential proposals so later spymasters can read earlier chat/ideas.
  for (const ai of spies) {
    const core = ensureAICore(ai);
    if (!core) continue;
    if (core.lastSuggestionKey === key) continue;
    if (aiThinkingState[ai.id]) continue;

    try {
      const g2 = await getGameSnapshot(game?.id);
      if (g2 && g2.cards) working = g2;
    } catch (_) {}
    if (!working || working.winner) return;
    if (String(working.currentPhase || '') !== 'spymaster') return;
    if (String(working.currentTeam || '') !== String(team || '')) return;

    const chatBefore = await getTeamChatState(game.id, team, 14);

    aiThinkingState[ai.id] = true;
    try {
      const prop = await aiSpymasterPropose(ai, working, { chatDocs: chatBefore.docs });
      if (prop) {
        const chatAfter = await getTeamChatState(game.id, team, 14);
        if (prop.chat && chatAfter.sig && chatAfter.sig !== chatBefore.sig) {
          const rewritten = await rewriteDraftChatAfterUpdate(ai, working, 'spymaster', prop.chat, chatBefore.docs, chatAfter.docs);
          prop.chat = rewritten;
        }

        proposalsByAi.set(ai.id, prop);
        if (prop.chat) await sendAIChatMessage(ai, working, prop.chat);
      }
      core.lastSuggestionKey = key;
    } catch (_) {
    } finally {
      aiThinkingState[ai.id] = false;
    }

    if (spies.length >= 2) await sleep(AI_COUNCIL_PACE.betweenSpeakersMs);
  }

  if (!proposalsByAi.size) return;
  const minimizeDiscussion = shouldMinimizeSpymasterDiscussion(Array.from(proposalsByAi.values()), spies.length);

  // Open discussion phase (multiple short messages). Not forced; AIs may talk
  // as much as they want (bounded internally) and can revise their own clue lean.
  if (spies.length >= 2 && !minimizeDiscussion) {
    let rounds = 0;
    while (rounds < 3) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of spies) {
        if (aiThinkingState[ai.id]) continue;
        try {
          const g2 = await getGameSnapshot(game?.id);
          if (g2 && g2.cards) working = g2;
        } catch (_) {}
        if (!working || working.winner) return;
        if (String(working.currentPhase || '') !== 'spymaster') return;
        if (String(working.currentTeam || '') !== String(team || '')) return;

        const chatBefore = await getTeamChatState(game.id, team, 16);
        aiThinkingState[ai.id] = true;
        try {
          const follow = await aiSpymasterFollowup(ai, working, proposalsByAi, { chatDocs: chatBefore.docs });
          if (!follow) continue;

          const chatAfter = await getTeamChatState(game.id, team, 16);
          let chat = String(follow.chat || '').trim();
          if (chat && chatAfter.sig && chatAfter.sig !== chatBefore.sig) {
            chat = await rewriteDraftChatAfterUpdate(ai, working, 'spymaster', chat, chatBefore.docs, chatAfter.docs);
          }

          // Update this AI's latest clue lean if it provided one.
          if (follow.clue) {
            const prev = proposalsByAi.get(ai.id) || { ai };
            proposalsByAi.set(ai.id, { ...prev, ...follow, chat: chat || '' });
          }

          if (chat) {
            await sendAIChatMessage(ai, working, chat);
            anySpoke = true;
          }
        } catch (_) {
        } finally {
          aiThinkingState[ai.id] = false;
        }

        if (anySpoke) await sleep(Math.max(220, Math.min(900, AI_COUNCIL_PACE.betweenSpeakersMs)));
      }

      if (!anySpoke) break;
      await sleep(Math.max(280, Math.min(1000, AI_COUNCIL_PACE.beforeDecisionMs * 0.7)));
    }
  }

  if (spies.length >= 2 && !minimizeDiscussion) await sleep(AI_COUNCIL_PACE.beforeDecisionMs);

  const proposals = Array.from(proposalsByAi.values()).filter(Boolean);
  const pick = chooseSpymasterClue(proposals);
  if (!pick) return;

  const executor = pickRotatingAI(game, team, 'spy', spies) || spies[0];
  if (!executor) return;
  if (aiThinkingState[executor.id]) return;

  // Fresh snapshot before submit
  let fresh = working;
  try {
    const g2 = await getGameSnapshot(game?.id);
    if (g2 && g2.cards) fresh = g2;
  } catch (_) {}

  if (fresh.currentPhase !== 'spymaster' || fresh.currentTeam !== team) return;

  // Optional follow-up wrap-up message (allows an AI to speak twice and helps
  // them integrate teammate input). Advice-driven, not forced.
  if (spies.length >= 2 && !minimizeDiscussion) {
    try {
      const core = ensureAICore(executor);
      if (core && core.lastCouncilSummaryKey !== key) {
        let chatDocs = [];
        try { chatDocs = await fetchRecentTeamChatDocs(fresh.id, team, 10); } catch (_) {}
        const wrap = await aiSpymasterCouncilSummary(executor, fresh, proposals, pick, { chatDocs });
        if (wrap) await sendAIChatMessage(executor, fresh, wrap);
        core.lastCouncilSummaryKey = key;
        await sleep(Math.min(450, AI_COUNCIL_PACE.betweenSpeakersMs));
      }
    } catch (_) {}
  }

  const considered = _dedupeConsideredClues(
    proposals.map(p => ({ clue: p?.clue, number: p?.number }))
  ).slice(0, 4);

  await simulateAISpymasterThinking(executor, fresh, pick.clue, pick.number, { considered });
  await submitClueDirect(executor, fresh, pick.clue, pick.number);
}
async function aiGiveClue(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  try {
    // Always operate on the freshest state.
    try {
      const fresh = await getGameSnapshot(game?.id);
      if (fresh && fresh.cards) game = fresh;
    } catch (_) {}
    if (!game || game.winner) return;
    if (String(ai?.mode || '') !== 'autonomous') return;
    if (String(ai?.seatRole || '') !== 'spymaster') return;
    if (String(game.currentPhase || '') !== 'spymaster') return;
    if (String(game.currentTeam || '') !== String(ai?.team || '')) return;
    if (hasBlockingPendingClueReview(game)) return;

    const core = ensureAICore(ai);
    if (!core) return;

    const team = ai.team;
    const vision = buildAIVision(game, ai); // spymaster vision includes types
    const persona = core.personality;

    const boardWords = (vision.cards || []).map(c => String(c.word || '').trim().toUpperCase()).filter(Boolean);

    const systemPrompt = [
      `You are ${ai.name}.`,
      `You are the Codenames SPYMASTER for the ${String(team || '').toUpperCase()} team.`,
      ``,
      buildPersonalityBlock(persona),
      ``,
      AI_TIPS_MANUAL,
      ``,
      `VISION (exact current on-screen state for your role) will be provided as JSON.`,
      ``,
      `MIND RULE: You have a private inner monologue. The only way you think is by writing.`,
      `Return JSON only with this schema:`,
      `{"mind":"first-person inner monologue", "candidates":[{"clue":"ONEWORD","number":N}], "final":{"clue":"ONEWORD","number":N}}`,
      ``,
      `Hard requirements:`,
      `- EVERY clue (candidates + final) must be ONE word (no spaces, no hyphens).`,
      `- EVERY clue must NOT be any board word: ${boardWords.join(', ')}`,
      `- numbers are integers 0-9.`,
      `- Give 2-4 candidates (including the final if you want), and then pick ONE final.`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = `VISION:
${JSON.stringify(vision)}

RECENT MIND:
${mindContext}`;

    let clueWord = '';
    let clueNumber = 1;
    let mind = '';
    let considered = [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      const { content: raw, reasoning } = await aiReasoningCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { max_tokens: 420, response_format: { type: 'json_object' } }
      );
      appendReasoningToMind(ai, reasoning);

      let parsed = null;
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
      if (!parsed) continue;

      mind = String(parsed.mind || '').trim();
      if (mind) appendMind(ai, mind);

      // Collect considered candidates (for live typing simulation)
      const rawCandidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
      considered = _dedupeConsideredClues(rawCandidates);

      const finalObj = (parsed.final && typeof parsed.final === 'object') ? parsed.final : null;
      clueWord = _sanitizeOneWordClue(finalObj?.clue ?? parsed.clue);
      clueNumber = parseInt(finalObj?.number ?? parsed.number, 10);
      if (!Number.isFinite(clueNumber)) clueNumber = 1;
      clueNumber = Math.max(0, Math.min(9, clueNumber));

      // If final is missing/invalid but we have candidates, fall back to the first valid candidate.
      if (!clueWord && considered.length) {
        clueWord = considered[0].clue;
        clueNumber = (considered[0].number === null || considered[0].number === undefined) ? 1 : considered[0].number;
      }

      const bad =
        (!clueWord) ? 'empty clue' :
        (clueWord.includes(' ') || clueWord.includes('-')) ? 'clue must be one word' :
        (boardWords.includes(clueWord)) ? 'clue is on the board' :
        null;

      if (!bad) break;
      // Write a quick mind note and retry.
      appendMind(ai, `I need to retry: ${bad}. I'll pick a different clue.`);
      clueWord = '';
    }

    if (!clueWord) return;

    // Simulate live thinking/typing visible to opposing spymaster
    await simulateAISpymasterThinking(ai, game, clueWord, clueNumber, { considered });

    const seqField = _aiSeqField(team, 'spy');
    let clueAccepted = false;
    const submitWithReview = window.submitClueForReviewFlow;
    if (typeof submitWithReview === 'function') {
      const result = await submitWithReview({
        game,
        word: clueWord,
        number: clueNumber,
        targets: [],
        targetWords: [],
        byId: String(ai?.odId || ai?.id || '').trim(),
        byName: String(ai?.name || 'AI').trim() || 'AI',
        seqField,
      });
      clueAccepted = !!result?.accepted;
    } else {
      const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
      const clueEntry = {
        team: game.currentTeam,
        word: clueWord,
        number: clueNumber,
        results: [],
        timestamp: new Date().toISOString(),
      };

      const ref = db.collection('games').doc(game.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const current = snap.data();
        if (current.currentPhase !== 'spymaster' || current.currentTeam !== team) return;

        tx.update(ref, {
          currentClue: { word: clueWord, number: clueNumber },
          guessesRemaining: (clueNumber === 0 ? 0 : (clueNumber + 1)),
          currentPhase: 'operatives',
          log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`),
          clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
          [seqField]: firebase.firestore.FieldValue.increment(1),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
        clueAccepted = true;
      });
    }

    if (clueAccepted && window.playSound) window.playSound('clueGiven');
  } catch (err) {
    console.error(`AI ${ai.name} clue error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

// ─── AI Operative: Guess Card ───────────────────────────────────────────────

async function aiGuessCard(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  try {
    // Always use freshest state.
    try {
      const fresh = await getGameSnapshot(game?.id);
      if (fresh && fresh.cards) game = fresh;
    } catch (_) {}
    if (!game || game.winner) return;
    if (String(ai?.mode || '') !== 'autonomous') return;
    if (String(ai?.seatRole || '') !== 'operative') return;
    if (String(game.currentPhase || '') !== 'operatives') return;
    if (String(game.currentTeam || '') !== String(ai?.team || '')) return;

    const core = ensureAICore(ai);
    if (!core) return;

    const team = ai.team;
    const vision = buildAIVision(game, ai); // operative vision (no hidden types)
    const persona = core.personality;
    const markerCtx = buildTeamMarkerContext(game, team, _markerOwnerId(ai.id));

    if (!vision.clue || !vision.clue.word) return;

    const remainingGuesses = Number.isFinite(+game.guessesRemaining) ? +game.guessesRemaining : 0;
    if (remainingGuesses <= 0) return 'end_turn';

    const unrevealed = (vision.cards || []).filter(c => !c.revealed);
    if (!unrevealed.length) return 'end_turn';

    const list = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\n');

    const teamChat = await fetchRecentTeamChat(game.id, team);
    const teamChatContext = teamChat ? `\nRECENT TEAM CHAT:\n${teamChat}` : '';

    const systemPrompt = [
      `You are ${ai.name}.`,
      `You are a Codenames OPERATIVE for the ${String(team || '').toUpperCase()} team.`,
      ``,
      buildPersonalityBlock(persona),
      ``,
      AI_TIPS_MANUAL,
      ``,
      `MIND RULE: The only way you think is by writing in your private inner monologue.`,
      `Return JSON only:`,
      `{"mind":"first-person inner monologue", "action":"guess|end_turn", "index":N, "chat":"optional teammate message (1–2 natural sentences, no indices or "N =" formatting)"}`,
      ``,
      `Hard requirements:`,
      `- If action="guess", index MUST be one of the unrevealed indices shown.`,
      `- Use the clue: "${String(vision.clue.word || '').toUpperCase()}" for ${Number(vision.clue.number || 0)}.`,
      `- You have ${remainingGuesses} guess(es) remaining this turn.`,
      `- React to team markers if they show clear consensus/conflict.`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      ``,
      `UNREVEALED WORDS (choose ONLY from this list):\n${list}`,
      teamChatContext,
      ``,
      markerCtx ? `${markerCtx}` : '',
      ``,
      `RECENT MIND:\n${mindContext}`
    ].join('\n');

    let parsed = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { content: raw, reasoning } = await aiReasoningCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { max_tokens: 360, response_format: { type: 'json_object' } }
      );
      appendReasoningToMind(ai, reasoning);
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
      if (!parsed) continue;

      const mind = String(parsed.mind || '').trim();
      if (mind) appendMind(ai, mind);

      const action = String(parsed.action || '').toLowerCase().trim();
      if (action === 'end_turn') {
        try { await syncAIConsideringState(game.id, team, ai, { action: 'end_turn', marks: [] }); } catch (_) {}
        return 'end_turn';
      }

      const idx = Number(parsed.index);
      const candidate = unrevealed.find(c => c.index === idx);
      if (candidate) {
        const chat = String(parsed.chat || '').trim();
        if (chat) {
          // Keep team chat short and in-character (public), mind stays private.
          await sendAIChatMessage(ai, game, chat.slice(0, 180));
        }
        try {
          await syncAIConsideringState(game.id, team, ai, {
            action: 'guess',
            index: candidate.index,
            marks: [{ index: candidate.index, tag: 'yes' }]
          });
        } catch (_) {}
        const revealResult = await aiRevealCard(ai, game, candidate.index, true);
        if (revealResult?.turnEnded) return 'turn_already_ended';
        return 'continue';
      }
    }

    // Fallback: if parsing failed repeatedly, end turn rather than random-guess.
    appendMind(ai, `I couldn't produce a valid guess JSON. I'll end the turn to avoid chaos.`);
    try { await syncAIConsideringState(game.id, team, ai, { action: 'end_turn', marks: [] }); } catch (_) {}
    return 'end_turn';
  } catch (err) {
    console.error(`AI ${ai.name} guess error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

// Returns { turnEnded: bool } so the caller knows whether the turn already switched.
async function aiRevealCard(ai, game, cardIndex, incrementSeq = false) {
  if (!game || game.winner) return { turnEnded: false };
  if (String(ai?.mode || '') !== 'autonomous') return { turnEnded: false };
  if (String(ai?.seatRole || '') !== 'operative') return { turnEnded: false };
  if (String(game.currentPhase || '') !== 'operatives') return { turnEnded: false };
  if (String(game.currentTeam || '') !== String(ai?.team || '')) return { turnEnded: false };
  const card = game.cards[cardIndex];
  if (!card || card.revealed) return { turnEnded: false };

  const ref = db.collection('games').doc(game.id);
  let turnEnded = false;
  let resultCard = card; // keep reference for post-tx work
  let revealedCommitted = false;
  let clueMeta = null; // { team, word, number }

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const current = snap.data();

      // Abort if game state moved on (stale callback)
      if (current.currentPhase !== 'operatives' || current.currentTeam !== game.currentTeam) return;

      const liveCards = current.cards || [];
      if (!liveCards[cardIndex] || liveCards[cardIndex].revealed) return;

      const liveCard = liveCards[cardIndex];
      const updatedCards = [...liveCards];
      updatedCards[cardIndex] = { ...liveCard, revealed: true };
      resultCard = liveCard;
      clueMeta = {
        team: String(current.currentTeam || ''),
        word: String(current?.currentClue?.word || ''),
        number: Number(current?.currentClue?.number || 0)
      };

      const teamName = current.currentTeam === 'red' ? (current.redTeamName || 'Red Team') : (current.blueTeamName || 'Blue Team');
      const updates = {
        cards: updatedCards,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };

      if (incrementSeq) {
        const seqField = _aiSeqField(current.currentTeam, 'op');
        updates[seqField] = firebase.firestore.FieldValue.increment(1);
      }

      // Consume one guess (standard Codenames: number + 1 total guesses per clue).
      const _gr = Number.isFinite(+current.guessesRemaining) ? +current.guessesRemaining : 0;
      const _nextGr = Math.max(0, _gr - 1);
      updates.guessesRemaining = _nextGr;

      let logEntry = `AI ${ai.name} (${teamName}) guessed "${liveCard.word}" - `;
      let endTurn = false;
      let winner = null;

      if (liveCard.type === 'assassin') {
        winner = current.currentTeam === 'red' ? 'blue' : 'red';
        logEntry += 'ASSASSIN! Game over.';
      } else if (liveCard.type === current.currentTeam) {
        logEntry += 'Correct!';
        if (current.currentTeam === 'red') {
          updates.redCardsLeft = current.redCardsLeft - 1;
          if (updates.redCardsLeft === 0) winner = 'red';
        } else {
          updates.blueCardsLeft = current.blueCardsLeft - 1;
          if (updates.blueCardsLeft === 0) winner = 'blue';
        }

        // If we've used up the last allowed guess (number+1), the turn ends even on a correct guess.
        if (!winner && _nextGr <= 0) {
          logEntry += ' Out of guesses. Turn ends.';
          endTurn = true;
        }
      } else if (liveCard.type === 'neutral') {
        logEntry += 'Neutral. Turn ends.';
        endTurn = true;
      } else {
        logEntry += `Wrong! (${liveCard.type === 'red' ? (current.redTeamName || 'Red') : (current.blueTeamName || 'Blue')}'s card)`;
        if (liveCard.type === 'red') {
          updates.redCardsLeft = current.redCardsLeft - 1;
          if (updates.redCardsLeft === 0) winner = 'red';
        } else {
          updates.blueCardsLeft = current.blueCardsLeft - 1;
          if (updates.blueCardsLeft === 0) winner = 'blue';
        }
        endTurn = true;
      }

      if (winner) {
        updates.winner = winner;
        updates.currentPhase = 'ended';
        updates.timerEnd = null;
        const winnerName = winner === 'red' ? (current.redTeamName || 'Red') : (current.blueTeamName || 'Blue');
        logEntry += ` ${winnerName} wins!`;
        endTurn = true; // treat game-over as turn ended for the caller
      } else if (endTurn) {
        updates.currentTeam = current.currentTeam === 'red' ? 'blue' : 'red';
        updates.currentPhase = 'spymaster';
        updates.currentClue = null;
        updates.guessesRemaining = 0;
        updates.timerEnd = buildPhaseTimerEndForGame(current, 'spymaster');
      }

      updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);
      tx.update(ref, updates);
      turnEnded = endTurn;
      revealedCommitted = true;
    });

    // Update clue history outside the transaction (non-critical)
    if (revealedCommitted && clueMeta?.word) {
      const guessResult = {
        word: resultCard.word,
        result: resultCard.type === 'assassin'
          ? 'assassin'
          : (resultCard.type === clueMeta.team ? 'correct' : (resultCard.type === 'neutral' ? 'neutral' : 'wrong')),
        type: resultCard.type,
        by: ai.name,
        timestamp: new Date().toISOString(),
      };
      await addGuessToClueHistory(game.id, clueMeta.team, clueMeta.word, clueMeta.number, guessResult);
    }

    if (window.playSound) window.playSound('cardReveal');
  } catch (e) {
    console.error(`AI ${ai.name} reveal card error:`, e);
  }

  return { turnEnded };
}

// ─── AI End Turn Decision ───────────────────────────────────────────────────

async function aiConsiderEndTurn(ai, game, forceEnd = false, incrementSeq = false) {
  if (ai.mode !== 'autonomous') return false;
  try {
    const fresh = await getGameSnapshot(game?.id);
    if (fresh && fresh.cards) game = fresh;
  } catch (_) {}
  if (!game || game.winner) return false;
  if (String(ai?.seatRole || '') !== 'operative') return false;
  if (String(game.currentPhase || '') !== 'operatives') return false;
  if (String(game.currentTeam || '') !== String(ai?.team || '')) return false;

  const teamName = game.currentTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');

  // Chat about ending turn (human-like deliberation)
  if (!forceEnd) {
    const endTurnMsg = await generateAIChatMessage(ai, game, 'end_turn_deliberation');
    if (endTurnMsg) await sendAIChatMessage(ai, game, endTurnMsg);
    await humanDelay(AI_SPEED.operativeThinkDelay[0], AI_SPEED.operativeThinkDelay[1]);
  }

  try {
    // Use a transaction to verify the game is still in the expected state.
    // A stale callback from a previous guess may call this after the turn
    // already switched, which would double-switch and send the turn back.
    const ref = db.collection('games').doc(game.id);
    let didEnd = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const current = snap.data();
      // Only end the turn if it's still this team's operatives phase
      if (current.currentPhase !== 'operatives' || current.currentTeam !== game.currentTeam) return;

      const updates = {
  currentTeam: current.currentTeam === 'red' ? 'blue' : 'red',
  currentPhase: 'spymaster',
  currentClue: null,
  guessesRemaining: 0,
  timerEnd: buildPhaseTimerEndForGame(current, 'spymaster'),
  log: firebase.firestore.FieldValue.arrayUnion(`AI ${ai.name} (${teamName}) ended their turn.`),
  updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
};
if (incrementSeq) {
  const seqField = _aiSeqField(current.currentTeam, 'op');
  updates[seqField] = firebase.firestore.FieldValue.increment(1);
}
tx.update(ref, updates);
didEnd = true;
    });

    // Clear AI marks when the turn ends (do NOT touch human tags)
    if (didEnd && game.id && aiCardMarks[game.id]) {
      aiCardMarks[game.id] = {};
      if (typeof renderCardTags === 'function') renderCardTags();
    }
    if (didEnd) {
      try { await syncAIConsideringState(game.id, ai.team, ai, { action: 'end_turn', marks: [] }); } catch (_) {}
    }

    return didEnd;
  } catch (e) {
    console.error(`AI ${ai.name} end turn error:`, e);
    return false;
  }
}

// ─── AI Chat & Reactions ────────────────────────────────────────────────────

function isGreetingLike(text) {
  const s = String(text || '').trim().toLowerCase();
  if (!s) return false;
  return /(?:^|\s)(hi|hey|hello|yo|sup|hiya|howdy|what'?s up|whats up)(?:\s|$|[!?.])/.test(s);
}

function buildFallbackReplyForChat(lastText, senderName = '') {
  const text = String(lastText || '').trim();
  const lower = text.toLowerCase();
  const sender = String(senderName || '').trim();
  const senderShort = sender.replace(/^ai\s+/i, '').split(/\s+/).filter(Boolean)[0] || '';

  if (isGreetingLike(lower)) {
    return senderShort ? `yo ${senderShort}` : _pick(['yo', 'hey', 'sup']);
  }
  if (/\?/.test(text) || /\b(thoughts|what do you think|agree|should we)\b/.test(lower)) {
    return _pick([
      "i'm not sold yet, let's pressure-test another option",
      "not convinced yet, i want one cleaner link first",
      "i disagree for now, that line feels risky"
    ]);
  }
  return _pick([
    "i'm not fully buying that, feels risky",
    "eh i disagree, i think we're forcing it",
    "not sure, i'd rather re-check the clue fit"
  ]);
}

async function generateAIChatMessage(ai, game, context, opts = {}) {
  try {
    // Keep conversational output aligned with the latest board/chat state.
    try {
      const fresh = await getGameSnapshot(game?.id);
      if (fresh && fresh.cards) game = fresh;
    } catch (_) {}

    const core = ensureAICore(ai);
    if (!core) return '';
    if (!game || game.winner) return '';
    const team = ai.team;

    const vision = buildAIVision(game, ai);
    const unrevealed = (vision.cards || []).filter(c => !c.revealed).map(c => String(c.word || '').toUpperCase());
    const teamChat = await fetchRecentTeamChat(game.id, team, 10);
    const lastMessage = (opts && opts.lastMessage) ? String(opts.lastMessage).trim() : '';
    const forceResponse = !!opts.forceResponse;
    const isReplyContext = String(context || '').toLowerCase() === 'reply';

    const persona = core.personality;
    const systemPrompt = [
      `You are ${ai.name}, chatting with teammates during a Codenames game.`,
      buildPersonalityBlockBrief(persona),
      ``,
      `You're texting friends during a board game. Be casual and real.`,
      `- Respond to what the last person actually said. Don't ignore them.`,
      `- Use contractions, casual phrasing. "yeah", "nah", "lol", "ngl", etc.`,
      `- Don't repeat anything that's already been said in the chat.`,
      `- If you'd just be saying something obvious or redundant, set msg="" instead.`,
      `- Do NOT be a yes-man. If an idea seems weak, push back clearly.`,
      `- Avoid agreement-only replies ("yeah", "same", "sounds good"). Add a reason or an alternative.`,
      `- If 2+ people already agreed on a word, do NOT pile on. Set msg="" instead.`,
      `- Redundant enthusiasm is worse than silence. Only speak if you add something new.`,
      isReplyContext ? `- If someone greets you, greet back naturally first.` : '',
      isReplyContext ? `- In replies, react to the latest message and add a distinct angle.` : '',
      `- 1-2 short sentences max. Keep it <=140 chars.`,
      `- Never reference card indices/numbers. Use actual board WORDS only.`,
      `- Don't invent board words — only mention words from the unrevealed list.`,
      `- No formal language. No "I believe", "I suggest", "Additionally".`,
      `Return JSON only: {"mind":"(private thinking)", "msg":"(your message or empty string)"}`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-6).join('\n');
    const userPrompt = [
      `CONTEXT: ${String(context || 'general')}`,
      lastMessage ? `LAST TEAM MESSAGE: ${lastMessage}` : '',
      teamChat ? `RECENT TEAM CHAT:\n${teamChat}` : '',
      `UNREVEALED WORDS:\n${unrevealed.join(', ')}`,
      `VISION:\n${JSON.stringify(vision)}`,
      `RECENT MIND:\n${mindContext}`,
    ].filter(Boolean).join('\n\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: Math.min(1.25, (core.temperature * 1.05) + 0.15), max_tokens: 220, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return '';

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let msg = String(parsed.msg || '').trim();
    msg = sanitizeChatText(msg, vision, 160);
    if (!msg && forceResponse && isReplyContext) {
      const src = String(opts.lastMessageText || lastMessage || '').trim();
      const sender = String(opts.lastSenderName || '').trim();
      msg = buildFallbackReplyForChat(src, sender);
    }
    if (!msg) return '';

    // Basic guard: if message contains a token that matches a board word, ensure it's actually unrevealed.
    // (This is conservative; it will not block general chatter.)
    const upperMsg = msg.toUpperCase();
    for (const w of unrevealed) {
      // allow mentions of legitimate words
      if (upperMsg.includes(w)) return msg.slice(0, 160);
    }
    // If it mentions no unrevealed word, it's fine.
    return msg.slice(0, 160);
  } catch (_) {
    return '';
  }
}

async function generateAIReaction(ai, revealedCard, clue) {
  try {
    const core = ensureAICore(ai);
    if (!core) return '';
    const persona = core.personality;
    const systemPrompt = [
      `You are ${ai.name}, reacting to a card reveal in Codenames.`,
      `PERSONALITY: ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      `React like a friend watching the game. Be specific about what happened.`,
      `- If correct: casual celebration mentioning the word, like "yesss FORK lets go" or "called it"`,
      `- If wrong/neutral: react naturally, like "oof that hurts" or "damn, WORD was neutral"`,
      `- If assassin: "NOOO" type energy`,
      `- Keep it <=100 chars. Be specific, not generic. Don't just say "Nice!" or "Good job!"`,
      `Return JSON only: {"mind":"(private thought)", "msg":"(your reaction)"}`,
    ].join('\n');

    const userPrompt = `Clue: ${clue ? String(clue.word || '') + ' ' + String(clue.number || '') : 'none'}\nRevealed: ${String(revealedCard?.word || '')} (${String(revealedCard?.type || '')})`;

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: Math.min(1.0, core.temperature * 0.75), max_tokens: 160, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return '';

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    const msgRaw = String(parsed.msg || '').trim();
    const msg = sanitizeChatText(msgRaw, null, 120);
    return msg ? msg.slice(0, 120) : '';
  } catch (_) {
    return '';
  }
}


// ─── AI Chat Typing Animation ──────────────────────────────────────────────
// Shows a realistic typing indicator + character-by-character reveal before
// the actual message is persisted. This simulates the same live-typing
// experience that spymasters see for clue drafts.

function _getAIChatTypingSpeed() {
  // Characters per ms — gives a natural feel with variance
  const base = 28 + Math.random() * 32; // 28-60ms per char
  return base;
}

async function _simulateAITyping(aiName, teamColor, text) {
  const container = document.getElementById('operative-chat-messages');
  if (!container || !text) return;

  // Create a typing indicator element
  const typingEl = document.createElement('div');
  typingEl.className = 'chat-message ai-typing-message';
  typingEl.innerHTML = `
    <div class="chat-message-header">
      <span class="chat-sender ${teamColor}">${_escHtml(aiName)}</span>
      <span class="chat-typing-indicator">
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
        <span class="typing-dot"></span>
      </span>
    </div>
    <div class="chat-text ai-typing-text"></div>
  `;
  container.appendChild(typingEl);
  container.scrollTop = container.scrollHeight;

  const textEl = typingEl.querySelector('.ai-typing-text');
  const dotsEl = typingEl.querySelector('.chat-typing-indicator');

  // Show dots for a brief moment before typing starts
  await new Promise(r => setTimeout(r, 400 + Math.random() * 600));

  // Start revealing characters
  if (dotsEl) dotsEl.style.display = 'none';
  let revealed = '';
  for (let i = 0; i < text.length; i++) {
    revealed += text[i];
    if (textEl) textEl.textContent = revealed;

    // Keep scroll pinned to bottom during typing
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
    if (nearBottom) container.scrollTop = container.scrollHeight;

    // Variable delay per character
    let delay = _getAIChatTypingSpeed();
    // Pause slightly longer after punctuation
    if ('.!?,;:'.includes(text[i])) delay += 80 + Math.random() * 120;
    // Speed up for spaces
    if (text[i] === ' ') delay *= 0.5;
    await new Promise(r => setTimeout(r, delay));
  }

  // Brief pause after finishing typing before the "real" message arrives
  await new Promise(r => setTimeout(r, 150 + Math.random() * 250));

  // Remove the typing element — the Firestore snapshot will render the real message
  try { typingEl.remove(); } catch (_) {}
}

function _escHtml(str) {
  const d = document.createElement('div');
  d.textContent = String(str || '');
  return d.innerHTML;
}

async function sendAIChatMessage(ai, game, text, opts = {}) {
  if (!text || !game?.id) return;
  if (String(ai?.seatRole || '').trim().toLowerCase() === 'spymaster') return;

  const force = !!opts.force;
  const originalText = String(text || '').trim();
  const teamColor = ai.team;

  // Make messages feel like real friends (and avoid repetition across AIs)
  try {
    const vision = buildAIVision(game, ai);
    const human = makeChatMoreHuman(ai, game, text, vision, { bypassSimilarity: force });
    text = (human || '').trim();
  } catch (_) {}
  if (!text && force) text = originalText.slice(0, 180);
  if (!text) return;

  // Extra: avoid the *same AI* paraphrasing itself over and over.
  try {
    const core = ensureAICore(ai);
    const prev = (core && Array.isArray(core.recentChat)) ? core.recentChat : [];
    const selfTooSimilar = prev.slice(-6).some(r => _jaccard(r, text) > 0.28);
    if (selfTooSimilar && !force) return;
    if (core) {
      if (!Array.isArray(core.recentChat)) core.recentChat = [];
      core.recentChat.push(String(text));
      if (core.recentChat.length > 20) core.recentChat = core.recentChat.slice(-12);
    }
  } catch (_) {}

  // Simulate typing animation before sending the actual message
  try {
    await _simulateAITyping(`AI ${ai.name}`, teamColor, text);
  } catch (_) {}

  try {
    await db.collection('games').doc(game.id)
      .collection(`${teamColor}Chat`)
      .add({
        senderId: ai.odId,
        senderName: `AI ${ai.name}`,
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

    // Remember the last few messages so we can de-dup future replies.
    try {
      const gid = String(game.id);
      const t = String(teamColor);
      if (!aiChatMemory[gid]) aiChatMemory[gid] = {};
      if (!aiChatMemory[gid][t]) aiChatMemory[gid][t] = [];
      aiChatMemory[gid][t].push(String(text));
      if (aiChatMemory[gid][t].length > 18) aiChatMemory[gid][t] = aiChatMemory[gid][t].slice(-12);
    } catch (_) {}
  } catch (e) {
    console.error(`AI ${ai.name} send chat error:`, e);
  }
}

// Lightweight conversational replies (texting vibes) so the AI can react to humans/other AIs.
async function maybeAIRespondToTeamChat(ai, game) {
  let locked = false;
  try {
    if (!ai || !game?.id) return false;
    if (String(ai?.seatRole || '') !== 'operative') return false;
    if (aiThinkingState[ai.id]) return false;

    // Keep replies grounded in the latest game state.
    try {
      const freshGame = await getGameSnapshot(game?.id);
      if (freshGame && freshGame.cards) game = freshGame;
    } catch (_) {}
    if (!game || game.winner) return false;

    const now = Date.now();
    const lastReply = Number(aiLastChatReplyMs[ai.id] || 0);
    // Keep responses fast but non-spammy.
    if (now - lastReply < 8000) return false;

    const msgs = await fetchRecentTeamChatDocs(game.id, ai.team, 14);
    if (!msgs || !msgs.length) return false;

    const newest = Math.max(...msgs.map(m => Number(m.createdAtMs || 0)));
    const lastSeen = Number(aiLastChatSeenMs[ai.id] || 0);
    // On first run, only consider very recent messages so we don't respond to stale history.
    const baseline = lastSeen > 0 ? lastSeen : Math.max(0, newest - 15000);

    // Find new messages not from this AI.
    const fresh = msgs.filter(m => (
      Number(m.createdAtMs || 0) > baseline &&
      String(m.senderId || '') !== String(ai.odId || '')
    ));
    aiLastChatSeenMs[ai.id] = Math.max(lastSeen, newest);
    if (!fresh.length) return false;

    const last = fresh[fresh.length - 1];
    const text = String(last.text || '').trim();
    if (!text) return false;

    const lower = text.toLowerCase();
    const senderId = String(last.senderId || '').toLowerCase();
    const senderName = String(last.senderName || '').trim();
    const senderIsAI = /^ai\b/i.test(senderName) || senderId.startsWith('ai');
    const nameHit = ai.name ? lower.includes(String(ai.name).toLowerCase()) : false;
    const directHit = nameHit || /\b(ai|bot)\b/.test(lower);
    const question = /\?/.test(text) || /\b(thoughts|what do you think|agree|should we)\b/.test(lower);
    const greeting = isGreetingLike(text);

    let shouldReply = false;
    if (directHit || question || greeting) shouldReply = true;
    else if (senderIsAI) shouldReply = Math.random() < 0.55;
    else shouldReply = Math.random() < 0.72;

    if (!shouldReply) return false;

    aiThinkingState[ai.id] = true;
    locked = true;
    await humanDelay(500, 1200);

    const forceResponse = !!(directHit || question || greeting);
    let reply = await generateAIChatMessage(ai, game, 'reply', {
      lastMessage: `${senderName}: ${text}`,
      lastMessageText: text,
      lastSenderName: senderName,
      forceResponse
    });

    if (!reply && forceResponse) {
      reply = buildFallbackReplyForChat(text, senderName);
    }

    if (reply) {
      await sendAIChatMessage(ai, game, reply, { force: forceResponse });
      aiLastChatReplyMs[ai.id] = Date.now();
      return true;
    }
    return false;
  } catch (_) {
    // don't crash the main loop
    return false;
  } finally {
    if (locked) aiThinkingState[ai.id] = false;
  }
}

function buildMarkerReactionMessage(ai, markerRows = [], selfOwner = '') {
  try {
    const rows = (Array.isArray(markerRows) ? markerRows : []).filter(Boolean);
    if (!rows.length) return '';
    const row = rows[0];
    if (!row || !row.word) return '';

    const others = (row.byOwner || []).filter(x => String(x.owner || '') !== String(selfOwner || ''));
    const otherYes = others.filter(x => x.tag === 'yes').length;
    const otherMaybe = others.filter(x => x.tag === 'maybe').length;
    const otherNo = others.filter(x => x.tag === 'no').length;

    if (otherYes >= 2 && otherNo === 0) {
      return _pick([
        `${row.word} has a strong yes stack, but i'm checking downside before we slam it`,
        `seeing multiple yes tags on ${row.word}; i get it, just sanity-checking risk first`
      ]);
    }
    if (otherNo >= 2 && otherYes === 0) {
      return _pick([
        `${row.word} getting hard-no tags tracks, that one feels shaky`,
        `i'm with the no stack on ${row.word}, clue fit looks weak`
      ]);
    }
    if (otherYes > 0 && otherNo > 0) {
      return _pick([
        `markers are split on ${row.word}; i'm not convinced either side yet`,
        `${row.word} is mixed yes/no right now, i'd rather verify clue fit first`
      ]);
    }
    if (otherMaybe >= 2 && otherYes === 0 && otherNo === 0) {
      return _pick([
        `${row.word} sitting in maybe-pile, feels fair for now`,
        `yep ${row.word} as maybe makes sense, still ambiguous`
      ]);
    }
    return '';
  } catch (_) {
    return '';
  }
}

async function maybeAIReactToTeamMarkers(ai, game) {
  let locked = false;
  try {
    if (!ai || !game?.id) return false;
    if (String(ai?.mode || '') !== 'autonomous') return false;
    if (String(ai?.seatRole || '') !== 'operative') return false;
    if (String(game?.currentPhase || '') !== 'operatives') return false;
    if (String(game?.currentTeam || '') !== String(ai?.team || '')) return false;
    if (aiThinkingState[ai.id]) return false;

    const core = ensureAICore(ai);
    if (!core) return false;

    const rows = extractTeamMarkersForVision(game, ai.team);
    const selfOwner = _markerOwnerId(ai.id);
    const otherRows = rows.filter(r => (r.byOwner || []).some(x => String(x.owner || '') !== selfOwner));
    const markerSig = otherRows
      .map(r => `${r.index}:${r.counts.yes},${r.counts.maybe},${r.counts.no}`)
      .join('|');
    if (!markerSig) return false;
    if (core.lastMarkerReactionSig === markerSig) return false;

    const now = Date.now();
    const lastAt = Number(core.lastMarkerReactionAt || 0);
    if (now - lastAt < 9000) return false;

    const msg = buildMarkerReactionMessage(ai, otherRows, selfOwner);
    core.lastMarkerReactionSig = markerSig;
    if (!msg) return false;

    aiThinkingState[ai.id] = true;
    locked = true;
    await humanDelay(300, 900);
    await sendAIChatMessage(ai, game, msg, { force: true });
    core.lastMarkerReactionAt = Date.now();
    aiLastChatReplyMs[ai.id] = core.lastMarkerReactionAt;
    return true;
  } catch (_) {
    return false;
  } finally {
    if (locked) aiThinkingState[ai.id] = false;
  }
}

function offTurnScoutKey(game, ai) {
  const g = game || {};
  const clueWord = String(g?.currentClue?.word || '').trim().toUpperCase();
  const clueNum = Number(g?.currentClue?.number || 0);
  const sig = Array.isArray(g.cards) ? g.cards.map(c => c && c.revealed ? '1' : '0').join('') : '';
  return `${String(g.id || '')}:${String(ai?.team || '')}:${String(g.currentTeam || '')}:${String(g.currentPhase || '')}:${clueWord}_${clueNum}:${sig}`;
}

async function aiOffTurnScout(ai, game) {
  try {
    if (!ai || !game?.id) return false;
    if (String(ai.mode || '') !== 'autonomous') return false;
    if (String(ai.seatRole || '') !== 'operative') return false;
    if (String(game.currentPhase || '') !== 'operatives') return false;
    if (!game.currentClue || !String(game.currentClue.word || '').trim()) return false;
    if (String(ai.team || '') === String(game.currentTeam || '')) return false;
    if (aiThinkingState[ai.id]) return false;

    const now = Date.now();
    const last = Number(aiLastOffTurnScoutMs[ai.id] || 0);
    if (now - last < 12000) return false;

    const core = ensureAICore(ai);
    if (!core) return false;

    const key = offTurnScoutKey(game, ai);
    if (core.lastOffTurnScoutKey === key) return false;

    const vision = buildAIVision(game, ai);
    const clueWord = String(vision?.clue?.word || '').trim().toUpperCase();
    if (!clueWord) return false;

    const unrevealed = (vision.cards || []).filter(c => !c.revealed);
    if (!unrevealed.length) return false;
    const wordsList = unrevealed.map(c => `- ${c.index}: ${String(c.word || '').toUpperCase()}`).join('\n');
    const opponent = String(game.currentTeam || '').toLowerCase() === 'red' ? 'RED' : 'BLUE';

    aiThinkingState[ai.id] = true;

    const systemPrompt = [
      `You are ${ai.name}, an OPERATIVE on ${String(ai.team || '').toUpperCase()} team in Codenames.`,
      `It is NOT your team's turn right now. Opponent (${opponent}) gave clue "${clueWord}" for ${Number(vision?.clue?.number || 0)}.`,
      `IMPORTANT RULE: you may chat only. Do NOT make card marks or any game actions off-turn.`,
      `Optional chat should be one short casual sentence. If nothing useful, chat="".`,
      `Never mention confidence scores.`,
      `Return JSON only: {"mind":"2-6 lines first-person thinking","chat":"short optional message"}`,
    ].join('\n');

    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      ``,
      `UNREVEALED WORDS:\n${wordsList}`,
      ``,
      `Focus on the opponent clue and likely opponent targets.`,
    ].join('\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: Math.min(1.0, core.temperature * 0.9), max_tokens: 300, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
    if (!parsed) {
      core.lastOffTurnScoutKey = key;
      aiLastOffTurnScoutMs[ai.id] = Date.now();
      return false;
    }

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = sanitizeChatText(String(parsed.chat || '').trim(), vision, 140);
    if (chat && (Math.random() < 0.72)) {
      await sendAIChatMessage(ai, game, chat);
    }

    core.lastOffTurnScoutKey = key;
    aiLastOffTurnScoutMs[ai.id] = Date.now();
    return true;
  } catch (_) {
    return false;
  } finally {
    if (ai && ai.id) aiThinkingState[ai.id] = false;
  }
}

// ─── AI Role Selection ──────────────────────────────────────────────────────

async function aiSelectRole(ai, game) {
  if (ai.seatRole !== 'spymaster') return;

  const team = ai.team;
  const spymasterKey = team === 'red' ? 'redSpymaster' : 'blueSpymaster';
  const currentSpymaster = game[spymasterKey];

  if (currentSpymaster) return; // Already assigned

  const updates = {
    [spymasterKey]: ai.name,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  // Check if both spymasters will be assigned
  const otherKey = team === 'red' ? 'blueSpymaster' : 'redSpymaster';
  const otherSpymaster = game[otherKey];
  if (otherSpymaster) {
    updates.currentPhase = 'spymaster';
    updates.timerEnd = buildPhaseTimerEndForGame(game, 'spymaster');
    updates.log = firebase.firestore.FieldValue.arrayUnion('Game started! Red team goes first.');
  }

  try {
    await db.collection('games').doc(game.id).update(updates);
  } catch (e) {
    console.error(`AI ${ai.name} role selection error:`, e);
  }
}

// ─── Game Snapshot Helper ───────────────────────────────────────────────────

async function getGameSnapshot(gameId) {
  try {
    const snap = await db.collection('games').doc(gameId).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  } catch (e) {
    return null;
  }
}

// ─── Timing / pacing ───────────────────────────────────────────────────────

// We keep gameplay responsive, but when multiple AIs are collaborating we add
// short "processing" pauses so they can read each other’s messages/markers
// before acting. These are functional coordination pauses, not "human acting".

const AI_SPEED = { spymasterDelay:[0,0], operativeThinkDelay:[0,0], operativeChatDelay:[0,0], betweenGuessesDelay:[0,0], idleLoopDelayMs: 250 };

const AI_COUNCIL_PACE = {
  betweenSpeakersMs: 650,  // pause after a teammate message/marker so others can read it
  beforeDecisionMs: 900,   // pause after all proposals before executing an action
};

function sleep(ms) { return new Promise(r => setTimeout(r, Math.max(0, ms|0))); }

// Legacy helper (kept for compatibility with older call sites)
function humanDelay() { return Promise.resolve(); }

// ─── Master AI Game Loop ────────────────────────────────────────────────────

let aiGameLoopRunning = false;
let aiGameLoopInterval = null;

function startAIGameLoop() {
  if (aiGameLoopRunning) return;
  aiGameLoopRunning = true;

  aiGameLoopInterval = setInterval(async () => {
    // Get fresh game state
    const gameId = currentGame?.id;
    if (!gameId) return;

    const game = await getGameSnapshot(gameId);

    // Keep AI list synced from the game doc so every client can host them.
    syncAIPlayersFromGame(game);

    if (!aiPlayers.length) return;

    // Only one client should drive AI actions to avoid duplicate moves.
    const amController = await maybeHeartbeatAIController(gameId, game);
    if (!amController) return;
    if (!game || game.winner) {
      // Stop autonomous actions once the game is decided.
      stopAIGameLoop();
      return;
    }

    // Conversational listening: scan a few candidates each tick and let one reply.
    // Reply throttling stays inside maybeAIRespondToTeamChat.
    const chatCandidates = (aiPlayers || [])
      .filter(a => a && a.mode === 'autonomous' && String(a.seatRole || '') === 'operative')
      .sort((a, b) => Number(aiLastChatReplyMs[a.id] || 0) - Number(aiLastChatReplyMs[b.id] || 0));
    for (const candidate of chatCandidates.slice(0, 3)) {
      const replied = await maybeAIRespondToTeamChat(candidate, game);
      if (replied) break;
    }

    // Role selection phase
    if (game.currentPhase === 'role-selection') {
      for (const ai of aiPlayers) {
        if (ai.seatRole === 'spymaster' && !aiThinkingState[ai.id]) {
          await humanDelay(1000, 3000);
          await aiSelectRole(ai, game);
        }
      }
      return;
    }

    const currentTeam = game.currentTeam;

    // Off-turn chatter only: waiting-team operatives can discuss while waiting,
    // but they are blocked from card marks and other game actions.
    if (game.currentPhase === 'operatives' && game.currentClue && Math.random() < 0.68) {
      const waitingOps = (aiPlayers || []).filter(a =>
        a &&
        a.mode === 'autonomous' &&
        a.seatRole === 'operative' &&
        String(a.team || '') !== String(currentTeam || '')
      );
      if (waitingOps.length) {
        const scout = waitingOps[Math.floor(Math.random() * waitingOps.length)];
        await aiOffTurnScout(scout, game);
      }
    }


    // Spymaster phase
    if (game.currentPhase === 'spymaster') {
      if (hasBlockingPendingClueReview(game)) return;
      const spies = (getAISpymasters(currentTeam) || []).filter(a => a && a.mode === 'autonomous');
      if (!spies.length) return;
      if (spies.length === 1) {
        const aiSpy = spies[0];
        if (!aiThinkingState[aiSpy.id]) await aiGiveClue(aiSpy, game);
      } else {
        await runSpymasterCouncil(game, currentTeam);
      }
      return;
    }

    // Operatives phase
    if (game.currentPhase === 'operatives') {
      // Marker chatter: react when teammate marker consensus/conflicts shift.
      const markerCandidates = (getAIOperatives(currentTeam) || [])
        .filter(a => a && a.mode === 'autonomous')
        .sort((a, b) => {
          const ac = ensureAICore(a);
          const bc = ensureAICore(b);
          return Number(ac?.lastMarkerReactionAt || 0) - Number(bc?.lastMarkerReactionAt || 0);
        });
      for (const candidate of markerCandidates.slice(0, 2)) {
        const reacted = await maybeAIReactToTeamMarkers(candidate, game);
        if (reacted) break;
      }

      const ops = (getAIOperatives(currentTeam) || []).filter(a => a && a.mode === 'autonomous');
      if (!ops.length) return;
      if (ops.length === 1) {
        const actor = ops[0];
        if (aiThinkingState[actor.id]) return;
        const result = await aiGuessCard(actor, game);
        if (result === 'end_turn') await aiConsiderEndTurn(actor, game, true, true);
      } else {
        await runOperativeCouncil(game, currentTeam);
      }
      return;
    }
  }, 2800); // Check every ~3 seconds (slower for coordination)
}

function stopAIGameLoop() {
  if (aiGameLoopInterval) {
    clearInterval(aiGameLoopInterval);
    aiGameLoopInterval = null;
  }
  aiGameLoopRunning = false;
  aiThinkingState = {};
}

// ─── AI Game Start Chat ─────────────────────────────────────────────────────

async function aiGameStartChat() {
  for (const ai of aiPlayers) {
    if (ai.mode === 'autonomous' && ai.seatRole !== 'spymaster') {
      await humanDelay(2000, 6000);
      const msg = await generateAIChatMessage(ai, currentGame, 'start');
      if (msg && currentGame) await sendAIChatMessage(ai, currentGame, msg);
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────────

function cleanupAllAI() {
  stopAIGameLoop();
  // Clear all intervals and timers
  for (const id of Object.keys(aiIntervals)) {
    clearInterval(aiIntervals[id]);
  }
  for (const id of Object.keys(aiChatTimers)) {
    clearTimeout(aiChatTimers[id]);
  }
  aiIntervals = {};
  aiChatTimers = {};
  aiLastOffTurnScoutMs = {};
  aiThinkingState = {};
}

// ─── Expose Globals ─────────────────────────────────────────────────────────
window.addAIPlayer = addAIPlayer;
window.removeAIPlayer = removeAIPlayer;
window.removeAllAIs = removeAllAIs;
window.startAIGameLoop = startAIGameLoop;
window.stopAIGameLoop = stopAIGameLoop;
window.aiPlayers = aiPlayers;
window.aiGameStartChat = aiGameStartChat;
window.cleanupAllAI = cleanupAllAI;
window.getAIPlayerByOdId = getAIPlayerByOdId;
window.countAIsOnTeam = countAIsOnTeam;
window.AI_CONFIG = AI_CONFIG;
window.aiCardMarks = aiCardMarks;
window.aiMarkCard = aiMarkCard;
window.aiSpymasterPropose = aiSpymasterPropose;
window.aiSpymasterFollowup = aiSpymasterFollowup;
window.chooseSpymasterClue = chooseSpymasterClue;
window.aiSpymasterCouncilSummary = aiSpymasterCouncilSummary;
window.aiOperativePropose = aiOperativePropose;
window.aiOperativeFollowup = aiOperativeFollowup;
window.chooseOperativeAction = chooseOperativeAction;
window.aiOperativeCouncilSummary = aiOperativeCouncilSummary;
