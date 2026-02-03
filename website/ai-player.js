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
  apiKey: 'v1.CmMKHHN0YXRpY2tleS1lMDBtdno4YzAxNzRzeWtieHESIXNlcnZpY2VhY2NvdW50LWUwMGJmc2NmMmtjeDRjYno2dzIMCPHW-ssGEPLRz6ICOgsI8dmSlwcQwKbSEUACWgNlMDA.AAAAAAAAAAGvlRuUlCiFAR9lWbGIsK13dOFriMIzHQb9K_wnGyZNYotQJ7XH5mhm_69XgJmjSjpGblyuhw4f2fnX-x45cswK',
  model: 'meta-llama/Llama-3.3-70B-Instruct',
  maxAIsPerTeam: 4,
};

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

const AI_PERSONALITY_POOL = [
  {
    key: "methodical_analyst",
    label: "Methodical Analyst",
    rules: [
      "Speaks in calm, structured sentences.",
      "Prefers careful elimination and explicit reasoning.",
      "Avoids hype; focuses on evidence."
    ]
  },
  {
    key: "bold_associator",
    label: "Bold Associator",
    rules: [
      "Makes creative links, but still respects the board.",
      "Enjoys clever shortcuts and strong thematic clues.",
      "Keeps momentum; avoids overthinking."
    ]
  },
  {
    key: "minimalist_pragmatist",
    label: "Minimalist Pragmatist",
    rules: [
      "Short, practical messages.",
      "Prefers clarity and common-sense links.",
      "Stops early rather than gamble."
    ]
  },
  {
    key: "coach_leader",
    label: "Coach Leader",
    rules: [
      "Encouraging, collaborative tone.",
      "Talks like a teammate coordinating the group.",
      "Summarizes options and recommends a plan."
    ]
  },
  {
    key: "dry_humor",
    label: "Dry Humor",
    rules: [
      "Occasional dry jokes, never distracting.",
      "Keeps messages short and confident.",
      "Still prioritizes correctness."
    ]
  }
];

function randomTemperature() {
  // Keep within a productive range: not too deterministic, not too chaotic.
  const min = 0.35, max = 1.15;
  return Math.round((min + Math.random() * (max - min)) * 100) / 100;
}

function randomPersonality() {
  return AI_PERSONALITY_POOL[Math.floor(Math.random() * AI_PERSONALITY_POOL.length)];
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

// Build what an AI can "see" on screen, based on its role.
function buildAIVision(game, ai) {
  const role = (ai?.seatRole === 'spymaster') ? 'spymaster' : 'operative';
  const team = String(ai?.team || '');
  const phase = String(game?.currentPhase || '');
  const currentTeam = String(game?.currentTeam || '');
  const clue = game?.currentClue ? { word: String(game.currentClue.word || ''), number: Number(game.currentClue.number || 0) } : null;
  const guessesRemaining = Number.isFinite(+game?.guessesRemaining) ? +game.guessesRemaining : null;

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

  const log = Array.isArray(game?.log) ? game.log.slice(-25) : [];

  return {
    role, team, phase, currentTeam, clue, guessesRemaining,
    score,
    cards,
    log,
    ui: {
      redTeamName: String(game?.redTeamName || 'Red Team'),
      blueTeamName: String(game?.blueTeamName || 'Blue Team'),
    }
  };
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
      `You are ${ai.name}.`,
      `Role: ${vision.role}. Team: ${vision.team}.`,
      `Personality: ${persona.label}. Rules you must follow strictly:`,
      ...persona.rules.map(r => `- ${r}`),
      ``,
      `You are inside your private MIND. The only way you think is by WRITING. Write 1–4 short lines of first-person inner monologue.`,
      `Requirements:`,
      `- First person ("I").`,
      `- Mention what I notice in the current vision and what I plan to do next.`,
      `- You may include tiny to-do bullets.`,
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
        appendMind(ai, `I notice the board changed. Phase=${vision.phase}, turn=${String(vision.currentTeam || '').toUpperCase()}, clue=${vision.clue ? (String(vision.clue.word || '').toUpperCase() + ' ' + vision.clue.number) : 'none'}. I will re-evaluate.`);

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
    personality: randomPersonality(),
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

async function setTeamMarkerInFirestore(gameId, team, cardIndex, tag) {
  try {
    if (!gameId) return;
    const ref = db.collection('games').doc(String(gameId));
    const field = (team === 'red') ? 'redMarkers' : 'blueMarkers';
    const keyPath = `${field}.${Number(cardIndex)}`;
    if (!tag || tag === 'clear') {
      await ref.update({ [keyPath]: firebase.firestore.FieldValue.delete() });
    } else {
      const t = String(tag).toLowerCase();
      if (!['yes','maybe','no'].includes(t)) return;
      await ref.update({ [keyPath]: t });
    }
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

    s = s.replace(/\s{2,}/g, ' ').trim();
    if (!s) return '';
    return s.slice(0, maxLen);
  } catch (_) {
    return String(text || '').trim().slice(0, maxLen);
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
      `You are ${ai.name}. You are a Codenames ${String(role || '').toUpperCase()} for ${String(ai.team).toUpperCase()}.`,
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      '',
      `You are inside your private MIND. The only way you think is by writing.`,
      `You had drafted a message, but NEW teammate messages arrived before you sent it.`,
      `Update your thinking and rewrite what you'll say.`,
      `Return JSON only: {"mind":"2-6 lines first-person", "msg":"1-2 natural sentences", "send":true|false}`,
      `Rules:`,
      `- Think first, then speak (mind before msg).`,
      `- NEVER reference indices/numbers or write "N = WORD". Use board WORDS.`,
      `- It's okay to change your mind; if your draft is now redundant, set send=false.`,
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
  const requireChat = !!opts.requireChat;
  const requireMarks = !!opts.requireMarks;
  const councilSize = Number(opts.councilSize || 0);


  if (!vision.clue || !vision.clue.word) return null;

  const remainingGuesses = Number.isFinite(+game.guessesRemaining) ? +game.guessesRemaining : 0;
  const unrevealed = (vision.cards || []).filter(c => !c.revealed);
  if (!unrevealed.length) return null;

  const list = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\\n');

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-10).map(m => `${m.senderName}: ${m.text}`).join('\\n');

  const systemPrompt = [
    `You are ${ai.name}. You are a Codenames OPERATIVE for ${String(team).toUpperCase()}.`,
    `PERSONALITY (follow strictly): ${persona.label}`,
    ...persona.rules.map(r => `- ${r}`),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `You are inside your private MIND. The only way you think is by writing.`,
    `Task: propose a coordinated plan for this turn (guess or end turn), and optionally place 1–3 markers to help teammates.`,
    `Return JSON only with this schema:`,
    `{"mind":"first-person inner monologue (2-8 lines)", "action":"guess|end_turn", "index":N, "confidence":0.0-1.0, "marks":[{"index":N,"tag":"yes|maybe|no"}], "chat":"teammate message (required when councilSize>=2)"}`,
    ``,
    `Hard requirements:`,
    `- If action="guess", index MUST be one of the unrevealed indices shown.`,
    `- Use clue: "${String(vision.clue.word || '').toUpperCase()}" for ${Number(vision.clue.number || 0)}.`,
    `- You have ${remainingGuesses} guess(es) remaining.`,
    `- marks must reference unrevealed indices.`,
    `- chat must be 1–2 natural sentences like a human teammate (no robotic fragments).`,
    `- In chat, NEVER reference card indices/numbers (e.g., do not write "13 = ..."). Refer to board WORDS instead.`,
    `- If you propose ending the turn, say why and ask teammates if they're good to end (team agreement is strongly recommended).`,
    `- Read TEAM CHAT below and respond to what others said. If a teammate suggested a plan/word, it's strongly recommended to acknowledge it (by name or paraphrase) before proposing your own.`,
    `- Your chat should feel like a quick back-and-forth; don't speak into a void.`,
    `- Think first, then speak: write your MIND before your chat message.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-10).join('\n');
  const userPrompt = [
    `VISION:\n${JSON.stringify(vision)}`,
    ``,
    `UNREVEALED WORDS (choose ONLY from this list):\n${list}`,
    ``,
    `TEAM CHAT (latest messages, read & respond):\n${teamChat}`,
    ``,
    `RECENT MIND:\n${mindContext}`
  ].join('\n');

  const raw = await aiChatCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { temperature: core.temperature, max_tokens: 360, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return null;

  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);

  const action = String(parsed.action || '').toLowerCase().trim();
  const idx = Number(parsed.index);
  const conf = Math.max(0, Math.min(1, Number(parsed.confidence)));
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

  // If we are coordinating with teammates, prefer always sending something human-readable.
  if (!chat && requireChat) {
    if (action === 'guess' && candidate) chat = `Leaning ${String(candidate.word || '').toUpperCase()}—feels like it fits ${String(vision.clue.word || '').toUpperCase()}.`;
    else chat = `I'm not seeing a safe guess—are we all good to end here?`;
  }
  chat = chat.slice(0, 180);

  if (action === 'end_turn') {
    return { ai, action: 'end_turn', index: null, confidence: conf || 0.0, marks, chat };
  }
  if (action === 'guess' && candidate) {
    return { ai, action: 'guess', index: candidate.index, confidence: Number.isFinite(conf) ? conf : 0.55, marks, chat };
  }

  // If invalid, default safe.
  return { ai, action: 'end_turn', index: null, confidence: 0.0, marks, chat: chat || '' };
}

function chooseOperativeAction(proposals, game, councilSize) {
  const ps = (proposals || []).filter(Boolean);
  const n = Number.isFinite(+councilSize) && +councilSize > 0 ? +councilSize : ps.length;
  if (!ps.length) return { action: 'end_turn', index: null };

  // Count guess consensus
  const byIndex = new Map();
  for (const p of ps) {
    if (p.action !== 'guess' || p.index === null || p.index === undefined) continue;
    const k = p.index;
    const cur = byIndex.get(k) || { sum: 0, n: 0, max: 0 };
    const c = Number.isFinite(+p.confidence) ? +p.confidence : 0.55;
    cur.sum += c; cur.n += 1; cur.max = Math.max(cur.max, c);
    byIndex.set(k, cur);
  }

  const endVotes = ps.filter(p => p.action === 'end_turn').length;

  // Best guess by (avg confidence + consensus bonus)
  let best = null;
  for (const [idx, v] of byIndex.entries()) {
    const avg = v.sum / Math.max(1, v.n);
    const score = avg + (0.14 * v.n) + (0.06 * v.max);
    if (!best || score > best.score) best = { index: idx, score, avg, n: v.n };
  }

  // Ending early is allowed, but we bias against "silent" bails when there is a decent shared guess.
  // This is intentionally a soft heuristic (not a hard rule).
  if (endVotes > 0) {
    if (!best) return { action: 'end_turn', index: null };
    // If the team doesn't converge and confidence is low, ending is reasonable.
    if (best.avg < 0.56 && best.n < 2) return { action: 'end_turn', index: null };
    // Otherwise, prefer taking the shared guess.
  }

  if (!best) return { action: 'end_turn', index: null };

  // Threshold to guess: either decent avg confidence, or at least 2 AIs align.
  if (best.avg < 0.55 && best.n < 2) return { action: 'end_turn', index: null };
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
      const c = Number.isFinite(+p.confidence) ? Math.round(+p.confidence * 100) : 0;
      return `- ${String(p.ai?.name || 'AI')}: guess ${w} (~${c}%)`;
    }
    return `- ${String(p.ai?.name || 'AI')}: end turn`;
  }).join('\n');

  const decided = (decision?.action === 'guess' && Number.isFinite(+decision.index))
    ? `GUESS ${idxToWord.get(Number(decision.index)) || 'UNKNOWN'}`
    : 'END TURN';

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-8).map(m => `${m.senderName}: ${m.text}`).join('\n');

  const systemPrompt = [
    `You are ${ai.name}. You are a Codenames OPERATIVE for ${String(ai.team).toUpperCase()}.`,
    `PERSONALITY (follow strictly): ${persona.label}`,
    ...persona.rules.map(r => `- ${r}`),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `You are inside your private MIND. The only way you think is by writing.`,
    `Task: write a brief wrap-up message to teammates that reflects the discussion and the final plan.`,
    `This is a FOLLOW-UP message; it's okay if you already spoke earlier this turn.`,
    `Return JSON only: {"mind":"2-6 lines first-person", "chat":"1-2 natural sentences"}`,
    `Guidance (strongly recommended):`,
    `- Respond to what teammates suggested (agree/disagree + why) in a human way.`,
    `- If the plan is END TURN, ask if anyone strongly objects or sees a safer pick.`,
    `- Never reference card indices/numbers or write "N = WORD". Use board WORDS.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-8).join('\n');
  const userPrompt = [
    `VISION:\n${JSON.stringify(vision)}`,
    ``,
    `TEAM CHAT (latest):\n${teamChat}`,
    ``,
    `TEAM PROPOSALS:\n${proposalLines || '(none)'}`,
    ``,
    `FINAL PLAN: ${decided}`,
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
        const c = Number.isFinite(+p.confidence) ? Math.round(+p.confidence * 100) : 0;
        return `- ${String(p.ai?.name || 'AI')}: guess ${w} (~${c}%)`;
      }
      return `- ${String(p.ai?.name || 'AI')}: end turn`;
    }).join('\n');

    const systemPrompt = [
      `You are ${ai.name}. You are a Codenames OPERATIVE for ${String(team).toUpperCase()}.`,
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      '',
      AI_TIPS_MANUAL,
      '',
      `You are inside your private MIND. The only way you think is by writing.`,
      `Task: optionally add another short teammate message to coordinate. You may also revise YOUR suggested action.`,
      `This is a live conversation: if a teammate said something new, react to it.`,
      `Return JSON only:`,
      `{"mind":"2-8 lines first-person", "chat":"(optional) 1-2 natural sentences", "action":"guess|end_turn|no_change", "index":N, "confidence":0.0-1.0, "marks":[{"index":N,"tag":"yes|maybe|no"}], "continue":true|false}`, 
      `Guidance (strongly recommended):`,
      `- Think first, then speak (mind before chat).`,
      `- If you speak, keep it natural and responsive (not a monologue).`,
      `- NEVER reference card indices/numbers or write "N = WORD". Use board WORDS.`,
      `- If you propose ending, it's strongly recommended to invite teammate agreement.`,
      `- If you have nothing new, set chat="" and continue=false.`,
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
      `TEAM CHAT (latest):\n${teamChat}`,
      '',
      `CURRENT TEAM LEANS:\n${proposalLines || '(none)'}`,
      '',
      myPrevLine,
      '',
      `UNREVEALED WORDS (for any mentions):\n${unrevealed.join(', ')}`,
      '',
      `RECENT MIND:\n${mindContext}`,
    ].join('\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: core.temperature, max_tokens: 360, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return null;

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = String(parsed.chat || '').trim();
    chat = sanitizeChatText(chat, vision, 180);

    const action = String(parsed.action || 'no_change').toLowerCase().trim();
    const idx = Number(parsed.index);
    const conf = Math.max(0, Math.min(1, Number(parsed.confidence)));
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

    const out = { ai, chat, marks, continue: cont };
    if (action === 'guess' || action === 'end_turn') {
      if (action === 'guess' && unrevealedIdx.has(idx)) {
        out.action = 'guess';
        out.index = idx;
        out.confidence = Number.isFinite(conf) ? conf : 0.55;
      } else if (action === 'end_turn') {
        out.action = 'end_turn';
        out.index = null;
        out.confidence = Number.isFinite(conf) ? conf : 0.0;
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function runOperativeCouncil(game, team) {
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

    const chatBefore = await getTeamChatState(game.id, team, 14);

    aiThinkingState[ai.id] = true;
    try {
      const prop = await aiOperativePropose(ai, working, {
        requireChat: ops.length >= 2,
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

      // Share markers (team-visible) and short chat to coordinate
      const existingMarkers = (team === 'red') ? (working.redMarkers || {}) : (working.blueMarkers || {});
      for (const m of (prop?.marks || [])) {
        const cur = String(existingMarkers?.[String(m.index)] || existingMarkers?.[m.index] || '').toLowerCase();
        if (cur !== m.tag) await setTeamMarkerInFirestore(game.id, team, m.index, m.tag);
      }
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

  // Open discussion phase: AIs may send as many short back-and-forth messages as
  // they want (bounded internally), always thinking first. They can also revise
  // their own suggested action as the conversation evolves.
  if (ops.length >= 2) {
    let rounds = 0;
    while (rounds < 6) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of ops) {
        if (aiThinkingState[ai.id]) continue;
        // Refresh snapshot + chat so replies can incorporate the newest updates.
        try {
          const g2 = await getGameSnapshot(game?.id);
          if (g2 && g2.cards) working = g2;
        } catch (_) {}
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

          // Apply any new markers.
          const existingMarkers = (team === 'red') ? (working.redMarkers || {}) : (working.blueMarkers || {});
          for (const m of (follow.marks || [])) {
            const cur = String(existingMarkers?.[String(m.index)] || existingMarkers?.[m.index] || '').toLowerCase();
            if (cur !== m.tag) await setTeamMarkerInFirestore(game.id, team, m.index, m.tag);
          }

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

  if (ops.length >= 2) await sleep(AI_COUNCIL_PACE.beforeDecisionMs);

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
  if (ops.length >= 2) {
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

  const systemPrompt = [
    `You are ${ai.name}. You are the Codenames SPYMASTER for ${String(team).toUpperCase()}.`,
    `PERSONALITY (follow strictly): ${persona.label}`,
    ...persona.rules.map(r => `- ${r}`),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `You are inside your private MIND. The only way you think is by writing.`,
    `Task: propose a strong clue and number. Aim for 2–4 when safe; use 0 only if it is truly defensive.`,
    `Return JSON only:`,
    `{"mind":"first-person inner monologue (2-8 lines)", "clue":"ONEWORD", "number":N, "confidence":0.0-1.0, "chat":"optional teammate message (1–2 natural sentences, no indices or "N =" formatting)"}`,
    ``,
    `Hard requirements:`,
    `- clue must be ONE word (no spaces, no hyphens).`,
    `- clue must NOT be any board word: ${boardWords.join(', ')}`,
    `- number is an integer 0-9.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-10).join('\n');
  const userPrompt = `VISION:
${JSON.stringify(vision)}

TEAM CHAT (latest messages):
${teamChat}

RECENT MIND:
${mindContext}`;

  const raw = await aiChatCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { temperature: core.temperature, max_tokens: 360, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return null;

  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);

  let clueWord = String(parsed.clue || '').trim().toUpperCase();
  let clueNumber = parseInt(parsed.number, 10);
  if (!Number.isFinite(clueNumber)) clueNumber = 1;
  clueNumber = Math.max(0, Math.min(9, clueNumber));
  const conf = Math.max(0, Math.min(1, Number(parsed.confidence)));

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
  return { ai, clue: clueWord, number: clueNumber, confidence: Number.isFinite(conf) ? conf : 0.6, chat };
}

function chooseSpymasterClue(proposals) {
  const ps = (proposals || []).filter(p => p && p.clue);
  if (!ps.length) return null;

  // Prefer higher confidence and reasonable multi-hit numbers
  let best = null;
  for (const p of ps) {
    const n = Number.isFinite(+p.number) ? +p.number : 1;
    const c = Number.isFinite(+p.confidence) ? +p.confidence : 0.6;
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
    const c = Number.isFinite(+p.confidence) ? Math.round(+p.confidence * 100) : 0;
    return `- ${String(p.ai?.name || 'AI')}: ${String(p.clue).toUpperCase()} for ${n} (~${c}%)`;
  }).join('\n');

  const chosen = pick ? `${String(pick.clue || '').toUpperCase()} for ${Number(pick.number || 0)}` : '';

  const chatDocs = Array.isArray(opts.chatDocs) ? opts.chatDocs : [];
  const teamChat = chatDocs.slice(-8).map(m => `${m.senderName}: ${m.text}`).join('\n');

  const systemPrompt = [
    `You are ${ai.name}. You are the Codenames SPYMASTER for ${String(ai.team).toUpperCase()}.`,
    `PERSONALITY (follow strictly): ${persona.label}`,
    ...persona.rules.map(r => `- ${r}`),
    ``,
    AI_TIPS_MANUAL,
    ``,
    `You are inside your private MIND. The only way you think is by writing.`,
    `Task: write a brief teammate-facing wrap-up before submitting the clue.`,
    `This is a FOLLOW-UP message; it's okay if you already spoke earlier this turn.`,
    `Return JSON only: {"mind":"2-6 lines first-person", "chat":"1-2 natural sentences"}`,
    `Guidance (strongly recommended):`,
    `- Reflect the discussion (e.g., "I agree with Jordan that..."), but keep it short.`,
    `- Avoid any card indices or "N = WORD" formatting.`,
  ].join('\n');

  const mindContext = core.mindLog.slice(-8).join('\n');
  const userPrompt = [
    `VISION:\n${JSON.stringify(vision)}`,
    ``,
    `TEAM CHAT (latest):\n${teamChat}`,
    ``,
    `SPYMASTER PROPOSALS:\n${proposalLines || '(none)'}`,
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

async function submitClueDirect(ai, game, clueWord, clueNumber) {
  const team = ai.team;
  const ref = db.collection('games').doc(game.id);

  const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  const clueEntry = {
    team: game.currentTeam,
    word: clueWord,
    number: clueNumber,
    results: [],
    timestamp: new Date().toISOString(),
  };

  const seqField = _aiSeqField(team, 'spy');
  let clueAccepted = false;

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
      log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`),
      clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
      [seqField]: firebase.firestore.FieldValue.increment(1),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    clueAccepted = true;
  });

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
      const c = Number.isFinite(+p.confidence) ? Math.round(+p.confidence * 100) : 0;
      return `- ${String(p.ai?.name || 'AI')}: ${String(p.clue).toUpperCase()} for ${n} (~${c}%)`;
    }).join('\n');

    const myPrev = proposalsByAi?.get(ai.id);
    const myPrevLine = myPrev && myPrev.clue
      ? `Previously you leaned: ${String(myPrev.clue).toUpperCase()} for ${Number(myPrev.number || 0)}`
      : `No previous clue proposal.`;

    const systemPrompt = [
      `You are ${ai.name}. You are the Codenames SPYMASTER for ${String(team).toUpperCase()}.`,
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      '',
      AI_TIPS_MANUAL,
      '',
      `You are inside your private MIND. The only way you think is by writing.`,
      `Task: optionally add another short teammate message (strategy discussion). You may also revise YOUR clue proposal.`,
      `Return JSON only:`,
      `{"mind":"2-8 lines first-person", "chat":"(optional) 1-2 natural sentences", "action":"propose|no_change", "clue":"ONEWORD", "number":N, "confidence":0.0-1.0, "continue":true|false}`,
      `Rules:`,
      `- Think first, then speak (mind before chat).`,
      `- clue must be ONE word (no spaces, no hyphens), and NOT a board word.`,
      `- chat must NEVER reference indices/numbers or write "N = WORD".`,
      `- If you have nothing new, set chat="" and continue=false.`,
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

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { temperature: core.temperature, max_tokens: 360, response_format: { type: 'json_object' } }
    );

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
      const conf = Math.max(0, Math.min(1, Number(parsed.confidence)));
      const bad =
        (!clueWord) ? 'empty clue' :
        (clueWord.includes(' ') || clueWord.includes('-')) ? 'not one word' :
        (boardWords.includes(clueWord)) ? 'clue is on the board' :
        null;
      if (!bad) {
        out.clue = clueWord;
        out.number = clueNumber;
        out.confidence = Number.isFinite(conf) ? conf : 0.6;
      }
    }
    return out;
  } catch (_) {
    return null;
  }
}

async function runSpymasterCouncil(game, team) {
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

  // Open discussion phase (multiple short messages). Not forced; AIs may talk
  // as much as they want (bounded internally) and can revise their own clue lean.
  if (spies.length >= 2) {
    let rounds = 0;
    while (rounds < 5) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of spies) {
        if (aiThinkingState[ai.id]) continue;
        try {
          const g2 = await getGameSnapshot(game?.id);
          if (g2 && g2.cards) working = g2;
        } catch (_) {}

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

  if (spies.length >= 2) await sleep(AI_COUNCIL_PACE.beforeDecisionMs);

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
  if (spies.length >= 2) {
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
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      ``,
      AI_TIPS_MANUAL,
      ``,
      `VISION (exact current on-screen state for your role) will be provided as JSON.`,
      ``,
      `MIND RULE: You have a private inner monologue. The only way you think is by writing.`,
      `Return JSON only with this schema:`,
      `{"mind":"first-person inner monologue", "clue":"ONEWORD", "number":N}`,
      ``,
      `Hard requirements:`,
      `- clue must be ONE word (no spaces, no hyphens).`,
      `- clue must NOT be any board word: ${boardWords.join(', ')}`,
      `- number is an integer 0-9.`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = `VISION:
${JSON.stringify(vision)}

RECENT MIND:
${mindContext}`;

    let clueWord = '';
    let clueNumber = 1;
    let mind = '';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await aiChatCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        {
          temperature: core.temperature,
          max_tokens: 420,
          response_format: { type: 'json_object' },
        }
      );

      let parsed = null;
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
      if (!parsed) continue;

      mind = String(parsed.mind || '').trim();
      if (mind) appendMind(ai, mind);

      clueWord = String(parsed.clue || '').trim().toUpperCase();
      clueNumber = parseInt(parsed.number, 10);
      if (!Number.isFinite(clueNumber)) clueNumber = 1;
      clueNumber = Math.max(0, Math.min(9, clueNumber));

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

    // Submit clue (transaction prevents stale writes)
    const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
    const clueEntry = {
      team: game.currentTeam,
      word: clueWord,
      number: clueNumber,
      results: [],
      timestamp: new Date().toISOString(),
    };

    const ref = db.collection('games').doc(game.id);
    const seqField = _aiSeqField(team, 'spy');
    let clueAccepted = false;
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

    const core = ensureAICore(ai);
    if (!core) return;

    const team = ai.team;
    const vision = buildAIVision(game, ai); // operative vision (no hidden types)
    const persona = core.personality;

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
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
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
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      ``,
      `UNREVEALED WORDS (choose ONLY from this list):\n${list}`,
      teamChatContext,
      ``,
      `RECENT MIND:\n${mindContext}`
    ].join('\n');

    let parsed = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const raw = await aiChatCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { temperature: core.temperature, max_tokens: 360, response_format: { type: 'json_object' } }
      );
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
      if (!parsed) continue;

      const mind = String(parsed.mind || '').trim();
      if (mind) appendMind(ai, mind);

      const action = String(parsed.action || '').toLowerCase().trim();
      if (action === 'end_turn') return 'end_turn';

      const idx = Number(parsed.index);
      const candidate = unrevealed.find(c => c.index === idx);
      if (candidate) {
        const chat = String(parsed.chat || '').trim();
        if (chat) {
          // Keep team chat short and in-character (public), mind stays private.
          await sendAIChatMessage(ai, game, chat.slice(0, 180));
        }
        const revealResult = await aiRevealCard(ai, game, candidate.index, true);
        if (revealResult?.turnEnded) return 'turn_already_ended';
        return 'continue';
      }
    }

    // Fallback: if parsing failed repeatedly, end turn rather than random-guess.
    appendMind(ai, `I couldn't produce a valid guess JSON. I'll end the turn to avoid chaos.`);
    return 'end_turn';
  } catch (err) {
    console.error(`AI ${ai.name} guess error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

// Returns { turnEnded: bool } so the caller knows whether the turn already switched.
async function aiRevealCard(ai, game, cardIndex, incrementSeq = false) {
  const card = game.cards[cardIndex];
  if (!card || card.revealed) return { turnEnded: false };

  const ref = db.collection('games').doc(game.id);
  let turnEnded = false;
  let resultCard = card; // keep reference for post-tx work

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
        const winnerName = winner === 'red' ? (current.redTeamName || 'Red') : (current.blueTeamName || 'Blue');
        logEntry += ` ${winnerName} wins!`;
        endTurn = true; // treat game-over as turn ended for the caller
      } else if (endTurn) {
        updates.currentTeam = current.currentTeam === 'red' ? 'blue' : 'red';
        updates.currentPhase = 'spymaster';
        updates.currentClue = null;
        updates.guessesRemaining = 0;
      }

      updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);
      tx.update(ref, updates);
      turnEnded = endTurn;
    });

    // Update clue history outside the transaction (non-critical)
    if (game.currentClue?.word) {
      const guessResult = {
        word: resultCard.word,
        result: resultCard.type === 'assassin' ? 'assassin' : (resultCard.type === game.currentTeam ? 'correct' : (resultCard.type === 'neutral' ? 'neutral' : 'wrong')),
        type: resultCard.type,
        by: ai.name,
        timestamp: new Date().toISOString(),
      };
      await addGuessToClueHistory(game.id, game.currentTeam, game.currentClue.word, game.currentClue.number, guessResult);
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

    return didEnd;
  } catch (e) {
    console.error(`AI ${ai.name} end turn error:`, e);
    return false;
  }
}

// ─── AI Chat & Reactions ────────────────────────────────────────────────────

async function generateAIChatMessage(ai, game, context, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return '';
    const team = ai.team;

    const vision = buildAIVision(game, ai);
    const unrevealed = (vision.cards || []).filter(c => !c.revealed).map(c => String(c.word || '').toUpperCase());
    const teamChat = await fetchRecentTeamChat(game.id, team, 10);
    const lastMessage = (opts && opts.lastMessage) ? String(opts.lastMessage).trim() : '';

    const persona = core.personality;
    const systemPrompt = [
      `You are ${ai.name}. You are chatting with your Codenames teammates.`,
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      ``,
      `Write like a real human teammate: 1–2 natural sentences (not robotic fragments).`,
      `Keep it <=160 chars, but avoid one-word replies like "Nice!" unless it actually ended the game.`,
      `Never refer to card indices, coordinates, or numbers. Do not write things like "13 = WORD".`,
      `If you mention a board word, it MUST be from the unrevealed list provided, and you must use the WORD itself (not an index).`,
      `Do not invent board words.`,
      `Return JSON only: {"mind":"(private inner monologue)", "msg":"(public chat message)"}`,
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
      { temperature: Math.min(1.0, core.temperature * 0.85), max_tokens: 220, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return '';

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let msg = String(parsed.msg || '').trim();
    msg = sanitizeChatText(msg, vision, 160);
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
      `You are ${ai.name}. React as a teammate to the last reveal in Codenames.`,
      `PERSONALITY (follow strictly): ${persona.label}`,
      ...persona.rules.map(r => `- ${r}`),
      `Write like a human teammate: short, specific, not generic.`,
      `Keep it <=120 chars. Avoid repetitive one-word reactions like "Nice!"—mention the revealed word or outcome.`,
      `Return JSON only: {"mind":"(private inner monologue)", "msg":"(public reaction)"}`,
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


async function sendAIChatMessage(ai, game, text) {
  if (!text || !game?.id) return;

  const teamColor = ai.team;

  try {
    await db.collection('games').doc(game.id)
      .collection(`${teamColor}Chat`)
      .add({
        senderId: ai.odId,
        senderName: `AI ${ai.name}`,
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error(`AI ${ai.name} send chat error:`, e);
  }
}

// Lightweight conversational replies (texting vibes) so the AI can react to humans/other AIs.
async function maybeAIRespondToTeamChat(ai, game) {
  try {
    if (!ai || !game?.id) return;
    if (aiThinkingState[ai.id]) return;

    const now = Date.now();
    const lastReply = Number(aiLastChatReplyMs[ai.id] || 0);
    // Hard throttle to avoid spam
    if (now - lastReply < 20000) return;

    const msgs = await fetchRecentTeamChatDocs(game.id, ai.team, 12);
    if (!msgs || !msgs.length) return;

    const newest = Math.max(...msgs.map(m => Number(m.createdAtMs || 0)));
    const lastSeen = Number(aiLastChatSeenMs[ai.id] || 0);
    if (!lastSeen) {
      // First time: mark as seen but don't reply
      aiLastChatSeenMs[ai.id] = newest;
      return;
    }

    // Find the most recent new message not from this AI
    const fresh = msgs.filter(m => (Number(m.createdAtMs || 0) > lastSeen) && String(m.senderId || '') !== String(ai.odId || ''));
    aiLastChatSeenMs[ai.id] = newest;
    if (!fresh.length) return;

    const last = fresh[fresh.length - 1];
    const text = String(last.text || '').trim();
    if (!text) return;

    const lower = text.toLowerCase();
    const nameHit = ai.name ? lower.includes(String(ai.name).toLowerCase()) : false;
    const directHit = nameHit || lower.includes('ai') || lower.includes('bot');
    const question = /\?\s*$/.test(text) || lower.includes('thoughts') || lower.includes('what do you think');

    // Only reply when it looks conversational or direct
    if (!directHit && !question) return;
    // Add a little variability so it doesn't feel mechanical
    if (!directHit && Math.random() < 0.35) return;

    aiThinkingState[ai.id] = true;
    await humanDelay(900, 2200);
    const reply = await generateAIChatMessage(ai, game, 'reply', { lastMessage: `${last.senderName}: ${text}` });
    if (reply) {
      await sendAIChatMessage(ai, game, reply);
      aiLastChatReplyMs[ai.id] = Date.now();
    }
  } catch (e) {
    // don't crash the main loop
  } finally {
    aiThinkingState[ai.id] = false;
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
      // Game ended, send reactions
      if (game?.winner && game.winner !== 'ended') {
        for (const ai of aiPlayers) {
          if (!aiThinkingState[ai.id]) {
            aiThinkingState[ai.id] = true;
            const msg = game.winner === ai.team ? 'gg' : 'gg wp';
            await sendAIChatMessage(ai, game, msg);
            aiThinkingState[ai.id] = false;
          }
        }
      }
      return;
    }

    // Low-frequency chat listening so AIs can actually "converse".
    // (Throttled inside maybeAIRespondToTeamChat to avoid spam.)
    const chatCandidates = (aiPlayers || []).filter(a => a && a.mode === 'autonomous');
    if (chatCandidates.length && Math.random() < 0.55) {
      const pick = chatCandidates[Math.floor(Math.random() * chatCandidates.length)];
      await maybeAIRespondToTeamChat(pick, game);
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


    // Spymaster phase
    if (game.currentPhase === 'spymaster') {
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
