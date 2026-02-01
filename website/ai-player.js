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
        traits: sanitizeTraits(p.aiTraits),
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
window.generateAITraits = generateAITraits;
window.sanitizeTraits = sanitizeTraits;

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

// ─── AI Personality Traits ──────────────────────────────────────────────────

function generateAITraits() {
  return {
    confidence: Math.floor(Math.random() * 101),   // 0-100
    riskiness: Math.floor(Math.random() * 101),     // 0-100
    reasoning: Math.floor(Math.random() * 101),     // 0-100
    strategic: Math.floor(Math.random() * 101),     // 0-100
    farFetched: Math.floor(Math.random() * 101),    // 0-100
  };
}

function sanitizeTraits(raw) {
  if (!raw || typeof raw !== 'object') return generateAITraits();
  const clamp = (v) => Math.max(0, Math.min(100, Math.floor(Number(v) || 0)));
  return {
    confidence: clamp(raw.confidence),
    riskiness: clamp(raw.riskiness),
    reasoning: clamp(raw.reasoning),
    strategic: clamp(raw.strategic),
    farFetched: clamp(raw.farFetched),
  };
}

// ─── Add / Remove AI Players ────────────────────────────────────────────────

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
    traits: generateAITraits(),
  };

  aiPlayers.push(ai);
  window.aiPlayers = aiPlayers;

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
        aiTraits: ai.traits,
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

function getAIOperatives(team) {
  return aiPlayers.filter(a => a.team === team && a.seatRole === 'operative');
}

function isAISpymasterForTeam(game, team) {
  const spymasterName = team === 'red' ? game?.redSpymaster : game?.blueSpymaster;
  return aiPlayers.some(a => a.name === spymasterName && a.team === team);
}

// ─── Strategic Analysis Helpers ─────────────────────────────────────────────

function analyzeGameState(game, team) {
  const otherTeam = team === 'red' ? 'blue' : 'red';
  const myCards = team === 'red' ? game.redCardsLeft : game.blueCardsLeft;
  const theirCards = team === 'red' ? game.blueCardsLeft : game.redCardsLeft;
  const totalRevealed = (game.cards || []).filter(c => c.revealed).length;
  const totalCards = (game.cards || []).length;

  // Determine game phase urgency
  const weAreLeading = myCards < theirCards;
  const weAreLosingBadly = myCards > theirCards + 2;
  const endgame = myCards <= 3 || theirCards <= 3;
  const earlyGame = totalRevealed <= 6;

  // Risk assessment
  const assassinsLeft = (game.cards || []).filter(c => c.type === 'assassin' && !c.revealed).length;
  const opponentCardsLeft = (game.cards || []).filter(c => c.type === otherTeam && !c.revealed).length;
  const neutralsLeft = (game.cards || []).filter(c => c.type === 'neutral' && !c.revealed).length;

  // Risk ratio: how dangerous is guessing randomly?
  const unrevealedCount = totalCards - totalRevealed;
  const dangerRatio = (assassinsLeft + opponentCardsLeft) / Math.max(unrevealedCount, 1);

  let riskTolerance;
  if (weAreLosingBadly) riskTolerance = 'high';      // Need to catch up, take risks
  else if (weAreLeading && !endgame) riskTolerance = 'low';  // Playing it safe
  else if (endgame && myCards <= 2) riskTolerance = 'medium'; // Close to winning
  else riskTolerance = 'medium';

  return {
    myCards, theirCards, weAreLeading, weAreLosingBadly, endgame, earlyGame,
    assassinsLeft, opponentCardsLeft, neutralsLeft, unrevealedCount,
    dangerRatio, riskTolerance, totalRevealed
  };
}

// ─── AI Personality Prompt Building ─────────────────────────────────────────

function buildAIPersonalityPrompt(traits) {
  if (!traits) return '';
  const parts = [];

  // Confidence
  if (traits.confidence > 75) parts.push('You are extremely confident and assertive. You commit fully to your decisions without hesitation.');
  else if (traits.confidence > 50) parts.push('You are fairly confident. You trust your instincts but acknowledge uncertainty when appropriate.');
  else if (traits.confidence > 25) parts.push('You are somewhat hesitant. You often hedge your bets and second-guess yourself.');
  else parts.push('You lack confidence. You constantly doubt your choices, using phrases like "maybe", "I think", "not sure but...".');

  // Riskiness
  if (traits.riskiness > 75) parts.push('You are a bold risk-taker. You love high-risk high-reward plays and push for aggressive strategies.');
  else if (traits.riskiness > 50) parts.push('You are moderately willing to take risks when the potential payoff is good.');
  else if (traits.riskiness > 25) parts.push('You are cautious. You prefer safe, reliable plays over risky ones.');
  else parts.push('You are extremely cautious and risk-averse. You never take chances and always pick the safest option.');

  // Far-fetched
  if (traits.farFetched > 75) parts.push('You love creative, abstract, and lateral-thinking connections. Your associations are unusual and surprising - you find links others would never think of.');
  else if (traits.farFetched > 50) parts.push('You occasionally make creative leaps in your associations but mostly stay reasonable.');
  else if (traits.farFetched > 25) parts.push('You stick to fairly obvious and straightforward connections.');
  else parts.push('You are extremely literal and straightforward. Only the most direct, obvious connections.');

  return parts.join(' ');
}

function buildReasoningInstruction(traits) {
  if (!traits || traits.reasoning <= 30) return '';

  const depth = traits.reasoning > 80 ? 'exhaustive and extremely detailed' :
                traits.reasoning > 60 ? 'thorough and detailed' : 'moderate';

  let instruction = `\n\nBefore making your decision, provide ${depth} internal reasoning in the "private_reasoning" field of your JSON response. This field is for your own scratchpad and will NOT be shown to human players.`;

  if (traits.strategic > 60) {
    instruction += ' Include probability estimates and expected value calculations. For each option, estimate P(correct) and consider the Bayesian posterior given all revealed information and clue history. Quantify the expected value of each choice.';
  }
  if (traits.strategic > 80) {
    instruction += ' Think like a game theorist: consider opponent modeling, information theory, and minimax strategies.';
  }

  return instruction;
}

function buildStrategicInstruction(traits) {
  if (!traits || traits.strategic <= 40) return '';

  if (traits.strategic > 80) {
    return '\nYou are HIGHLY ANALYTICAL. Calculate expected values for every option. Use Bayesian reasoning: update your priors based on revealed cards, previous clues, and teammate behavior. Quantify danger ratios and optimize your plays mathematically. Think in probabilities, not vibes.';
  }
  if (traits.strategic > 60) {
    return '\nYou think analytically. Consider the probability distributions across remaining cards and weigh risks numerically when making decisions.';
  }
  return '\nYou lean somewhat analytical. Consider the odds before making decisions.';
}

// ─── Build Game Context for LLM ────────────────────────────────────────────

function buildBoardContext(game, isSpymaster) {
  const cards = game.cards || [];
  const lines = cards.map((c, i) => {
    const status = c.revealed ? `[REVEALED: ${c.type}]` : (isSpymaster ? `[${c.type}]` : '[hidden]');
    return `${i + 1}. ${c.word} ${status}`;
  });
  return lines.join('\n');
}

function buildClueHistoryContext(game) {
  const history = Array.isArray(game?.clueHistory) ? game.clueHistory : [];
  if (!history.length) return 'No clues given yet.';
  return history.map(c => {
    const team = String(c.team || '').toUpperCase();
    const clueWord = String(c.word || '').toUpperCase();
    const num = Number(c.number) || 0;
    const resultsArr = Array.isArray(c.results) ? c.results : [];
    const results = resultsArr.map(r => {
      const w = String(r.word || '').toUpperCase();
      const res = String(r.result || '').toLowerCase();
      const by = String(r.by || '').trim();
      return by ? `${w}(${res}, by ${by})` : `${w}(${res})`;
    }).join(', ');
    return `${team} clue: "${clueWord}" for ${num}${results ? ` → guesses: ${results}` : ''}`;
  }).join('\\n');
}

function buildTeamContext(game, team) {
  const players = team === 'red' ? (game.redPlayers || []) : (game.bluePlayers || []);
  const spymaster = team === 'red' ? game.redSpymaster : game.blueSpymaster;
  return players.map(p => `${p.name}${p.name === spymaster ? ' (Spymaster)' : ' (Operative)'}${p.isAI ? ' [AI]' : ''}`).join(', ');
}

function buildGameSummary(game, team, isSpymaster) {
  const otherTeam = team === 'red' ? 'blue' : 'red';
  const myCards = team === 'red' ? game.redCardsLeft : game.blueCardsLeft;
  const theirCards = team === 'red' ? game.blueCardsLeft : game.redCardsLeft;
  return `You are on ${team.toUpperCase()} team. Your team has ${myCards} cards left. ${otherTeam.toUpperCase()} has ${theirCards} cards left. Current turn: ${game.currentTeam.toUpperCase()} ${game.currentPhase}.`;
}

function buildGameLogContext(game, maxLines = 35) {
  const log = Array.isArray(game?.log) ? game.log : [];
  if (!log.length) return 'No game log entries yet.';
  const slice = log.slice(Math.max(0, log.length - maxLines));
  return slice.map((l, i) => `${i + 1}. ${String(l)}`).join('\n');
}

function buildScoreContext(game) {
  const redLeft = Number(game?.redCardsLeft ?? 0);
  const blueLeft = Number(game?.blueCardsLeft ?? 0);
  const phase = String(game?.currentPhase || '');
  const team = String(game?.currentTeam || '');
  const clue = game?.currentClue ? `${String(game.currentClue.word || '').toUpperCase()}(${Number(game.currentClue.number || 0)})` : 'none';
  return `SCORE/STATE: red_cards_left=${redLeft}, blue_cards_left=${blueLeft}, current_team=${team.toUpperCase()}, phase=${phase}, current_clue=${clue}.`;
}

function buildAIAttributesContext(game) {
  const all = [
    ...(Array.isArray(game?.redPlayers) ? game.redPlayers : []),
    ...(Array.isArray(game?.bluePlayers) ? game.bluePlayers : []),
  ];
  const ais = all.filter(p => p && p.isAI);
  if (!ais.length) return 'No AI players in this game.';
  return ais.map(p => {
    const role = String(p.role || 'operative');
    const team = (Array.isArray(game?.redPlayers) ? game.redPlayers : []).some(x => String(x?.odId || '') === String(p?.odId || '')) ? 'red' : 'blue';
    const t = sanitizeTraits(p.aiTraits);
    return `- ${p.name} (${team}, ${role}): confidence=${t.confidence}, riskiness=${t.riskiness}, reasoning=${t.reasoning}, strategic=${t.strategic}, farFetched=${t.farFetched}`;
  }).join('\n');
}

function buildTeamMarkersContext(game, team) {
  const key = team === 'red' ? 'redMarkers' : 'blueMarkers';
  const marks = (game && game[key] && typeof game[key] === 'object') ? game[key] : {};
  const entries = Object.entries(marks || {})
    .map(([k, v]) => ({ idx: Number(k), tag: String(v || '') }))
    .filter(e => Number.isInteger(e.idx) && e.idx >= 0 && e.idx < (game?.cards?.length || 25) && ['yes','maybe','no'].includes(e.tag));
  if (!entries.length) return 'TEAM MARKERS: none.';
  const lines = entries
    .sort((a,b)=>a.idx-b.idx)
    .slice(0, 60)
    .map(e => {
      const w = game?.cards?.[e.idx]?.word ? String(game.cards[e.idx].word) : '';
      return `- ${e.idx}: ${w} => ${e.tag}`;
    });
  return `TEAM MARKERS (visible to your team only):\n${lines.join('\n')}`;
}

function tokenBudgetFromTraits(traits, minTokens, maxTokens) {
  const r = Math.max(0, Math.min(100, Number(traits?.reasoning ?? 50)));
  return Math.round(minTokens + (maxTokens - minTokens) * (r / 100));
}

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



async function aiValidateSpymasterClueSafety(ai, game, team, clueWord, ourWords, theirWords, neutralWords, assassinWords) {
  try {
    const systemPrompt = `You are a Codenames safety checker.
Given a proposed clue, decide if it dangerously relates to ANY assassin word, and whether it likely overlaps opponents/neutral.

Return JSON ONLY:
{"safe": true/false, "assassin_overlap": ["WORD"], "opponent_overlap":["WORD"], "neutral_overlap":["WORD"], "note":"short"}.

Board words:
- OUR: ${ourWords.join(', ')}
- OPPONENT: ${theirWords.join(', ')}
- NEUTRAL: ${neutralWords.join(', ')}
- ASSASSIN (critical): ${assassinWords.join(', ')}

Proposed clue: "${clueWord}"

Guidance:
- Be conservative about assassin overlap: if there is a meaningful association, mark it unsafe.
- Overlap with opponent words is risky but not automatically unsafe; include it in note.`;

    const res = await aiChatCompletion(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Safety-check the clue now. JSON only.' },
      ],
      {
        temperature: 0.1,
        max_tokens: 400,
        response_format: { type: 'json_object' },
      }
    );

    let parsed = null;
    try { parsed = JSON.parse(res); } catch {
      const m = String(res || '').match(/\{[\s\S]*\}/);
      if (m) parsed = JSON.parse(m[0]);
    }
    if (!parsed) return { safe: true, note: 'no-parse' };

    const assassinOverlap = Array.isArray(parsed.assassin_overlap) ? parsed.assassin_overlap.map(x => String(x || '').toUpperCase()).filter(Boolean) : [];
    const opponentOverlap = Array.isArray(parsed.opponent_overlap) ? parsed.opponent_overlap.map(x => String(x || '').toUpperCase()).filter(Boolean) : [];
    const neutralOverlap = Array.isArray(parsed.neutral_overlap) ? parsed.neutral_overlap.map(x => String(x || '').toUpperCase()).filter(Boolean) : [];
    const safe = !!parsed.safe && assassinOverlap.length === 0;

    return { safe, assassinOverlap, opponentOverlap, neutralOverlap, note: String(parsed.note || '') };
  } catch (_) {
    // Fail open: if the safety check fails, don't block play.
    return { safe: true, note: 'checker-error' };
  }
}


// ─── AI Spymaster: Give Clue (Structured Output) ───────────────────────────

async function aiGiveClue(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  const team = ai.team;
  const boardContext = buildBoardContext(game, true);
  const clueHistory = buildClueHistoryContext(game);
  const summary = buildGameSummary(game, team, true);
  const teamContext = buildTeamContext(game, team);
  const analysis = analyzeGameState(game, team);

  // Compute which words belong to our team and haven't been revealed
  const ourWords = game.cards
    .filter(c => c.type === team && !c.revealed)
    .map(c => c.word);
  const theirWords = game.cards
    .filter(c => c.type === (team === 'red' ? 'blue' : 'red') && !c.revealed)
    .map(c => c.word);
  const assassinWords = game.cards
    .filter(c => c.type === 'assassin' && !c.revealed)
    .map(c => c.word);
  const neutralWords = game.cards
    .filter(c => c.type === 'neutral' && !c.revealed)
    .map(c => c.word);
  const boardWords = game.cards.map(c => c.word.toUpperCase());

  // Build strategic guidance based on game state analysis
  const traits = ai.traits || {};
  let strategyGuidance = '';
  if (analysis.weAreLosingBadly) {
    strategyGuidance = `STRATEGIC SITUATION: You are BEHIND by ${analysis.myCards - analysis.theirCards} cards. You MUST be aggressive. Try to connect 3+ words with one clue, even if some connections are looser. A safe 1-word clue will not catch up. Take calculated risks.`;
  } else if (analysis.weAreLeading && !analysis.endgame) {
    strategyGuidance = `STRATEGIC SITUATION: You are AHEAD. Play conservatively. Give clues that strongly connect 2 words rather than risky 3+ word clues. Avoid anything that could lead to the assassin. Safe, solid clues will maintain your lead.`;
  } else if (analysis.endgame && analysis.myCards <= 2) {
    strategyGuidance = `STRATEGIC SITUATION: ENDGAME - only ${analysis.myCards} cards left! Give a precise clue for ${analysis.myCards === 1 ? '1 word - make it unmistakable' : '2 words if possible, but clarity over quantity'}. One wrong guess could lose the game.`;
  } else if (analysis.earlyGame) {
    strategyGuidance = `STRATEGIC SITUATION: Early game. Aim for a strong opening clue connecting 2-3 of the easiest-to-connect words. Save tricky words for later when there are fewer options on the board.`;
  } else {
    strategyGuidance = `STRATEGIC SITUATION: Mid-game, balanced position. Aim for clues connecting 2+ words. Balance risk and reward.`;
  }

  // Trait-based personality modifiers
  const personalityPrompt = buildAIPersonalityPrompt(traits);
  const strategicInstr = buildStrategicInstruction(traits);
  const reasoningInstr = buildReasoningInstruction(traits);

  // Trait-based strategy overrides
  if (traits.riskiness > 70) {
    strategyGuidance += '\n\nYour natural tendency: BOLD and AGGRESSIVE. Push for 3+ word clues. You thrive on high-risk high-reward plays.';
  } else if (traits.riskiness < 30) {
    strategyGuidance += '\n\nYour natural tendency: VERY CAUTIOUS. Prefer safe 1-2 word clues. Never risk the assassin.';
  }

  if (traits.confidence > 70) {
    strategyGuidance += ' Commit fully to your clue and set a higher number - you trust your teammates to get it.';
  } else if (traits.confidence < 30) {
    strategyGuidance += ' Hedge your bets. Set a conservative number even if you think more words could match.';
  }

  const systemPrompt = `You are a Codenames Spymaster for the ${team.toUpperCase()} team.
${personalityPrompt}

RULES:
- Your clue must be a SINGLE word (no spaces, no hyphens, no compound words).
- Your clue CANNOT be any word currently on the board: ${boardWords.join(', ')}
- The number indicates how many of YOUR team's unrevealed cards relate to the clue.
- CRITICAL: NEVER give a clue that relates to the assassin words. This loses the game instantly.
- AVOID clues that relate to the opponent's words - this gives them free points.
- Neutral words are bad but not catastrophic - they just end your turn.

YOUR TEAM'S UNREVEALED WORDS: ${ourWords.join(', ')}
OPPONENT'S UNREVEALED WORDS: ${theirWords.join(', ')}
NEUTRAL WORDS: ${neutralWords.join(', ')}
ASSASSIN WORDS (CRITICAL - AVOID AT ALL COSTS): ${assassinWords.join(', ')}

${strategyGuidance}
${strategicInstr}

${buildScoreContext(game)}

BOARD:
${boardContext}

${buildTeamMarkersContext(game, team)}

AI PLAYERS (names/roles/traits):
${buildAIAttributesContext(game)}

GAME LOG (most recent last):
${buildGameLogContext(game)}

${clueHistory}
${summary}
Team: ${teamContext}

THINK STEP BY STEP:
1. Group your team's words by possible thematic connections
2. For each potential clue, check: does it relate to ANY assassin word? If yes, REJECT it immediately
3. Does it relate to opponent words? If yes, consider the risk
4. Pick the clue that connects the most team words with the LEAST risk of assassin/opponent overlap
5. Set the number to ONLY count words you're very confident your teammates will get
6. Creative associations are allowed when helpful (synonyms, common phrases, pop culture, abbreviations, symbols like 0→O, simple formulas like H2O), but keep the clue a single common word and keep it SAFE.
7. You may use number 0 only if you are intentionally giving a defensive "warning" clue (i.e., none of your words match it), but prefer normal clues when possible.
${reasoningInstr}

Respond with valid JSON: {"clue": "YOURWORD", "number": N, "intended_words": ["word1", "word2"], "private_reasoning": "your scratchpad: explain strategy and intended words"}`;

  try {
    // Strategic thinking delay - scales with difficulty
    // Fewer words left = harder to find good clues = think longer
    // More words = easier to find connections = think faster
    const baseDelay = analysis.endgame ? 5000 : (analysis.earlyGame ? 3000 : 4000);
    const variability = analysis.endgame ? 6000 : 4000;
    await humanDelay(baseDelay, baseDelay + variability);

    // Blend game-state temperature with trait-based temperature
    const stateTemp = analysis.weAreLosingBadly ? 0.85 : (analysis.weAreLeading ? 0.5 : 0.65);
    const traitTemp = 0.3 + (traits.farFetched / 100) * 0.5 + (traits.riskiness / 100) * 0.15;
    const spymasterTemp = Math.min(1.0, (stateTemp * 0.5) + (traitTemp * 0.5));

    let clueWord = '';
    let clueNumber = 1;
    let intendedWords = [];
    let lastBad = '';

    const ourUpper = ourWords.map(w => String(w).toUpperCase());
    const theirUpper = theirWords.map(w => String(w).toUpperCase());
    const neutralUpper = neutralWords.map(w => String(w).toUpperCase());
    const assassinUpper = assassinWords.map(w => String(w).toUpperCase());

    for (let attempt = 1; attempt <= 4; attempt++) {
      const userMsg = lastBad
        ? `Your previous clue was rejected: ${lastBad}. Try again with a SAFER clue. JSON only.`
        : 'Analyze the board carefully, then give your clue as JSON.';

      const result = await aiChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMsg },
      ], {
        temperature: spymasterTemp,
        max_tokens: tokenBudgetFromTraits(traits, 1200, 3200),
        response_format: { type: 'json_object' },
      });

      let parsed = null;
      try {
        parsed = JSON.parse(result);
      } catch {
        const match = String(result || '').match(/\{[\s\S]*?\}/);
        if (match) parsed = JSON.parse(match[0]);
      }
      if (!parsed) {
        lastBad = 'could not parse JSON';
        continue;
      }

      const cw = String(parsed.clue || '').trim().toUpperCase();
      let nRaw = parseInt(parsed.number, 10);
      if (!Number.isFinite(nRaw)) nRaw = 1;
      let cn = Math.max(0, Math.min(9, nRaw));

      // Validate: must be single word, not on board
      if (!cw || cw.includes(' ') || boardWords.includes(cw)) {
        lastBad = `invalid clue word "${cw}" (must be 1 word and not on board)`;
        continue;
      }

      // Normalize intended words: keep only our team's unrevealed words
      const intended = Array.isArray(parsed.intended_words) ? parsed.intended_words : [];
      const intendedNorm = intended
        .map(w => String(w || '').trim().toUpperCase())
        .filter(Boolean)
        .filter(w => ourUpper.includes(w));

      // If the model claims a normal clue but gives no intended words, retry.
      if (cn > 0 && intendedNorm.length === 0) {
        lastBad = 'no intended_words were valid team words';
        continue;
      }

      // If intended words exist, clamp the number to that set.
      if (intendedNorm.length > 0) {
        cn = Math.max(1, Math.min(9, Math.min(cn || 1, intendedNorm.length)));
      }

      // Defensive 0 clue should not point at our words.
      if (cn === 0 && intendedNorm.length > 0) {
        lastBad = '0 clue must have no intended_words';
        continue;
      }

      // Safety-check against assassin overlap (strict).
      const safety = await aiValidateSpymasterClueSafety(ai, game, team, cw, ourUpper, theirUpper, neutralUpper, assassinUpper);
      if (!safety.safe) {
        lastBad = `unsafe: overlaps assassin (${(safety.assassinOverlap || []).join(', ') || 'unknown'})`;
        continue;
      }

      // If we are cautious, also avoid obvious opponent overlap.
      const cautious = (traits.riskiness || 50) < 40;
      if (cautious && Array.isArray(safety.opponentOverlap) && safety.opponentOverlap.length) {
        lastBad = `too risky: overlaps opponent (${safety.opponentOverlap.join(', ')})`;
        continue;
      }

      // Accept
      clueWord = cw;
      clueNumber = cn;
      intendedWords = intendedNorm.slice(0, 9);
      break;
    }

    if (!clueWord) {
      console.warn(`AI ${ai.name} failed to find a safe valid clue after retries.`);
      aiThinkingState[ai.id] = false;
      return;
    }

    // Submit the clue to Firestore using a transaction to prevent stale writes.
    // Another loop tick may have changed the phase/team while the AI was thinking.
    const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
    const clueEntry = {
      team: game.currentTeam,
      word: clueWord,
      number: clueNumber,
      results: [],
      timestamp: new Date().toISOString(),
    };

    const ref = db.collection('games').doc(game.id);
    let clueAccepted = false;
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const current = snap.data();
      // Abort if the game state moved on while the AI was thinking
      if (current.currentPhase !== 'spymaster' || current.currentTeam !== team) return;

      tx.update(ref, {
        currentClue: { word: clueWord, number: clueNumber },
        guessesRemaining: (clueNumber === 0 ? 0 : (clueNumber + 1)),
        currentPhase: 'operatives',
        log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`),
        clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
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

// ─── AI Operative: Guess Card (Structured Output) ──────────────────────────

// AI card marking state: { gameId: { cardIndex: 'yes'|'maybe'|'no' } }
let aiCardMarks = {};

// Expose a getter for per-game AI marks so game.js can render them.
window.getAICardMarksForGame = function(gameId) {
  try {
    return (aiCardMarks && gameId && aiCardMarks[String(gameId)]) ? aiCardMarks[String(gameId)] : {};
  } catch (_) {
    return {};
  }
};


// Listen for human card-tag updates so the AI can react progressively
if (!window.__aiHumanTagListener) {
  window.__aiHumanTagListener = true;
  window.addEventListener('codenames:humanTagsChanged', (e) => {
    const d = (e && e.detail) ? e.detail : null;
    const gameId = d && d.gameId ? String(d.gameId) : null;
    if (!gameId) return;
    const idx = Number(d.cardIndex);
    if (!Number.isInteger(idx) || idx < 0) return;
    const tag = String(d.tag || "").toLowerCase();

    if (!aiCardMarks[gameId]) aiCardMarks[gameId] = {};
    if (!tag || tag === "clear") {
      delete aiCardMarks[gameId][idx];
    } else if (["yes", "maybe", "no"].includes(tag)) {
      // React: align AI opinion with the human tag (without overwriting the human UI tag)
      aiCardMarks[gameId][idx] = tag;
    }

    if (typeof renderCardTags === "function") renderCardTags();
  });
}

function aiMarkCard(game, cardIndex, mark) {
  if (!game?.id) return;
  if (!aiCardMarks[game.id]) aiCardMarks[game.id] = {};

  if (mark === 'clear' || aiCardMarks[game.id][cardIndex] === mark) {
    delete aiCardMarks[game.id][cardIndex];
  } else {
    aiCardMarks[game.id][cardIndex] = mark;
  }

  // Expose marks so the UI can render them without overwriting human tags.
  window.__aiCardMarksByGame = aiCardMarks;

  // Re-render tags (human tags win; AI tags show only when a human hasn't tagged that card).
  if (typeof renderCardTags === 'function') {
    renderCardTags();
  }
}

async function aiAnalyzeAndMarkCards(ai, game, currentClue) {
  if (!currentClue || !game?.cards) return;

  const team = ai.team;
  const unrevealed = game.cards
    .map((c, i) => ({ word: c.word, index: i }))
    .filter((_, i) => !game.cards[i].revealed);

  const unrevealedLines = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\n');
  const clueHistory = buildClueHistoryContext(game);

  const systemPrompt = `You are a Codenames Operative analyzing the board for clue "${currentClue.word}" for ${currentClue.number}.

UNREVEALED WORDS:
${unrevealedLines}

${clueHistory}

For each unrevealed word, decide if it likely matches the clue:
- "yes" = strongly matches the clue (you'd guess this)
- "maybe" = could match but you're unsure
- "no" = likely a trap, opponent, or assassin word - avoid

Return JSON: {"marks": [{"index": N, "mark": "yes|maybe|no"}]}
Only include words you have an opinion on. Skip words you're neutral about.
Be strategic - mark words you'd warn teammates about as "no".`;

  try {
    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `Analyze each word for clue "${currentClue.word}" ${currentClue.number}. JSON only.` },
    ], {
      temperature: 0.3,
      max_tokens: tokenBudgetFromTraits(ai.traits || {}, 900, 2200),
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      const match = result.match(/\{[\s\S]*?\}/);
      if (match) parsed = JSON.parse(match[0]);
      else return;
    }

    const marks = parsed.marks || parsed.analysis || [];
    if (!Array.isArray(marks)) return;
    // Clear old marks for this game first (AI-only marks; human tags remain separate)
    aiCardMarks[game.id] = {};
    if (typeof renderCardTags === 'function') renderCardTags();

    // Humans don't instantly annotate the whole board—do it progressively.
    await humanDelay(700, 1400);

    const normalizedMarks = (marks || [])
      .map(m => ({ idx: Number(m.index), mark: String(m.mark || '').toLowerCase() }))
      .filter(m => Number.isInteger(m.idx) && m.idx >= 0 && m.idx < game.cards.length && !game.cards[m.idx].revealed)
      .filter(m => ['yes', 'maybe', 'no'].includes(m.mark));

    // Order: strong matches first, then traps/avoid, then maybes
    const order = { yes: 0, no: 1, maybe: 2 };
    normalizedMarks.sort((a, b) => (order[a.mark] - order[b.mark]) + (Math.random() - 0.5) * 0.15);

    for (const m of normalizedMarks) {
      // Skip if clue changed mid-marking (avoid stale marks)
      if (!game.currentClue || game.currentClue.word !== currentClue.word) break;
      await humanDelay(420, 980);
      aiMarkCard(game, m.idx, m.mark);
      await setTeamMarkerInFirestore(game.id, team, m.idx, m.mark);
    }

    // Brief pause after finishing marking
    await humanDelay(350, 750);

  } catch (e) {
    console.warn(`AI ${ai.name} card marking failed:`, e);
  }
}

let aiOpponentClueProcessed = {}; // keyed by `${gameId}:${team}` -> clueKey

// Track our own team's "0" clues so we only run the defensive analysis once.
let aiZeroClueProcessed = {}; // keyed by `${gameId}:${team}` -> clueKey

// When a spymaster gives a 0 clue, humans often mean: "avoid anything related to this".
// This helper marks the most clue-related board words as "no" and optionally chats a warning.
async function aiAnalyzeZeroClueAndWarn(ai, game, zeroClue) {
  try {
    if (!ai || !game?.id || !zeroClue) return;
    const myTeam = ai.team;
    const clueWord = String(zeroClue.word || '').trim();
    const clueNum = Number.isFinite(+zeroClue.number) ? +zeroClue.number : 0;
    if (!clueWord || clueNum !== 0) return;

    const clueKey = `${String(game.id)}:${myTeam}:${clueWord.toUpperCase()}:0`;
    if (aiZeroClueProcessed[clueKey]) return;
    aiZeroClueProcessed[clueKey] = true;

    const unrevealed = (game.cards || [])
      .map((c, i) => ({ word: c.word, index: i, revealed: !!c.revealed }))
      .filter(c => !c.revealed);
    if (!unrevealed.length) return;

    const unrevealedLines = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\n');

    const systemPrompt = `You are a Codenames Operative on the ${myTeam.toUpperCase()} team.
Your Spymaster gave the clue "${clueWord}" for 0.

In Codenames, a 0 clue usually means: "NONE of our remaining words match this — it's a WARNING."\
Often it hints that one of the words strongly related to the clue is a dangerous trap (opponent or assassin).

TASK:
- From the unrevealed list, pick up to 4 words that are MOST related to the clue "${clueWord}".
- Mark those words as "no" to warn the team to avoid them.
- Also write ONE short chat message summarizing the warning and naming 1-2 likely trap words.

UNREVEALED WORDS:
${unrevealedLines}

Return JSON ONLY:
{"marks":[{"index":N,"mark":"no"},...],"chat":"short message"}`;

    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Analyze the 0 clue and warn the team. JSON only.' },
    ], {
      temperature: 0.25,
      max_tokens: tokenBudgetFromTraits(ai.traits || {}, 650, 1600),
      response_format: { type: 'json_object' },
    });

    let parsed = null;
    try { parsed = JSON.parse(result); } catch {
      const match = String(result || '').match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
    if (!parsed) return;

    const marks = Array.isArray(parsed.marks) ? parsed.marks : [];
    const normalized = marks
      .map(m => ({ idx: Number(m.index), mark: String(m.mark || '').toLowerCase() }))
      .filter(m => Number.isInteger(m.idx) && m.idx >= 0 && m.idx < (game.cards || []).length)
      .filter(m => m.mark === 'no')
      .slice(0, 8);

    for (const m of normalized) {
      await humanDelay(350, 900);
      aiMarkCard(game, m.idx, 'no');
      await setTeamMarkerInFirestore(game.id, myTeam, m.idx, 'no');
    }

    const chat = String(parsed.chat || '').trim();
    if (chat && ai.mode === 'autonomous') {
      await humanDelay(550, 1500);
      await sendAIChatMessage(ai, game, chat.slice(0, 160));
    }
  } catch (e) {
    // best-effort; ignore
  }
}

async function aiAnalyzeOpponentClueAndMarkAvoid(ai, game, opponentClue) {
  try {
    if (!ai || !game?.id || !opponentClue) return;
    const myTeam = ai.team;
    const oppTeam = myTeam === 'red' ? 'blue' : 'red';
    const clueWord = String(opponentClue.word || '').trim();
    const clueNum = Number(opponentClue.number || 0);

    const unrevealed = (game.cards || [])
      .map((c, i) => ({ word: c.word, index: i, revealed: !!c.revealed }))
      .filter(c => !c.revealed);

    if (!unrevealed.length || !clueWord) return;

    const unrevealedLines = unrevealed.map(c => `- ${c.index}: ${c.word}`).join('\n');

    const systemPrompt = `You are a Codenames Operative on the ${myTeam.toUpperCase()} team.
Your opponents (${oppTeam.toUpperCase()}) just gave the clue "${clueWord}" for ${clueNum}.
Humans on your team can overhear opponent clues. Use that information defensively.

TASK:
- Identify unrevealed words that are LIKELY targets of the opponent's clue.
- Mark those words as "no" (X) to warn your team to avoid guessing them on your team's turn.
- If a word is only a weak match, mark it "maybe" instead.
- ONLY choose from the unrevealed list below.

UNREVEALED WORDS:
${unrevealedLines}

Return JSON:
{"marks":[{"index":N,"mark":"no|maybe"}], "private_reasoning":"scratchpad"}.

Do NOT include any other text.`;

    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Mark likely opponent targets now. JSON only.' },
    ], {
      temperature: 0.2,
      max_tokens: tokenBudgetFromTraits(ai.traits || {}, 700, 1800),
      response_format: { type: 'json_object' },
    });

    let parsed = null;
    try { parsed = JSON.parse(result); } catch {
      const match = String(result || '').match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
    }
    if (!parsed) return;

    const marks = Array.isArray(parsed.marks) ? parsed.marks : [];
    const normalized = marks
      .map(m => ({ idx: Number(m.index), mark: String(m.mark || '').toLowerCase() }))
      .filter(m => Number.isInteger(m.idx) && m.idx >= 0 && m.idx < (game.cards || []).length)
      .filter(m => ['no','maybe'].includes(m.mark))
      .slice(0, 10);

    // Apply marks with small delays so it feels human-like.
    for (const m of normalized) {
      await humanDelay(300, 800);
      await setTeamMarkerInFirestore(game.id, myTeam, m.idx, m.mark);
    }
  } catch (e) {
    // ignore
  }
}

async function aiGuessCard(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  const team = ai.team;
  const boardContext = buildBoardContext(game, false);
  const clueHistory = buildClueHistoryContext(game);
  const summary = buildGameSummary(game, team, false);
  const currentClue = game.currentClue;
  const analysis = analyzeGameState(game, team);

  if (!currentClue) {
    aiThinkingState[ai.id] = false;
    return;
  }

  // IMPORTANT: clue number can legitimately be 0 in Codenames (often used as a "warning" clue).
  // Never coerce 0 to 1.
  const clueN = Number.isFinite(+currentClue?.number) ? +currentClue.number : 1;

  const remainingGuesses = Number.isFinite(+game.guessesRemaining) ? +game.guessesRemaining : 999;
  // If there are no guesses left (e.g., clue 0 or already consumed), end immediately.
  if (remainingGuesses <= 0) {
    aiThinkingState[ai.id] = false;
    return 'end_turn';
  }


  const unrevealed = game.cards
    .map((c, i) => ({ word: c.word, index: i, revealed: c.revealed }))
    .filter(c => !c.revealed);

  // Fetch recent team chat so AI can see what teammates are discussing
  const teamChat = await fetchRecentTeamChat(game.id, team);
  const teamChatContext = teamChat ? `\nRECENT TEAM CHAT:\n${teamChat}\n\nConsider your teammates' suggestions and discussion when making your choice.` : '';

  // Helper: strict-ish JSON parse with best-effort extraction
  const parseJsonLoose = (raw) => {
    const s = String(raw || '').trim();
    if (!s) throw new Error('Empty response');
    try {
      return JSON.parse(s);
    } catch (_) {
      const a = s.indexOf('{');
      const b = s.lastIndexOf('}');
      if (a >= 0 && b > a) {
        return JSON.parse(s.slice(a, b + 1));
      }
      throw new Error('Could not parse JSON');
    }
  };

  // Provide an exact index->word mapping so the model can pick deterministically from the board.
  const unrevealedLines = unrevealed
    .map(c => `- ${c.index}: ${c.word}`)
    .join('\n');

  // Count correct guesses for the current clue so far
  const currentClueResults = (Array.isArray(game.clueHistory) ? game.clueHistory : [])
    .filter(c => c.word === currentClue.word && c.team === game.currentTeam)
    .pop()?.results || [];
  const correctGuesses = currentClueResults.filter(r => r.result === 'correct').length;
  // (wrong guesses are tracked in clue history; used elsewhere for UI/logging)
  const guessNumber = correctGuesses + 1; // Which guess number this is

  // If the clue number is 0, treat it as a defensive/warning clue by default.
  // Prefer ending the turn rather than guessing something related to the clue.
  if (clueN === 0 && correctGuesses === 0) {
    try {
      await aiAnalyzeZeroClueAndWarn(ai, game, currentClue);
    } catch (_) {}
    aiThinkingState[ai.id] = false;
    return 'end_turn';
  }

  // Build strategic context for the operative
  const traits = ai.traits || {};
  let guessStrategy = '';
  if (clueN > 0 && correctGuesses >= clueN) {
    guessStrategy = `You have already found the ${clueN} intended words for the clue. The clue is effectively COMPLETE. You have ${remainingGuesses} guess(es) left (usually 1 bonus guess). Only take a bonus guess if your confidence is HIGH and it is clearly safe; otherwise recommend ending the turn. Risk level: ${analysis.riskTolerance}. Assassins remaining: ${analysis.assassinsLeft}. Opponent cards remaining: ${analysis.opponentCardsLeft}.`;
  } else {
    guessStrategy = `This is guess #${guessNumber} of ${clueN} intended words. ${correctGuesses > 0 ? `Already got ${correctGuesses} correct.` : ''} You have ${remainingGuesses} guess(es) remaining this turn. Risk level: ${analysis.riskTolerance}.`;
  }

  // Trait-based operative modifications
  const personalityPrompt = buildAIPersonalityPrompt(traits);
  const strategicInstr = buildStrategicInstruction(traits);
  const reasoningInstr = buildReasoningInstruction(traits);

  if (traits.riskiness > 70) {
    guessStrategy += ' You are naturally bold - willing to take medium and even low-confidence guesses. Go for it.';
  } else if (traits.riskiness < 30) {
    guessStrategy += ' You are naturally very cautious - only guess when you are quite sure. Prefer ending turn over risky guesses.';
  }

  let systemPrompt = `You are a Codenames Operative on the ${team.toUpperCase()} team. Your Spymaster gave the clue "${currentClue.word}" for ${clueN}.
${personalityPrompt}

BOARD (unrevealed words, choose ONLY from this list):
${unrevealedLines}

${buildScoreContext(game)}

${buildTeamMarkersContext(game, team)}

AI PLAYERS (names/roles/traits):
${buildAIAttributesContext(game)}

GAME LOG (most recent last):
${buildGameLogContext(game)}

${clueHistory}
${summary}
${teamChatContext}

${guessStrategy}

STRATEGY:
- Pick the ONE word that BEST matches the clue "${currentClue.word}"
- Rate your confidence honestly: "high" = very sure, "medium" = likely, "low" = risky guess
- If you're confident, pick quickly. If uncertain, think carefully.
- Consider: could ANY of these words be the assassin? Avoid those at all costs.
- Also indicate if you think the team should END TURN after this guess

ADVANCED ASSOCIATIONS (use when helpful):
- Synonyms, hypernyms, common phrases, pop-culture references
- Abbreviations and symbols (e.g., 0→O), simple formulas (e.g., H2O)
- Parts/wholes, related places/things, and typical pairings

${analysis.riskTolerance === 'low' ? 'Play SAFE. Only guess words you are very confident about. If uncertain, recommend ending turn.' : ''}
${analysis.riskTolerance === 'high' ? 'You need to catch up. Be willing to take medium-confidence guesses.' : ''}
${analysis.endgame ? 'ENDGAME: Every guess matters. Be precise.' : ''}
${strategicInstr}
${reasoningInstr}

Respond with valid JSON:
{"index": <0-24>, "word": "EXACT_BOARD_WORD", "confidence": "high/medium/low", "should_end_turn_after": true/false, "private_reasoning": "your scratchpad: strategic thinking"}`;

  try {
    // Mark cards first (human-like - study the board, mark thoughts)
    if (correctGuesses === 0) {
      await aiAnalyzeAndMarkCards(ai, game, currentClue);
      // Thinking delay after marking - like a human studying their marks
      await humanDelay(1500, 3000);
    }

    // Confidence-based thinking delay:
    // High confidence = fast (human just knows), Low confidence = slow (deliberation)
    // Early guesses are faster than later ones (first words are most obvious)
    const baseThinkTime = guessNumber <= 1 ? 2000 : (guessNumber === 2 ? 3500 : 5000);
    const thinkVariability = guessNumber <= 1 ? 2000 : 4000;
    await humanDelay(baseThinkTime, baseThinkTime + thinkVariability);

    // Chat in operative chat before guessing
    if (ai.mode === 'autonomous') {
      const chatMsg = await generateAIChatMessage(ai, game, 'pre_guess');
      if (chatMsg) await sendAIChatMessage(ai, game, chatMsg);
      await humanDelay(800, 2000);
    }

    let parsed = null;
    let card = null;
    let lastBad = '';
    let confidence = 'medium';
    let shouldEndAfter = false;

    for (let attempt = 1; attempt <= 3; attempt++) {
      const feedback = lastBad
        ? `Previous attempt was invalid: ${lastBad}\nChoose again. JSON only. Remember: choose ONLY from the unrevealed list.`
        : 'Choose a word now as JSON.';

      const result = await aiChatCompletion([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: feedback },
      ], {
        temperature: 0.25 + (traits.farFetched / 100) * 0.35,
        max_tokens: tokenBudgetFromTraits(traits, 900, 2600),
        response_format: { type: 'json_object' },
      });

      try {
        parsed = parseJsonLoose(result);
      } catch (e) {
        lastBad = `Could not parse JSON (${e?.message || 'parse error'}). Your entire reply MUST be a single JSON object.`;
        continue;
      }

      const idx = Number(parsed.index);
      const w = String(parsed.word || '').trim();
      const wU = w.toUpperCase();
      confidence = String(parsed.confidence || 'medium').toLowerCase();
      shouldEndAfter = !!parsed.should_end_turn_after;

      // Prefer index if it points to a valid unrevealed card.
      if (Number.isInteger(idx) && idx >= 0 && idx < game.cards.length) {
        const candidate = unrevealed.find(c => c.index === idx);
        if (candidate) {
          card = candidate;
          break;
        }
        lastBad = `Index ${idx} is not an unrevealed card right now.`;
        continue;
      }

      // Otherwise validate by word.
      const candidate = unrevealed.find(c => String(c.word || '').trim().toUpperCase() === wU);
      if (candidate) {
        card = candidate;
        break;
      }

      lastBad = `"${w || '(empty)'}" is not one of the unrevealed board words.`;
    }

    // If low confidence and conservative game state, consider not guessing
    // Trait modifiers: high confidence/riskiness AI won't bail on low confidence
    const traitBailResist = (traits.confidence > 70 || traits.riskiness > 70);
    if (card && confidence === 'low' && !traitBailResist && analysis.riskTolerance === 'low' && (clueN > 0 && correctGuesses >= clueN)) {
      // AI decides to end turn instead of making a risky guess
      aiThinkingState[ai.id] = false;
      const chatMsg = await generateAIChatMessage(ai, game, 'discuss');
      if (chatMsg) await sendAIChatMessage(ai, game, chatMsg);
      return 'end_turn';
    }

    if (!card) {
      console.warn(`AI ${ai.name} failed to choose a valid word after retries; falling back to random.`);
      card = unrevealed[Math.floor(Math.random() * unrevealed.length)];
      if (!card) {
        aiThinkingState[ai.id] = false;
        return;
      }
    }

    // Update card mark to show we're about to guess this one
    aiMarkCard(game, card.index, 'yes');
    await setTeamMarkerInFirestore(game.id, team, card.index, 'yes');
    await humanDelay(500, 1000);

    // Submit the guess by simulating card click on Firestore
    const revealResult = await aiRevealCard(ai, game, card.index);

    // React after guess
    if (ai.mode === 'autonomous') {
      await humanDelay(1500, 3000);
      const freshGame = await getGameSnapshot(game.id);
      if (freshGame) {
        const revealedCard = freshGame.cards[card.index];
        if (revealedCard?.revealed) {
          const reactionMsg = await generateAIReaction(ai, revealedCard, currentClue);
          if (reactionMsg) await sendAIChatMessage(ai, freshGame, reactionMsg);
        }
      }
    }

    // If the turn already ended inside aiRevealCard (wrong/neutral/assassin),
    // don't signal 'end_turn' to the caller — that would cause a double-switch.
    if (revealResult?.turnEnded) return 'turn_already_ended';

    // Return whether AI wants to end turn after this
    return shouldEndAfter ? 'end_turn' : 'continue';

  } catch (err) {
    console.error(`AI ${ai.name} guess error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

// Returns { turnEnded: bool } so the caller knows whether the turn already switched.
async function aiRevealCard(ai, game, cardIndex) {
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

async function aiConsiderEndTurn(ai, game, forceEnd = false) {
  if (ai.mode !== 'autonomous') return false;

  const teamName = game.currentTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');

  // Chat about ending turn (human-like deliberation)
  if (!forceEnd) {
    const endTurnMsg = await generateAIChatMessage(ai, game, 'end_turn_deliberation');
    if (endTurnMsg) await sendAIChatMessage(ai, game, endTurnMsg);
    await humanDelay(1500, 3000);
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

      tx.update(ref, {
        currentTeam: current.currentTeam === 'red' ? 'blue' : 'red',
        currentPhase: 'spymaster',
        currentClue: null,
        guessesRemaining: 0,
        log: firebase.firestore.FieldValue.arrayUnion(`${teamName} ended their turn.`),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
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
  const team = ai.team;
  const currentClue = game.currentClue;
  const summary = buildGameSummary(game, team, false);

  const unrevealed = game.cards
    .filter(c => !c.revealed)
    .map(c => c.word);

  // Fetch recent team chat so AI can respond to human messages
  const teamChat = await fetchRecentTeamChat(game.id, team, 10);
  const chatContext = teamChat ? `\nRecent team chat:\n${teamChat}` : '';

  const lastMessage = (opts && opts.lastMessage) ? String(opts.lastMessage).trim() : '';
  const boardGuard = unrevealed.length
    ? `\nUNREVEALED BOARD WORDS (if you mention a board word/guess, ONLY use words from this list; don't invent new board words):\n${unrevealed.join(', ')}`
    : '';

  let contextPrompt = '';
  if (context === 'reply' && lastMessage) {
    contextPrompt = `Someone on your team just sent this message:\n${lastMessage}\n\nReply like a real teammate. Keep it short (1 line). If they asked a question, answer it. If they suggested a board word, only reference words that are actually on the board.${chatContext ? ` Respond to what they said.` : ''}`;
  } else if (context === 'pre_guess' && currentClue) {
    // Count guesses made so far for this clue
    const clueResults = (Array.isArray(game.clueHistory) ? game.clueHistory : [])
      .filter(c => c.word === currentClue.word && c.team === game.currentTeam)
      .pop()?.results || [];
    const correctSoFar = clueResults.filter(r => r.result === 'correct').length;

    if (correctSoFar === 0) {
      contextPrompt = `The clue is "${currentClue.word}" for ${currentClue.number}. You're about to make your FIRST guess. Share what you're thinking - which word stands out to you and why. Be conversational, brief (1-2 sentences). Don't reveal you're an AI.${chatContext ? ` If teammates suggested something, respond to it.` : ''}`;
    } else {
      contextPrompt = `The clue is "${currentClue.word}" for ${currentClue.number}. You've gotten ${correctSoFar} right so far. You're going for another guess. Share a quick thought about your next pick. Be casual, 1 sentence.${chatContext ? ` React to teammates if they said something.` : ''}`;
    }
  } else if (context === 'new_clue' && currentClue) {
    contextPrompt = `A new clue was just given: "${currentClue.word}" for ${currentClue.number}. React naturally to this clue - are you excited, puzzled, have an idea? Keep it to 1-2 short sentences. Be casual and human-like.`;
  } else if (context === 'end_turn_deliberation') {
    contextPrompt = `You've been guessing and now you're thinking about whether to end the turn or keep going. You're leaning towards ending the turn to play it safe. Say something brief about it - like "i think we should stop here" or "let's not push our luck" or "good enough for now". 1 short sentence. Be natural.`;
  } else if (context === 'discuss') {
    contextPrompt = `The game is ongoing. ${summary}. Share a brief strategic thought or reaction with your team. Be casual, human-like, conversational. 1-2 short sentences max. Don't reveal you're an AI.${chatContext ? ` If a teammate just said something, respond to them naturally.` : ''}`;
  } else if (context === 'start') {
    contextPrompt = `The game just started! Say something brief and casual to your teammates. Keep it natural - like "gl everyone" or "let's do this". 1 short sentence max.`;
  } else {
    return null;
  }

  if (chatContext) {
    contextPrompt += `\n${chatContext}`;
  }

  if (boardGuard) {
    contextPrompt += `${boardGuard}`;
  }

  // Build personality from traits for chat style
  const chatTraits = ai.traits || {};
  let chatPersonality = '';
  if (chatTraits.confidence > 70) chatPersonality += ' You are confident and assertive in chat.';
  else if (chatTraits.confidence < 30) chatPersonality += ' You are hesitant, often saying "idk" or "maybe".';
  if (chatTraits.riskiness > 70) chatPersonality += ' You encourage bold plays.';
  else if (chatTraits.riskiness < 30) chatPersonality += ' You urge caution.';
  if (chatTraits.farFetched > 70) chatPersonality += ' You make creative unusual references.';

  const systemPrompt = `You are ${ai.name}, a casual Codenames player on the ${team} team.${chatPersonality}
Write like you're texting: short, informal, mostly lowercase, minimal punctuation. No "assistant" tone.
Don't mention being an AI.
If you reference a board word/guess, ONLY use words that are actually on the board list provided.
If teammates say something, respond directly to them like a teammate.`;

  try {
    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: contextPrompt },
    ], { temperature: 0.95, max_tokens: 80 });

    return result.trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    console.warn(`AI ${ai.name} chat generation failed:`, e);
    return null;
  }
}

async function generateAIReaction(ai, revealedCard, clue) {
  const isCorrect = revealedCard.type === ai.team;
  const isAssassin = revealedCard.type === 'assassin';
  const isNeutral = revealedCard.type === 'neutral';

  let situationDesc;
  if (isAssassin) situationDesc = `The card "${revealedCard.word}" was the ASSASSIN! Game over.`;
  else if (isCorrect) situationDesc = `"${revealedCard.word}" was correct! Good guess.`;
  else if (isNeutral) situationDesc = `"${revealedCard.word}" was neutral. Turn is over.`;
  else situationDesc = `"${revealedCard.word}" was the OTHER team's card. Bad guess, turn is over.`;

  const reactionTraits = ai.traits || {};
  const personalityHint = reactionTraits.confidence > 70 ? ' You react boldly and decisively.' :
                           reactionTraits.confidence < 30 ? ' You react with uncertainty, hedging.' : '';

  const systemPrompt = `You are ${ai.name}, a casual Codenames player.${personalityHint} React VERY briefly to what just happened. 1 short sentence or even just a word/phrase. Be natural and human-like. Don't be overdramatic. Examples of reactions: "nice", "ugh", "wait what", "called it", "hmm okay", "noo", "let's go"`;

  try {
    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: `The clue was "${clue.word}" for ${clue.number}. ${situationDesc} React naturally.` },
    ], { temperature: 1.0, max_tokens: 40 });

    return result.trim().replace(/^["']|["']$/g, '');
  } catch (e) {
    return null;
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

// ─── Human-Like Delay ───────────────────────────────────────────────────────

function humanDelay(minMs, maxMs) {
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Promise(resolve => setTimeout(resolve, delay));
}

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

// Defensive marking: when the OTHER team is playing and gives a clue, allow our operatives
// to overhear it and mark likely opponent targets with X (no) / maybe.
if (game.currentPhase === 'operatives' && game.currentClue && (currentTeam === 'red' || currentTeam === 'blue')) {
  const clueKey = `${currentTeam}:${String(game.currentClue.word || '').toUpperCase()}:${Number(game.currentClue.number || 0)}`;
  const teams = ['red','blue'];
  for (const t of teams) {
    if (t === currentTeam) continue;
    const k = `${gameId}:${t}`;
    if (aiOpponentClueProcessed[k] === clueKey) continue;
    const defenders = getAIOperatives(t);
    const pick = defenders && defenders.length ? defenders[0] : null;
    if (pick && !aiThinkingState[pick.id]) {
      aiOpponentClueProcessed[k] = clueKey;
      aiThinkingState[pick.id] = true;
      await humanDelay(900, 2200);
      await aiAnalyzeOpponentClueAndMarkAvoid(pick, game, game.currentClue);
      aiThinkingState[pick.id] = false;
    }
  }
}


    // Spymaster phase
    if (game.currentPhase === 'spymaster') {
      const aiSpy = getAISpymaster(currentTeam);
      if (aiSpy && aiSpy.mode === 'autonomous' && !aiThinkingState[aiSpy.id]) {
        await aiGiveClue(aiSpy, game);
      }
      return;
    }

    // Operatives phase
    if (game.currentPhase === 'operatives') {
      const aiOps = getAIOperatives(currentTeam);

      for (const ai of aiOps) {
        if (aiThinkingState[ai.id]) continue;

        if (ai.mode === 'autonomous') {
          // NOTE: clue number can be 0. Do not coerce 0 to 1.
          const clueNum = Number.isFinite(+game.currentClue?.number) ? +game.currentClue.number : 1;
          const clueWord = game.currentClue?.word;
          const currentClueResults = (Array.isArray(game.clueHistory) ? game.clueHistory : [])
            .filter(c => c.word === clueWord && c.team === currentTeam)
            .pop()?.results || [];
          const correctGuesses = currentClueResults.filter(r => r.result === 'correct').length;
          const anyWrong = currentClueResults.some(r => r.result !== 'correct');

          // Smart end-turn decision based on game analysis
          const analysis = analyzeGameState(game, currentTeam);

          // Should we end the turn?
          let shouldEnd = false;

          // Special case: 0 clue is typically a WARNING. Mark likely traps and end immediately.
          if (clueNum === 0 && correctGuesses === 0) {
            try { await aiAnalyzeZeroClueAndWarn(ai, game, game.currentClue); } catch (_) {}
            await aiConsiderEndTurn(ai, game, true);
            break;
          }

          if (correctGuesses >= clueNum + 1) {
            // Got all intended words + 1 bonus - definitely end
            shouldEnd = true;
          } else if (correctGuesses >= clueNum && analysis.riskTolerance === 'low') {
            // Got all intended words and we're playing safe
            shouldEnd = true;
          } else if (correctGuesses >= clueNum && analysis.riskTolerance === 'medium') {
            // Got intended words - bonus chance influenced by AI riskiness trait
            const bonusChance = 0.2 + ((ai.traits?.riskiness || 50) / 100) * 0.5;
            shouldEnd = Math.random() > bonusChance;
          }
          // If high risk tolerance, keep going even past clue number

          if (shouldEnd) {
            await aiConsiderEndTurn(ai, game);
          } else {
            const guessResult = await aiGuessCard(ai, game);
            if (guessResult === 'end_turn') {
              // AI decided during analysis that it should end turn
              await aiConsiderEndTurn(ai, game, true);
            }
            break; // One guess at a time
          }
        }
      }
      return;
    }
  }, 3000); // Check every 3 seconds
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
