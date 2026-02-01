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
  'alex', 'jordan', 'morgan', 'casey', 'riley', 'quinn', 'avery', 'sage',
  'rowan', 'finley', 'skyler', 'blake', 'drew', 'reese', 'kai', 'nova',
  'max', 'sam', 'jamie', 'robin', 'frankie', 'charlie', 'pat', 'dana',
];

// ─── State ───────────────────────────────────────────────────────────────────
let aiPlayers = []; // { id, name, team, seatRole, mode, status, statusColor }
let aiIntervals = {}; // keyed by ai id → interval handle for game loop
let aiChatTimers = {}; // keyed by ai id → timeout for delayed chat
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
        mode: String(p.aiMode || 'autonomous'),
        // IMPORTANT: other clients may not have local ready-check state.
        // Derive the lobby indicator from Firestore ready flag so AIs don't show
        // "CHECKING" forever on non-host clients.
        statusColor: ready ? 'green' : 'none',
        ready,
        isAI: true,
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

// ─── Add / Remove AI Players ────────────────────────────────────────────────

function getUsedAINames() {
  return new Set(aiPlayers.map(a => a.name));
}

function pickAIName() {
  const used = getUsedAINames();
  const available = AI_NAMES.filter(n => !used.has(n));
  if (available.length === 0) return `ai_${aiNextId}`;
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
    mode, // 'helper' or 'autonomous'
    statusColor: 'none', // 'none' → 'red'|'yellow'|'green'
    ready: false,
    isAI: true,
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
  const history = game.clueHistory || [];
  if (!history.length) return 'No clues given yet.';
  return history.map(c => {
    const results = (c.results || []).map(r => `${r.word}(${r.result})`).join(', ');
    return `${c.team.toUpperCase()} clue: "${c.word}" for ${c.number}${results ? ` → guesses: ${results}` : ''}`;
  }).join('\n');
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

// ─── AI Spymaster: Give Clue (Structured Output) ───────────────────────────

async function aiGiveClue(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  const team = ai.team;
  const boardContext = buildBoardContext(game, true);
  const clueHistory = buildClueHistoryContext(game);
  const summary = buildGameSummary(game, team, true);
  const teamContext = buildTeamContext(game, team);

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

  const systemPrompt = `You are a Codenames Spymaster for the ${team.toUpperCase()} team. Your job is to give a ONE-WORD clue and a number indicating how many cards on the board relate to that clue.

RULES:
- Your clue must be a SINGLE word (no spaces, no hyphens, no compound words).
- Your clue CANNOT be any word currently on the board: ${boardWords.join(', ')}
- The number indicates how many of YOUR team's unrevealed cards relate to the clue.
- AVOID clues that might lead teammates to guess assassin words: ${assassinWords.join(', ')}
- AVOID clues that relate to the opponent's words: ${theirWords.join(', ')}
- Try to connect multiple of your words with one clue for maximum efficiency.
- Be strategic. Consider what words have already been revealed and what clues have been given.

YOUR TEAM'S UNREVEALED WORDS: ${ourWords.join(', ')}
OPPONENT'S UNREVEALED WORDS: ${theirWords.join(', ')}
NEUTRAL WORDS: ${neutralWords.join(', ')}
ASSASSIN WORDS: ${assassinWords.join(', ')}

${clueHistory}
${summary}
Team: ${teamContext}

Respond with valid JSON: {"clue": "YOURWORD", "number": N, "reasoning": "brief explanation of which words you're connecting"}`;

  try {
    // Add a human-like thinking delay (2-8 seconds)
    await humanDelay(2000, 8000);

    // First, chat about thinking (if autonomous)
    if (ai.mode === 'autonomous') {
      // Don't chat about strategy since spymaster shouldn't reveal info
    }

    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Give your clue now as JSON.' },
    ], {
      temperature: 0.7,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      // Try to extract JSON from the response
      const match = result.match(/\{[\s\S]*?\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse clue JSON');
    }

    const clueWord = String(parsed.clue || '').trim().toUpperCase();
    const clueNumber = Math.max(0, Math.min(9, parseInt(parsed.number, 10) || 1));

    // Validate: must be single word, not on board
    if (!clueWord || clueWord.includes(' ') || boardWords.includes(clueWord)) {
      console.warn(`AI ${ai.name} gave invalid clue: "${clueWord}", retrying...`);
      aiThinkingState[ai.id] = false;
      return;
    }

    // Submit the clue to Firestore
    const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
    const clueEntry = {
      team: game.currentTeam,
      word: clueWord,
      number: clueNumber,
      results: [],
      timestamp: new Date().toISOString(),
    };

    await db.collection('games').doc(game.id).update({
      currentClue: { word: clueWord, number: clueNumber },
      guessesRemaining: clueNumber + 1,
      currentPhase: 'operatives',
      log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`),
      clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });

    if (window.playSound) window.playSound('clueGiven');

  } catch (err) {
    console.error(`AI ${ai.name} clue error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

// ─── AI Operative: Guess Card (Structured Output) ──────────────────────────

async function aiGuessCard(ai, game) {
  if (aiThinkingState[ai.id]) return;
  aiThinkingState[ai.id] = true;

  const team = ai.team;
  const boardContext = buildBoardContext(game, false);
  const clueHistory = buildClueHistoryContext(game);
  const summary = buildGameSummary(game, team, false);
  const currentClue = game.currentClue;

  if (!currentClue) {
    aiThinkingState[ai.id] = false;
    return;
  }

  const unrevealed = game.cards
    .map((c, i) => ({ word: c.word, index: i, revealed: c.revealed }))
    .filter(c => !c.revealed);

  const systemPrompt = `You are a Codenames Operative on the ${team.toUpperCase()} team. Your Spymaster just gave the clue "${currentClue.word}" for ${currentClue.number}.

BOARD (unrevealed words):
${unrevealed.map(c => `- ${c.word}`).join('\n')}

${clueHistory}
${summary}

Your job: Pick the word that BEST matches the clue "${currentClue.word}". Think about semantic connections, categories, associations.

You have ${game.guessesRemaining} guesses remaining.

${ai.mode === 'autonomous' ? 'You are confident and decisive. Pick the word you think is most likely correct.' : ''}

Respond with valid JSON: {"word": "CHOSENWORD", "confidence": "high/medium/low", "reasoning": "why this word connects to the clue"}`;

  try {
    // Human-like thinking delay (3-10 seconds)
    await humanDelay(3000, 10000);

    // Chat in operative chat before guessing
    if (ai.mode === 'autonomous') {
      const chatMsg = await generateAIChatMessage(ai, game, 'pre_guess');
      if (chatMsg) await sendAIChatMessage(ai, game, chatMsg);
      await humanDelay(1000, 3000);
    }

    const result = await aiChatCompletion([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Choose a word now as JSON.' },
    ], {
      temperature: 0.6,
      max_tokens: 256,
      response_format: { type: 'json_object' },
    });

    let parsed;
    try {
      parsed = JSON.parse(result);
    } catch {
      const match = result.match(/\{[\s\S]*?\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error('Could not parse guess JSON');
    }

    const chosenWord = String(parsed.word || '').trim().toUpperCase();
    const card = unrevealed.find(c => c.word.toUpperCase() === chosenWord);

    if (!card) {
      console.warn(`AI ${ai.name} chose invalid word: "${chosenWord}"`);
      // Fall back: pick a random unrevealed card
      aiThinkingState[ai.id] = false;
      return;
    }

    // Submit the guess by simulating card click on Firestore
    await aiRevealCard(ai, game, card.index);

    // React after guess
    if (ai.mode === 'autonomous' || ai.mode === 'helper') {
      await humanDelay(1000, 2000);
      const freshGame = await getGameSnapshot(game.id);
      if (freshGame) {
        const revealedCard = freshGame.cards[card.index];
        if (revealedCard?.revealed) {
          const reactionMsg = await generateAIReaction(ai, revealedCard, currentClue);
          if (reactionMsg) await sendAIChatMessage(ai, freshGame, reactionMsg);
        }
      }
    }

  } catch (err) {
    console.error(`AI ${ai.name} guess error:`, err);
  } finally {
    aiThinkingState[ai.id] = false;
  }
}

async function aiRevealCard(ai, game, cardIndex) {
  const card = game.cards[cardIndex];
  if (!card || card.revealed) return;

  const updatedCards = [...game.cards];
  updatedCards[cardIndex] = { ...card, revealed: true };

  const teamName = game.currentTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  const updates = {
    cards: updatedCards,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };

  let logEntry = `${teamName} guessed "${card.word}" - `;
  let endTurn = false;
  let winner = null;

  if (card.type === 'assassin') {
    winner = game.currentTeam === 'red' ? 'blue' : 'red';
    logEntry += 'ASSASSIN! Game over.';
  } else if (card.type === game.currentTeam) {
    logEntry += 'Correct!';
    if (game.currentTeam === 'red') {
      updates.redCardsLeft = game.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = game.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }
    updates.guessesRemaining = game.guessesRemaining - 1;
    if (updates.guessesRemaining <= 0 && !winner) endTurn = true;
  } else if (card.type === 'neutral') {
    logEntry += 'Neutral. Turn ends.';
    endTurn = true;
  } else {
    logEntry += `Wrong! (${card.type === 'red' ? (game.redTeamName || 'Red') : (game.blueTeamName || 'Blue')}'s card)`;
    if (card.type === 'red') {
      updates.redCardsLeft = game.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = game.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }
    endTurn = true;
  }

  // We need to write both the guess log and (optionally) the winner log.
  // Firestore arrayUnion can't be stacked on the same field in one update,
  // so we'll do the guess log first, then a second update for the win.
  let winnerLogEntry = null;

  if (winner) {
    updates.winner = winner;
    updates.currentPhase = 'ended';
    const winnerName = winner === 'red' ? (game.redTeamName || 'Red') : (game.blueTeamName || 'Blue');
    winnerLogEntry = `${winnerName} wins!`;
  } else if (endTurn) {
    updates.currentTeam = game.currentTeam === 'red' ? 'blue' : 'red';
    updates.currentPhase = 'spymaster';
    updates.currentClue = null;
    updates.guessesRemaining = 0;
  }

  try {
    // Write the guess log entry
    updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);
    await db.collection('games').doc(game.id).update(updates);

    // Write the winner log entry separately so it doesn't overwrite the guess log
    if (winnerLogEntry) {
      await db.collection('games').doc(game.id).update({
        log: firebase.firestore.FieldValue.arrayUnion(winnerLogEntry),
      });
    }

    // Update clue history
    if (game.currentClue?.word) {
      const guessResult = {
        word: card.word,
        result: card.type === 'assassin' ? 'assassin' : (card.type === game.currentTeam ? 'correct' : (card.type === 'neutral' ? 'neutral' : 'wrong')),
        type: card.type,
        by: ai.name,
        timestamp: new Date().toISOString(),
      };
      await addGuessToClueHistory(game.id, game.currentTeam, game.currentClue.word, game.currentClue.number, guessResult);
    }

    if (window.playSound) window.playSound('cardReveal');
  } catch (e) {
    console.error(`AI ${ai.name} reveal card error:`, e);
  }
}

// ─── AI End Turn Decision ───────────────────────────────────────────────────

async function aiConsiderEndTurn(ai, game) {
  if (ai.mode !== 'autonomous') return false;
  if (game.guessesRemaining > 0) return false;

  // Auto end turn when no guesses left
  const teamName = game.currentTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  try {
    await db.collection('games').doc(game.id).update({
      currentTeam: game.currentTeam === 'red' ? 'blue' : 'red',
      currentPhase: 'spymaster',
      currentClue: null,
      guessesRemaining: 0,
      log: firebase.firestore.FieldValue.arrayUnion(`${teamName} ended their turn.`),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    return true;
  } catch (e) {
    console.error(`AI ${ai.name} end turn error:`, e);
    return false;
  }
}

// ─── AI Chat & Reactions ────────────────────────────────────────────────────

async function generateAIChatMessage(ai, game, context) {
  const team = ai.team;
  const currentClue = game.currentClue;
  const summary = buildGameSummary(game, team, false);

  const unrevealed = game.cards
    .filter(c => !c.revealed)
    .map(c => c.word);

  let contextPrompt = '';
  if (context === 'pre_guess' && currentClue) {
    contextPrompt = `The clue is "${currentClue.word}" for ${currentClue.number}. You're about to guess. Share a brief thought with your team about what you're thinking. Be conversational and natural - like a real person chatting. Keep it to 1-2 short sentences. Don't reveal you're an AI.`;
  } else if (context === 'new_clue' && currentClue) {
    contextPrompt = `A new clue was just given: "${currentClue.word}" for ${currentClue.number}. React naturally to this clue - are you excited, puzzled, have an idea? Keep it to 1-2 short sentences. Be casual and human-like.`;
  } else if (context === 'discuss') {
    contextPrompt = `The game is ongoing. ${summary}. Share a brief strategic thought or reaction with your team. Be casual, human-like, conversational. 1-2 short sentences max. Don't reveal you're an AI.`;
  } else if (context === 'start') {
    contextPrompt = `The game just started! Say something brief and casual to your teammates. Keep it natural - like "gl everyone" or "let's do this". 1 short sentence max.`;
  } else {
    return null;
  }

  const systemPrompt = `You are ${ai.name}, a casual Codenames player on the ${team} team. You chat naturally in short, informal messages. No emojis unless it feels natural. Don't be overly enthusiastic. Sound like a real person in a game chat. Never mention being an AI. Never use formal language. Keep responses very brief.`;

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

  const systemPrompt = `You are ${ai.name}, a casual Codenames player. React VERY briefly to what just happened. 1 short sentence or even just a word/phrase. Be natural and human-like. Don't be overdramatic. Examples of reactions: "nice", "ugh", "wait what", "called it", "hmm okay", "noo", "let's go"`;

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
        senderName: ai.name,
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
  } catch (e) {
    console.error(`AI ${ai.name} send chat error:`, e);
  }
}

// ─── AI Helper Mode: Observe & React ────────────────────────────────────────

async function aiHelperObserve(ai, game) {
  // Helper mode: react to clues, discuss strategy in chat, but NEVER guess or give clues
  if (ai.seatRole === 'spymaster') return; // Helpers can't be spymasters

  const team = ai.team;
  if (game.currentTeam !== team) return;

  // React to new clues
  if (game.currentPhase === 'operatives' && game.currentClue) {
    const chatMsg = await generateAIChatMessage(ai, game, 'new_clue');
    if (chatMsg) await sendAIChatMessage(ai, game, chatMsg);
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
          // Autonomous: make guesses
          if (game.guessesRemaining > 0) {
            await aiGuessCard(ai, game);
            break; // One guess at a time
          } else {
            await aiConsiderEndTurn(ai, game);
          }
        } else if (ai.mode === 'helper') {
          // Helper: just chat and react
          await aiHelperObserve(ai, game);
        }
      }

      // Also let helper AIs on the current team chat
      const helperAIs = aiOps.filter(a => a.mode === 'helper');
      for (const helper of helperAIs) {
        if (!aiThinkingState[helper.id] && Math.random() < 0.15) {
          aiThinkingState[helper.id] = true;
          const msg = await generateAIChatMessage(helper, game, 'discuss');
          if (msg) await sendAIChatMessage(helper, game, msg);
          aiThinkingState[helper.id] = false;
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
