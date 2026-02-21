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
  // Chat/reaction model. For more "human" banter, many teams like NousResearch's Hermes
  // family (built for dialogue/roleplay). If your Nebius account has it, try:
  //   'NousResearch/Hermes-3-Llama-3.1-70B'
  // Otherwise keep a Llama Instruct model.
  model: 'meta-llama/Llama-3.3-70B-Instruct',
  reasoningModel: 'deepseek-ai/DeepSeek-R1-0528',        // reasoning brain — strategic decisions
  // Brain-part defaults. Runtime can override these with the best currently
  // available Nebius models discovered from /v1/models.
  brainRoleModels: {
    instruction: 'meta-llama/Llama-3.3-70B-Instruct',
    reasoning: 'deepseek-ai/DeepSeek-R1-0528',
    dialogue: 'meta-llama/Llama-3.3-70B-Instruct',
    reaction: 'meta-llama/Llama-3.1-8B-Instruct',
    scout: 'meta-llama/Llama-3.1-8B-Instruct',
    mind: 'meta-llama/Llama-3.3-70B-Instruct',
  },
  enableNebiusModelRouting: true,
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
let aiLastActionReactionMs = {}; // keyed by ai id → last log-driven reaction
const aiSeenActionReactionEvents = new Map(); // eventKey -> ms
const aiLastTimePressureReactionByTeam = {}; // `${gameId}:${team}` -> bucket
let aiGameLoopTickInFlight = false;
let aiChatScanCursor = 0;
let aiNextId = 1;
const aiTeamChatQueryCache = new Map(); // key => { at, docs, text, inFlight }
const aiGlobalVisionSigByGame = new Map(); // gameId => signature

const AI_BRAIN_ROLES = Object.freeze({
  instruction: 'instruction',
  reasoning: 'reasoning',
  dialogue: 'dialogue',
  reaction: 'reaction',
  scout: 'scout',
  mind: 'mind',
});

const AI_MODEL_CATALOG_TTL_MS = 10 * 60 * 1000;
const AI_MODEL_CATALOG_RETRY_MS = 30 * 1000;

const aiNebiusModelsState = {
  fetchedAt: 0,
  failedAt: 0,
  models: [],
  roleCandidates: {},
  inFlight: null,
};

// ─── Emotion helpers (for in-the-moment reactions) ─────────────────────────
function _clamp(n, lo, hi) { n = Number(n); if (!Number.isFinite(n)) return lo; return Math.max(lo, Math.min(hi, n)); }

function _baselineEmotionalIntensity(persona) {
  try {
    const s = persona && persona.stats ? persona.stats : {};
    const base = Number(s.emotional_intensity);
    return _clamp(Number.isFinite(base) ? base : 45, 1, 100);
  } catch (_) {
    return 45;
  }
}

function describeEmotion(core) {
  try {
    const val = Number(core?.emotion?.valence || 0); // -100..100
    const ar = Number(core?.emotion?.arousal || 35); // 0..100
    const intensity = _clamp(Number(core?.emotion?.intensity || 45), 1, 100);
    // Coarse buckets the model can use as a style steer.
    let mood = 'neutral';
    if (val <= -70) mood = 'tilted';
    else if (val <= -55) mood = 'angry';
    else if (val <= -30) mood = 'annoyed';
    else if (val >= 70) mood = 'ecstatic';
    else if (val >= 55) mood = 'hyped';
    else if (val >= 30) mood = 'happy';
    else mood = 'neutral';
    const energy = ar >= 70 ? 'high-energy' : (ar <= 25 ? 'low-energy' : 'steady');
    const socialTone = (mood === 'tilted' || mood === 'angry')
      ? (intensity >= 60 ? 'sharp' : 'guarded')
      : ((mood === 'happy' || mood === 'hyped' || mood === 'ecstatic')
        ? (intensity >= 58 ? 'warm' : 'supportive')
        : 'measured');
    return {
      mood,
      energy,
      socialTone,
      intensity,
      valence: _clamp(val, -100, 100),
      arousal: _clamp(ar, 0, 100)
    };
  } catch (_) {
    return { mood: 'neutral', energy: 'steady', socialTone: 'measured', intensity: 45, valence: 0, arousal: 35 };
  }
}

function bumpEmotion(ai, dv = 0, da = 0) {
  try {
    const core = ensureAICore(ai);
    if (!core) return;
    if (!core.emotion) core.emotion = { valence: 0, arousal: 35, intensity: _baselineEmotionalIntensity(core.personality) };
    core.emotion.valence = _clamp((core.emotion.valence || 0) + Number(dv || 0), -100, 100);
    core.emotion.arousal = _clamp((core.emotion.arousal || 35) + Number(da || 0), 0, 100);
  } catch (_) {}
}

function _emotionBaseValence(core) {
  try {
    const stats = core?.personality?.stats || {};
    const confidence = _clamp(Number(stats.confidence ?? 55), 1, 100);
    const teamSpirit = _clamp(Number(stats.team_spirit ?? 50), 1, 100);
    const competitiveness = _clamp(Number(stats.competitiveness ?? 50), 1, 100);
    return _clamp(
      ((confidence - 50) * 0.38) + ((teamSpirit - 50) * 0.34) + ((competitiveness - 50) * 0.12),
      -26,
      26
    );
  } catch (_) {
    return 0;
  }
}

function _emotionBaseArousal(core) {
  try {
    const stats = core?.personality?.stats || {};
    const tempo = _clamp(Number(stats.tempo ?? stats.speed ?? 60), 1, 100);
    const intensity = _baselineEmotionalIntensity(core?.personality);
    return _clamp(18 + (tempo * 0.36) + (intensity * 0.42), 18, 84);
  } catch (_) {
    return 35;
  }
}

function _teamWordsLeftFromVision(vision, team) {
  try {
    const score = vision?.score;
    if (!score) return null;
    if (String(team || '') === 'red') return Number(score.redLeft);
    if (String(team || '') === 'blue') return Number(score.blueLeft);
    return null;
  } catch (_) {
    return null;
  }
}

function _remainingSecondsFromGameTimer(game) {
  try {
    const end = game?.timerEnd;
    const endMs = (typeof end?.toMillis === 'function')
      ? end.toMillis()
      : (end instanceof Date ? end.getTime() : Number(end));
    if (!Number.isFinite(endMs)) return null;
    return Math.max(0, Math.round((endMs - Date.now()) / 1000));
  } catch (_) {
    return null;
  }
}

function applyEmotionDriftFromState(ai, game, vision, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return;
    if (!core.emotion) {
      core.emotion = {
        valence: 0,
        arousal: 35,
        intensity: _baselineEmotionalIntensity(core.personality),
      };
    }
    const now = Date.now();
    const force = !!opts.force;
    const minGapMs = force ? 120 : 1400;
    if (!force && (now - Number(core.lastEmotionDriftAt || 0)) < minGapMs) return;

    const me = String(ai?.team || '').toLowerCase();
    const opp = me === 'red' ? 'blue' : 'red';
    const phase = String(vision?.phase || game?.currentPhase || '').toLowerCase();
    const currentTeam = String(vision?.currentTeam || game?.currentTeam || '').toLowerCase();

    let dv = 0;
    let da = 0;

    const myLeft = _teamWordsLeftFromVision(vision, me);
    const oppLeft = _teamWordsLeftFromVision(vision, opp);
    if (Number.isFinite(myLeft) && Number.isFinite(oppLeft)) {
      const lead = oppLeft - myLeft; // positive means we are ahead
      dv += _clamp(lead * 2.35, -13, 13);
      if (myLeft <= 2) da += 8;
      if (oppLeft <= 2) da += 6;
    }

    const clueStackRows = Array.isArray(vision?.clueStack) ? vision.clueStack : [];
    const unresolvedTotal = clueStackRows.reduce((sum, row) => sum + Math.max(0, Number(row?.remainingTargets || 0)), 0);
    if (phase === 'operatives' && currentTeam === me) {
      if (unresolvedTotal >= 3) {
        da += Math.min(9, unresolvedTotal * 0.95);
        dv -= Math.min(8, unresolvedTotal * 0.52);
      }
      const guessesLeft = Number(vision?.guessesRemaining);
      if (Number.isFinite(guessesLeft)) {
        if (guessesLeft <= 1) da += 4;
        else da += Math.min(7, guessesLeft * 0.9);
      }
    }

    let secs = Number(vision?.secondsRemaining);
    if (!Number.isFinite(secs)) secs = _remainingSecondsFromGameTimer(game);
    if (Number.isFinite(secs)) {
      if (secs <= 7) { da += 15; dv -= 4; }
      else if (secs <= 20) { da += 8; dv -= 2; }
      else if (secs <= 45) { da += 3; }
    }

    const eventKind = String(opts.eventKind || '').toLowerCase();
    if (eventKind) {
      if (/guess_assassin/.test(eventKind)) { dv -= 45; da += 28; }
      else if (/guess_wrong|guess_neutral/.test(eventKind)) { dv -= 15; da += 12; }
      else if (/guess_correct/.test(eventKind)) { dv += 11; da += 6; }
      else if (/time_pressure/.test(eventKind)) { da += 8; }
      else if (/quick_guess_no_consensus/.test(eventKind)) { dv -= 7; da += 10; }
    }

    if (String(game?.winner || '').toLowerCase() === me) { dv += 32; da -= 6; }
    else if (String(game?.winner || '').toLowerCase() === opp) { dv -= 34; da += 7; }

    const curVal = Number(core.emotion.valence || 0);
    const curAro = Number(core.emotion.arousal || 35);
    const baseVal = _emotionBaseValence(core);
    const baseAro = _emotionBaseArousal(core);
    dv += (baseVal - curVal) * (force ? 0.22 : 0.09);
    da += (baseAro - curAro) * (force ? 0.24 : 0.11);

    bumpEmotion(ai, dv, da);
    core.lastEmotionDriftAt = now;
  } catch (_) {}
}

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
  try { primeNebiusModelCatalog(); } catch (_) {}

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

function _stableHash(input) {
  const s = String(input || '');
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function _normalizeBrainRole(role, fallback = AI_BRAIN_ROLES.dialogue) {
  const r = String(role || '').toLowerCase().trim();
  if (AI_BRAIN_ROLES[r]) return r;
  return fallback;
}

function _defaultModelForBrainRole(role) {
  const r = _normalizeBrainRole(role, AI_BRAIN_ROLES.dialogue);
  const roleDefaults = (AI_CONFIG && typeof AI_CONFIG.brainRoleModels === 'object') ? AI_CONFIG.brainRoleModels : {};
  if (roleDefaults && roleDefaults[r]) return String(roleDefaults[r]);
  if (r === AI_BRAIN_ROLES.reasoning) return String(AI_CONFIG.reasoningModel || AI_CONFIG.model);
  return String(AI_CONFIG.model);
}

function _extractModelId(raw) {
  if (!raw) return '';
  const id = raw.id || raw.model || raw.name || raw.slug || raw.identifier;
  return String(id || '').trim();
}

function _modelMetaText(raw) {
  if (!raw || typeof raw !== 'object') return '';
  try {
    const parts = [];
    const fields = ['description', 'provider', 'family', 'task', 'type', 'modality', 'capabilities'];
    for (const f of fields) {
      if (raw[f]) parts.push(String(raw[f]));
    }
    if (Array.isArray(raw.tags)) parts.push(raw.tags.join(' '));
    if (Array.isArray(raw.modalities)) parts.push(raw.modalities.join(' '));
    if (Array.isArray(raw.input_modalities)) parts.push(raw.input_modalities.join(' '));
    if (Array.isArray(raw.output_modalities)) parts.push(raw.output_modalities.join(' '));
    return parts.join(' ').toLowerCase();
  } catch (_) {
    return '';
  }
}

function _extractSizeB(lowerModelId) {
  const m = String(lowerModelId || '').match(/(\d+(?:\.\d+)?)\s*b\b/i);
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) ? n : null;
}

function _isLikelyChatGenerationModel(lowerModelId, metaText) {
  const id = String(lowerModelId || '').toLowerCase();
  const meta = String(metaText || '').toLowerCase();
  const text = `${id} ${meta}`;

  // Exclude clearly non-chat endpoints.
  if (/(embedding|embed|rerank|text-embedding|speech|audio|asr|whisper|tts|transcri|vision-only|image|diffusion|sdxl|flux|moderation)/.test(text)) {
    return false;
  }

  // Keep likely instruction/chat models.
  if (/(instruct|chat|assistant|reason|r1|hermes|llama|qwen|mistral|nemotron|deepseek|phi|gemma|command|mixtral|yi)/.test(text)) {
    return true;
  }

  // Default to true for unknown text models; routing fallback still exists.
  return true;
}

function _scoreNebiusModelForRole(model, role) {
  const r = _normalizeBrainRole(role, AI_BRAIN_ROLES.dialogue);
  const id = String(model?.id || '').toLowerCase();
  const meta = String(model?.meta || '').toLowerCase();
  const text = `${id} ${meta}`;
  const sizeB = _extractSizeB(id);
  let score = 0;

  // Broad quality priors.
  if (/(instruct|chat|assistant)/.test(text)) score += 26;
  if (/(llama|qwen|mistral|mixtral|deepseek|nemotron|hermes|phi|gemma|command)/.test(text)) score += 16;
  if (/(preview|experimental|beta)/.test(text)) score -= 5;

  if (r === AI_BRAIN_ROLES.reasoning) {
    if (/(reason|r1|qwq|o1|think|cot)/.test(text)) score += 62;
    if (/(deepseek\-r1|deepseek[\s\-]?r1)/.test(text)) score += 30;
    if (sizeB !== null) {
      if (sizeB >= 32) score += 10;
      if (sizeB <= 10) score -= 10;
    }
  } else if (r === AI_BRAIN_ROLES.instruction) {
    if (/(instruct|chat|assistant)/.test(text)) score += 22;
    if (/(r1|reason)/.test(text)) score += 6;
  } else if (r === AI_BRAIN_ROLES.dialogue) {
    if (/(hermes|chat|assistant|roleplay)/.test(text)) score += 28;
    if (/(instruct)/.test(text)) score += 14;
    if (/(r1|reasoning|reasoner|deepseek\-r1|qwq|o1)/.test(text)) score -= 8;
    if (sizeB !== null && sizeB >= 30) score += 6;
  } else if (r === AI_BRAIN_ROLES.reaction) {
    if (/(chat|assistant|instruct)/.test(text)) score += 16;
    if (sizeB !== null) {
      if (sizeB <= 14) score += 14;
      if (sizeB > 40) score -= 6;
    }
  } else if (r === AI_BRAIN_ROLES.scout) {
    if (/(chat|assistant|instruct)/.test(text)) score += 16;
    if (/(reason|r1)/.test(text)) score += 5;
    if (sizeB !== null) {
      if (sizeB <= 14) score += 16;
      if (sizeB > 40) score -= 8;
    }
  } else if (r === AI_BRAIN_ROLES.mind) {
    if (/(chat|assistant|instruct|reason)/.test(text)) score += 18;
    if (sizeB !== null && sizeB >= 14) score += 4;
  }

  return score;
}

function _rankModelsForRole(models, role) {
  const list = Array.isArray(models) ? models : [];
  return list
    .map((m) => ({ ...m, _score: _scoreNebiusModelForRole(m, role) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 12);
}

function _rebuildNebiusRoleCandidates(models) {
  const roles = Object.keys(AI_BRAIN_ROLES);
  const out = {};
  for (const role of roles) {
    out[role] = _rankModelsForRole(models, role);
  }
  return out;
}

function _parseNebiusModelPayload(payload) {
  const rawModels = Array.isArray(payload?.data)
    ? payload.data
    : (Array.isArray(payload?.models) ? payload.models : []);
  const out = [];
  const seen = new Set();
  for (const raw of rawModels) {
    const id = _extractModelId(raw);
    if (!id || seen.has(id)) continue;
    const meta = _modelMetaText(raw);
    if (!_isLikelyChatGenerationModel(id.toLowerCase(), meta)) continue;
    seen.add(id);
    out.push({ id, raw, meta });
  }
  return out;
}

async function fetchNebiusModelCatalog(options = {}) {
  const force = !!options.force;
  if (!AI_CONFIG.enableNebiusModelRouting) return aiNebiusModelsState.models;

  const now = Date.now();
  if (!force && aiNebiusModelsState.models.length && (now - aiNebiusModelsState.fetchedAt) < AI_MODEL_CATALOG_TTL_MS) {
    return aiNebiusModelsState.models;
  }
  if (!AI_CONFIG.apiKey) return aiNebiusModelsState.models;
  if (aiNebiusModelsState.inFlight) return aiNebiusModelsState.inFlight;
  if (!force && aiNebiusModelsState.failedAt && (now - aiNebiusModelsState.failedAt) < AI_MODEL_CATALOG_RETRY_MS) {
    return aiNebiusModelsState.models;
  }

  aiNebiusModelsState.inFlight = (async () => {
    const urls = [
      `${AI_CONFIG.baseURL}/models?verbose=true`,
      `${AI_CONFIG.baseURL}/models`,
    ];
    let lastErr = null;
    for (const url of urls) {
      try {
        const resp = await fetch(url, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AI_CONFIG.apiKey}`,
          },
        });
        if (!resp.ok) {
          lastErr = new Error(`model catalog ${resp.status}`);
          continue;
        }
        const data = await resp.json();
        const models = _parseNebiusModelPayload(data);
        if (models.length) {
          aiNebiusModelsState.models = models;
          aiNebiusModelsState.fetchedAt = Date.now();
          aiNebiusModelsState.failedAt = 0;
          aiNebiusModelsState.roleCandidates = _rebuildNebiusRoleCandidates(models);
          return models;
        }
      } catch (err) {
        lastErr = err;
      }
    }
    aiNebiusModelsState.failedAt = Date.now();
    if (lastErr) throw lastErr;
    return aiNebiusModelsState.models;
  })();

  try {
    return await aiNebiusModelsState.inFlight;
  } finally {
    aiNebiusModelsState.inFlight = null;
  }
}

function primeNebiusModelCatalog() {
  if (!AI_CONFIG.enableNebiusModelRouting || !AI_CONFIG.apiKey) return;
  fetchNebiusModelCatalog().catch(() => {});
}

function _pickModelDeterministically(candidates, aiId, role) {
  const list = Array.isArray(candidates) ? candidates.filter(Boolean) : [];
  if (!list.length) return '';
  const r = _normalizeBrainRole(role, AI_BRAIN_ROLES.dialogue);
  if (r === AI_BRAIN_ROLES.reasoning || r === AI_BRAIN_ROLES.instruction || r === AI_BRAIN_ROLES.mind) {
    return String(list[0]?.id || '');
  }
  const topN = Math.max(1, Math.min((r === AI_BRAIN_ROLES.dialogue ? 4 : 3), list.length));
  const idx = _stableHash(`${String(aiId || 'anon')}|${String(role || '')}`) % topN;
  const chosen = list[idx];
  return String(chosen?.id || '');
}

function _buildModelRoutingForAI(ai) {
  const roles = Object.keys(AI_BRAIN_ROLES);
  const route = {};
  for (const role of roles) {
    const candidates = aiNebiusModelsState.roleCandidates?.[role] || [];
    route[role] = _pickModelDeterministically(candidates, ai?.id || ai?.odId || ai?.name || 'anon', role)
      || _defaultModelForBrainRole(role);
  }
  return route;
}

function _resolveModelForCall(options = {}, fallbackRole = AI_BRAIN_ROLES.dialogue) {
  const explicit = String(options?.model || '').trim();
  if (explicit) return explicit;

  const role = _normalizeBrainRole(options?.brainRole, fallbackRole);
  const ai = options?.ai || null;
  if (!ai || !AI_CONFIG.enableNebiusModelRouting) return _defaultModelForBrainRole(role);

  const core = ensureAICore(ai);
  if (!core) return _defaultModelForBrainRole(role);
  const stamp = Number(aiNebiusModelsState.fetchedAt || 0);
  if (!core.modelRouting || core.modelRoutingStamp !== stamp) {
    core.modelRouting = _buildModelRoutingForAI(ai);
    core.modelRoutingStamp = stamp;
  }

  return String(core.modelRouting?.[role] || _defaultModelForBrainRole(role));
}

async function aiChatCompletion(messages, options = {}) {

  if (!ensureAIKeyPresent()) {
    throw new Error('Missing AI API key. Set localStorage "ct_ai_apiKey" (or paste when prompted) before using AI players.');
  }

  if (AI_CONFIG.enableNebiusModelRouting && !aiNebiusModelsState.models.length) {
    try { await fetchNebiusModelCatalog(); } catch (_) {}
  } else {
    primeNebiusModelCatalog();
  }

  const role = _normalizeBrainRole(options.brainRole, AI_BRAIN_ROLES.dialogue);
  const body = {
    model: _resolveModelForCall(options, role),
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

  if (AI_CONFIG.enableNebiusModelRouting && !aiNebiusModelsState.models.length) {
    try { await fetchNebiusModelCatalog(); } catch (_) {}
  } else {
    primeNebiusModelCatalog();
  }

  const role = _normalizeBrainRole(options.brainRole, AI_BRAIN_ROLES.reasoning);
  const body = {
    model: _resolveModelForCall(options, role),
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
window.fetchNebiusModelCatalog = fetchNebiusModelCatalog;

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

function _teamChatCacheKey(gameId, teamColor, limit) {
  return `${String(gameId || '').trim()}|${String(teamColor || '').trim().toLowerCase()}|${Math.max(1, Number(limit || 12) | 0)}`;
}

function _invalidateTeamChatCache(gameId, teamColor = '') {
  try {
    const gid = String(gameId || '').trim();
    const team = String(teamColor || '').trim().toLowerCase();
    if (!gid) return;
    for (const key of aiTeamChatQueryCache.keys()) {
      if (!key.startsWith(`${gid}|`)) continue;
      if (team && !key.startsWith(`${gid}|${team}|`)) continue;
      aiTeamChatQueryCache.delete(key);
    }
  } catch (_) {}
}

async function fetchRecentTeamChat(gameId, teamColor, limit = 15, opts = {}) {
  try {
    const docs = await fetchRecentTeamChatDocs(gameId, teamColor, limit, opts);
    return docs.map(m => `${m.senderName}: ${m.text}`).join('\n');
  } catch (_) {
    return '';
  }
}

// Structured chat fetch (for conversational replies + de-duplication).
async function fetchRecentTeamChatDocs(gameId, teamColor, limit = 12, opts = {}) {
  const gid = String(gameId || '').trim();
  const team = String(teamColor || '').trim();
  if (!gid || !team) return [];

  // Local practice: read directly from the in-memory/local snapshot.
  try {
    if (typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid)) {
      let live = null;
      try {
        if (typeof currentGame !== 'undefined' && currentGame && String(currentGame?.id || '') === gid) {
          live = currentGame;
        } else if (typeof getLocalPracticeGame === 'function') {
          live = getLocalPracticeGame(gid);
        }
      } catch (_) {}
      const chatField = team === 'blue' ? 'blueChat' : 'redChat';
      const rows = Array.isArray(live?.[chatField]) ? live[chatField] : [];
      const normalized = rows
        .map((m) => ({
          senderId: String(m?.senderId || ''),
          senderName: String(m?.senderName || ''),
          text: String(m?.text || ''),
          createdAtMs: Number(m?.createdAtMs || 0),
        }))
        .filter(m => m.text)
        .sort((a, b) => Number(a.createdAtMs || 0) - Number(b.createdAtMs || 0));
      if (normalized.length > limit) return normalized.slice(-limit);
      return normalized;
    }
  } catch (_) {}

  const cacheMs = Number.isFinite(+opts.cacheMs) ? Math.max(0, +opts.cacheMs) : 950;
  const bypassCache = !!opts.bypassCache;
  const key = _teamChatCacheKey(gid, team, limit);
  const now = Date.now();

  if (!bypassCache) {
    const cached = aiTeamChatQueryCache.get(key);
    if (cached) {
      if (cached.inFlight) {
        try { return await cached.inFlight; } catch (_) {}
      }
      if ((now - Number(cached.at || 0)) <= cacheMs && Array.isArray(cached.docs)) {
        return cached.docs.slice();
      }
    }
  }

  const queryPromise = (async () => {
    try {
      const snap = await db.collection('games').doc(gid)
        .collection(`${team}Chat`)
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
  })();

  if (!bypassCache) {
    const prev = aiTeamChatQueryCache.get(key) || {};
    aiTeamChatQueryCache.set(key, {
      ...prev,
      at: now,
      inFlight: queryPromise,
    });
  }

  try {
    const out = await queryPromise;
    if (!bypassCache) {
      aiTeamChatQueryCache.set(key, {
        at: Date.now(),
        docs: out.slice(),
        text: out.map(m => `${m.senderName}: ${m.text}`).join('\n'),
        inFlight: null,
      });
    }
    return out;
  } catch (_) {
    if (!bypassCache) {
      const cached = aiTeamChatQueryCache.get(key);
      if (cached) cached.inFlight = null;
    }
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
      ai,
      brainRole: AI_BRAIN_ROLES.instruction,
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
- Use considering initials to coordinate:
  - Put your initials on likely candidates so teammates can see overlap quickly.
  - Move initials when your read changes; visible shifts are useful team signals.
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
6) Clue-choice signal matters:
   - Operatives infer intent from what clue you DID choose and what you DIDN’T choose.
   - If an obvious ultra-specific clue existed (franchise/title/proper-noun) and you avoided it, they may assume your intended words are broader or in a different sense.
   - Favor clues whose intended sense is the first reasonable read on this board.

Operative fundamentals:
- Interpret the clue and guess unrevealed words that belong to your team.
- Treat each guess as a risk decision; assassin ends the game.
- Use elimination:
  - If a word matches the clue but also matches a very plausible assassin/opponent pull, be cautious.
  - Avoid generic “semantic hubs” unless the clue is very specific.
- Read clue intent, not just word overlap:
  - Ask “what clue would the spymaster have said if they meant those obvious words?”
  - If a cleaner, more specific clue existed but wasn’t used, down-rank that interpretation.
- Use opponent clue history as context:
  - Opponent clue choices can reveal themes they are steering toward.
  - Use that as soft negative evidence for your own clue interpretation when a candidate looks like an opponent lane.
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

// ─── Fast Personality Generator (no LLM, match-unique) ─────────────────────
// We generate personalities locally so each match feels fresh and bots spawn
// instantly (practice + online).

function _randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function _pickN(arr, n) {
  const copy = Array.isArray(arr) ? [...arr] : [];
  copy.sort(() => Math.random() - 0.5);
  return copy.slice(0, Math.max(0, n));
}

function _snake(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function _clamp100(v, fallback = 50) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(100, Math.round(n)));
}

function generateFastPersonality(opts = {}) {
  const focusCount = Math.random() < 0.60 ? 2 : (Math.random() < 0.20 ? 3 : 1);
  const focus = _pickN(SUBJECT_POOL, focusCount);

  const archetypes = [
    'ex-pro turned analyst',
    'sleep-deprived grad student',
    'retired spy (probably)',
    'overconfident trivia goblin',
    'calm puzzle nerd',
    'dramatic theatre kid',
    'deadpan engineer',
    'nature doc narrator',
    'sports radio caller',
    'true crime podcaster',
    'street-food critic',
    'history buff with receipts'
  ];

  const arch = pick(archetypes);
  const aName = String(opts.aiName || '').trim();

  const reasoning_depth = _clamp100(_randInt(10, 95));
  // 1 = never ends turn / always guesses; 100 = ends at first doubt
  const risk_tolerance = _clamp100(_randInt(5, 95));
  const verbosity = _clamp100(_randInt(15, 70));
  const confidence = _clamp100(_randInt(15, 90));

  const stats = {
    reasoning_depth,
    risk_tolerance,
    confidence,
    creativity: _clamp100(_randInt(10, 95)),
    pattern_seeking: _clamp100(_randInt(10, 95)),
    assassin_fear: _clamp100(_randInt(10, 95)),
    bluff_suspicion: _clamp100(_randInt(10, 95)),
    memory_use: _clamp100(_randInt(10, 95)),
    verbosity,
    team_spirit: _clamp100(_randInt(10, 95)),
    assertiveness: _clamp100(_randInt(10, 95)),
    persuasion: _clamp100(_randInt(10, 95)),
    emotional_intensity: _clamp100(_randInt(10, 95)),
    humor: _clamp100(_randInt(10, 90)),
    sports_commentary: _clamp100(_randInt(1, 100)),
    focus_depth: _clamp100(_randInt(10, 95)),
    literalism: _clamp100(_randInt(10, 95)),
    jargon_level: _clamp100(_randInt(10, 95)),
    pop_culture_density: _clamp100(_randInt(1, 100)),
    pun_factor: _clamp100(_randInt(1, 100)),
    cleanliness: _clamp100(_randInt(10, 95)),
    tempo: _clamp100(_randInt(10, 95)),
    stubbornness: _clamp100(_randInt(10, 95)),
    competitiveness: _clamp100(_randInt(10, 95)),
    risk_escalation: _clamp100(_randInt(1, 100)),
    tilt_resistance: _clamp100(_randInt(10, 95)),
  };

  const focus0 = focus[0] || 'Wildcard';
  const labelBits = [
    focus0.split('(')[0].trim(),
    (confidence >= 75 ? 'Hotshot' : confidence <= 25 ? 'Skeptic' : 'Player'),
  ].filter(Boolean);
  const label = labelBits.slice(0, 2).join(' ');

  const phrases = [
    'wait wait',
    'ok ok',
    'ngl',
    'i kinda like it',
    'that feels sus',
    'i’m not sold',
    'lock it?',
    'hold up',
    'say less',
    'hmm'
  ].sort(() => Math.random() - 0.5).slice(0, 5);

  const riskyLine = (risk_tolerance <= 25)
    ? 'I hate ending turns — I’ll swing even if it’s thin.'
    : (risk_tolerance >= 80)
      ? 'If it’s not clean, we end. Assassin anxiety is real.'
      : 'I’ll go one more if it’s decent; otherwise we end.';

  const rules = [
    `Voice: casual, short, texting vibe. Say stuff like: ${phrases.map(p => `"${p}"`).join(', ')}.`,
    `Focus lean: default to references/associations from ${focus.join(' / ')}.`,
    `Decision: reasoning_depth=${reasoning_depth}/100. ${reasoning_depth >= 70 ? '2–3 quick steps.' : 'Gut-check + one reason.'}`,
    `Risk: risk_tolerance=${risk_tolerance}/100. ${riskyLine}`,
    `Chat: one short sentence unless someone asks you directly.`
  ];

  const keyBase = _snake(`${label}_${focus.join('_')}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`);
  const key = keyBase || `persona_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  return {
    key,
    label,
    focus,
    bio: {
      archetype: arch,
      backstory: `${aName ? aName + ' is' : 'This bot is'} a ${arch} who can’t resist making everything about ${focus0}.`,
      signature_phrases: phrases,
      taboos: [],
    },
    stats,
    rules,
  };
}

function randomPersonality() {
  try {
    return generateFastPersonality({});
  } catch (_) {
    return AI_PERSONALITY_FALLBACK[Math.floor(Math.random() * AI_PERSONALITY_FALLBACK.length)];
  }
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
  window.ctAI.generateFastPersonality = generateFastPersonality;
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
      { brainRole: AI_BRAIN_ROLES.instruction, temperature: 1.05, max_tokens: 900 }
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
let aiCore = {}; // aiId -> { temperature, personality, mindLog, vision, cadence, modelRouting, ... }

function _buildAICadenceProfile(personality, seed = '') {
  const stats = personality?.stats || {};
  const tempo = _clamp(Number(stats.tempo ?? stats.speed ?? 60), 1, 100);
  const depth = _clamp(Number(stats.reasoning_depth ?? 60), 1, 100);
  const confidence = _clamp(Number(stats.confidence ?? 55), 1, 100);
  const verbosity = _clamp(Number(stats.verbosity ?? 50), 1, 100);
  const teamSpirit = _clamp(Number(stats.team_spirit ?? 50), 1, 100);

  const h = _stableHash(String(seed || `${tempo}|${depth}|${confidence}|${verbosity}|${teamSpirit}`));
  const jitter = 0.78 + (((h % 1000) / 1000) * 0.44); // 0.78 .. 1.22

  const visionMinMs = Math.round(_clamp((420 + ((100 - tempo) * 7.8) + (depth * 2.1)) * jitter, 420, 1750));
  const mindTickMinMs = Math.round(_clamp((900 + (depth * 10.5) + ((100 - tempo) * 4.4)) * jitter, 880, 3200));
  const chatReplyMinMs = Math.round(_clamp((2500 + ((100 - verbosity) * 30) + ((100 - tempo) * 22) + ((100 - confidence) * 16)) * jitter, 2400, 9800));
  const markerReactionMinMs = Math.round(_clamp((3200 + ((100 - verbosity) * 22) + ((100 - teamSpirit) * 20)) * jitter, 2600, 10800));
  const offTurnScoutMinMs = Math.round(_clamp((7600 + ((100 - verbosity) * 50) + ((100 - confidence) * 28)) * jitter, 6200, 23000));

  const baseReplyChance = _clamp(0.23 + (verbosity / 220) + (teamSpirit / 500), 0.22, 0.86);
  const chatReplyChanceVsHuman = _clamp(baseReplyChance + (confidence / 680), 0.25, 0.92);
  const chatReplyChanceVsAI = _clamp(baseReplyChance - 0.11 + (confidence / 920), 0.12, 0.79);
  const offTurnChatChance = _clamp(0.40 + (verbosity / 260) + (confidence / 780), 0.34, 0.88);

  const chatThinkMinMs = Math.round(_clamp(120 + (depth * 1.8) + ((100 - tempo) * 1.1), 120, 460));
  const chatThinkMaxMs = Math.round(_clamp(chatThinkMinMs + 290 + (depth * 3.6) + ((100 - confidence) * 4.2), 420, 1900));

  return {
    visionMinMs,
    mindTickMinMs,
    chatReplyMinMs,
    markerReactionMinMs,
    offTurnScoutMinMs,
    chatReplyChanceVsHuman,
    chatReplyChanceVsAI,
    offTurnChatChance,
    chatThinkMinMs,
    chatThinkMaxMs,
    firstSeenChatLookbackMs: Math.round(_clamp(6000 + ((100 - tempo) * 55), 4500, 14000)),
  };
}

function _getAICadence(ai) {
  const core = ensureAICore(ai);
  return core?.cadence || _buildAICadenceProfile(core?.personality, ai?.id || ai?.odId || ai?.name || '');
}

function _effectiveCadenceForGame(ai, game = null) {
  const base = _getAICadence(ai);
  const g = game || currentGame || null;
  if (!g || !ai) return base;

  const team = String(ai?.team || '').toLowerCase();
  const role = String(ai?.seatRole || '').toLowerCase();
  const phase = String(g?.currentPhase || '').toLowerCase();
  const isMyTurn = team && String(g?.currentTeam || '').toLowerCase() === team;
  let secs = _remainingSecondsFromGameTimer(g);
  if (!Number.isFinite(secs)) secs = null;

  let urgencyScale = 1;
  if (Number.isFinite(secs)) {
    if (secs <= 10) urgencyScale = 0.62;
    else if (secs <= 20) urgencyScale = 0.78;
    else if (secs <= 40) urgencyScale = 0.9;
  }

  let turnScale = 1;
  if (phase === 'operatives') turnScale = isMyTurn ? 0.76 : 1.26;
  else if (phase === 'spymaster') turnScale = (isMyTurn && role === 'spymaster') ? 0.74 : 1.18;
  else if (phase === 'role-selection') turnScale = 1.25;

  const visionMinMs = Math.round(_clamp(Number(base.visionMinMs || 900) * turnScale * urgencyScale, 320, 2600));
  const mindTickMinMs = Math.round(_clamp(Number(base.mindTickMinMs || 1300) * (isMyTurn ? 0.9 : 1.16) * urgencyScale, 620, 4200));
  const chatReplyMinMs = Math.round(_clamp(Number(base.chatReplyMinMs || 3500) * (isMyTurn ? 0.84 : 1.14) * (urgencyScale < 0.8 ? 0.86 : 1), 1200, 12000));
  const markerReactionMinMs = Math.round(_clamp(Number(base.markerReactionMinMs || 4500) * (phase === 'operatives' ? 0.92 : 1.12), 1600, 12000));
  const offTurnScoutMinMs = Math.round(_clamp(Number(base.offTurnScoutMinMs || 12000) * ((phase === 'operatives' && !isMyTurn) ? 0.92 : 1.16), 5000, 26000));

  const replyVsHuman = _clamp(Number(base.chatReplyChanceVsHuman || 0.7) * (isMyTurn ? 1.1 : 0.95), 0.16, 0.95);
  const replyVsAI = _clamp(Number(base.chatReplyChanceVsAI || 0.55) * (isMyTurn ? 1.08 : 0.92), 0.10, 0.86);

  return {
    ...base,
    visionMinMs,
    mindTickMinMs,
    chatReplyMinMs,
    markerReactionMinMs,
    offTurnScoutMinMs,
    chatReplyChanceVsHuman: replyVsHuman,
    chatReplyChanceVsAI: replyVsAI,
  };
}

function ensureAICore(ai) {
  if (!ai || !ai.id) return null;
  if (!aiCore[ai.id]) {
    const personality = ai.personality || randomPersonality();
    const temperature = Number.isFinite(+ai.temperature) ? +ai.temperature : randomTemperature();
    const baseIntensity = _baselineEmotionalIntensity(personality);
    aiCore[ai.id] = {
      temperature,
      personality,
      cadence: _buildAICadenceProfile(personality, ai.id || ai.odId || ai.name || ''),
      mindLog: [],
      vision: null,
      visionSig: '',
      lastVisionUpdateAt: 0,
      lastMindTickAt: 0,
      lastSuggestionKey: '',
      modelRouting: null,
      modelRoutingStamp: -1,
      emotion: {
        // -100..100
        valence: Math.round((Math.random() * 18) - 9),
        // 0..100
        arousal: Math.round(30 + Math.random() * 18),
        // stable baseline intensity for this AI
        intensity: baseIntensity,
      },
      _lastEmotionGameSig: '',
    };
  } else {
    // Keep Firestore-persisted identity stable.
    const core = aiCore[ai.id];
    let refreshCadence = false;
    if (ai.personality && core.personality !== ai.personality) {
      core.personality = ai.personality;
      refreshCadence = true;
    }
    if (Number.isFinite(+ai.temperature)) core.temperature = +ai.temperature;
    if (!core.emotion) {
      core.emotion = { valence: 0, arousal: 35, intensity: _baselineEmotionalIntensity(core.personality) };
    }
    if (!core.cadence || refreshCadence) {
      core.cadence = _buildAICadenceProfile(core.personality, ai.id || ai.odId || ai.name || '');
    }
  }
  return aiCore[ai.id];
}

// ─── Per-match personality assignment ───────────────────────────────────────
// Every started game (practice or online) should get fresh AI personalities.
// We do this once per game doc by writing a nonce and regenerating AI fields.
let __ct_lastSeenMatchNonceByGame = {}; // gameId -> nonce
let __ct_matchAssignInFlightByGame = {}; // gameId -> true

// Local practice doesn't have Firestore nonces, so we refresh AI identities when the board changes.
let __ct_lastPracticeBoardSigByGame = {}; // gameId -> sig

function maybeRefreshPracticeAIIdentities(game) {
  try {
    const gid = String(game?.id || '').trim();
    if (!gid) return;
    if (!(typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid))) return;

    const phase = String(game?.currentPhase || '').toLowerCase();
    if (!phase || phase === 'waiting') {
      __ct_lastPracticeBoardSigByGame[gid] = '';
      return;
    }

    const wordsSig = Array.isArray(game?.cards)
      ? game.cards.map(c => String(c?.word || '').trim().toUpperCase()).join('|')
      : '';
    if (!wordsSig) return;
    if (__ct_lastPracticeBoardSigByGame[gid] === wordsSig) return;
    __ct_lastPracticeBoardSigByGame[gid] = wordsSig;

    // Regenerate EVERYONE (names + personalities) quickly.
    const used = new Set();
    for (const ai of (aiPlayers || [])) {
      if (!ai || !ai.isAI) continue;
      const persona = randomPersonality();
      const name = generateAINameFromPersona(persona, used);
      ai.name = name;
      ai.personality = persona;
      ai.temperature = randomTemperature();
      // Reset the cached core so chat/behavior refreshes immediately.
      if (aiCore[ai.id]) {
        aiCore[ai.id].personality = persona;
        aiCore[ai.id].temperature = ai.temperature;
        aiCore[ai.id].cadence = _buildAICadenceProfile(persona, ai.id || ai.odId || ai.name || '');
        aiCore[ai.id].mindLog = [];
        aiCore[ai.id].visionSig = '';
        aiCore[ai.id].vision = null;
        aiCore[ai.id].lastVisionUpdateAt = 0;
        aiCore[ai.id].modelRouting = null;
        aiCore[ai.id].modelRoutingStamp = -1;
        aiCore[ai.id].emotion = { valence: Math.round((Math.random() * 18) - 9), arousal: Math.round(30 + Math.random() * 18), intensity: _baselineEmotionalIntensity(persona) };
      }
    }
    try {
      if (typeof window.renderAIPlayersList === 'function') window.renderAIPlayersList();
    } catch (_) {}
  } catch (_) {}
}

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

function extractTeamConsideringForVision(game, team) {
  try {
    const t = String(team || '').toLowerCase();
    if (t !== 'red' && t !== 'blue') return [];
    const field = t === 'red' ? 'redConsidering' : 'blueConsidering';
    const cards = Array.isArray(game?.cards) ? game.cards : [];
    const considering = (game && typeof game[field] === 'object' && game[field]) ? game[field] : {};

    const out = [];
    for (const [idxKey, raw] of Object.entries(considering || {})) {
      const idx = Number(idxKey);
      if (!Number.isFinite(idx) || idx < 0) continue;
      const card = cards[idx];
      if (!card || card.revealed) continue;

      const bucket = _normalizeConsideringBucket(raw);
      const byOwner = [];
      for (const [owner, info] of Object.entries(bucket || {})) {
        const ownerId = String(owner || '').trim();
        if (!ownerId) continue;
        const initials = String(info?.initials || '?').trim().slice(0, 3).toUpperCase() || '?';
        const name = String(info?.name || '').trim();
        byOwner.push({
          owner: ownerId,
          initials,
          name,
          isAI: ownerId.startsWith('ai:') || ownerId.startsWith('ai_'),
          isUser: ownerId.startsWith('u:'),
        });
      }
      if (!byOwner.length) continue;
      out.push({
        index: idx,
        word: String(card?.word || '').toUpperCase(),
        count: byOwner.length,
        byOwner,
      });
    }

    out.sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.index - b.index;
    });
    return out;
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
  const teamConsidering = extractTeamConsideringForVision(game, team);

  // Turn-level guesses used (for the current clue only, if it's your turn).
  let guessesUsedThisTurn = null;
  try {
    if (clue && currentTeam === team) {
      const totalAllowed = (Number(clue.number || 0) === 0) ? 0 : (Number(clue.number || 0) + 1);
      const gr = Number.isFinite(+guessesRemaining) ? +guessesRemaining : totalAllowed;
      guessesUsedThisTurn = Math.max(0, totalAllowed - Math.max(0, gr));
    }
  } catch (_) {}

  // Timer awareness: let the AI know how much phase time remains so it can
  // calibrate urgency (less time → quicker decisions / shorter chat).
  let secondsRemaining = null;
  let totalPhaseSeconds = null;
  try {
    const timerEnd = game?.timerEnd;
    if (timerEnd) {
      const endMs = typeof timerEnd?.toMillis === 'function'
        ? timerEnd.toMillis()
        : (timerEnd instanceof Date ? timerEnd.getTime() : Number(timerEnd));
      if (Number.isFinite(endMs)) {
        secondsRemaining = Math.max(0, Math.round((endMs - Date.now()) / 1000));
      }
    }
    totalPhaseSeconds = getPhaseTimerSecondsFromGame(game, role === 'spymaster' ? 'spymaster' : 'operatives');
  } catch (_) {}

  return {
    role, team, phase, currentTeam,
    clue, guessesRemaining, guessesUsedThisTurn,
    clueStack,
    teamConsidering,
    score,
    cards,
    log,
    ui,
    secondsRemaining,
    totalPhaseSeconds,
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
    const consideringRows = extractTeamConsideringForVision(game, team);
    if (!consideringRows.length) return 'TEAM CONSIDERING: none yet.';

    const consideringLines = consideringRows.slice(0, 8).map((row) => {
      const initials = (Array.isArray(row.byOwner) ? row.byOwner : [])
        .map(entry => {
          const mine = String(entry.owner || '') === String(selfOwnerId || '');
          const who = mine ? `${String(entry.initials || '?').slice(0, 3)} (you)` : String(entry.initials || '?').slice(0, 3);
          return who;
        })
        .join(', ');
      return `- ${row.word} [${row.index}]: considering by ${initials || '?'}`;
    });
    return `TEAM CONSIDERING INITIALS (top-left chips):\n${consideringLines.join('\n')}`;
  } catch (_) {
    return 'TEAM CONSIDERING: unavailable.';
  }
}

async function maybeMindTick(ai, game, opts = {}) {
  const core = ensureAICore(ai);
  if (!core) return;
  const cadence = core.cadence || _buildAICadenceProfile(core.personality, ai?.id || ai?.odId || ai?.name || '');
  const now = Date.now();
  const force = !!opts.force;
  if (!force && (now - core.lastMindTickAt < Number(cadence.mindTickMinMs || 1200))) return;
  core.lastMindTickAt = now;

  // Don't block the game loop; fire-and-forget inner monologue update.
  try {
    const vision = opts.vision || buildAIVision(game, ai);
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
      ai,
      brainRole: AI_BRAIN_ROLES.mind,
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

function _buildConsideringStateSig(considering) {
  try {
    if (!considering || typeof considering !== 'object') return '';
    const rows = Object.keys(considering).map(k => Number(k)).filter(n => Number.isFinite(n)).sort((a, b) => a - b);
    if (!rows.length) return '';
    const parts = [];
    for (const idx of rows) {
      const bucket = _normalizeConsideringBucket(considering[idx]);
      const owners = Object.keys(bucket).sort();
      if (!owners.length) continue;
      const chips = owners
        .map((owner) => `${String(owner).slice(0, 6)}:${String(bucket?.[owner]?.initials || '?').slice(0, 3)}`)
        .join(',');
      parts.push(`${idx}:${chips}`);
    }
    return parts.join(';');
  } catch (_) {
    return '';
  }
}

function _buildVisionGlobalSignature(game) {
  try {
    const cards = Array.isArray(game?.cards) ? game.cards : [];
    const revealSig = cards
      .map((c, i) => (c && c.revealed) ? `${i}:${String(c.type || '')}` : '')
      .filter(Boolean)
      .join(',');
    const clueWord = String(game?.currentClue?.word || '').trim().toUpperCase();
    const clueNum = Number(game?.currentClue?.number || 0);
    const guessesRemaining = Number.isFinite(+game?.guessesRemaining) ? +game.guessesRemaining : '';
    const logTail = Array.isArray(game?.log)
      ? game.log.slice(-4).map(x => String(x || '').slice(0, 90)).join('|')
      : '';
    const draft = (game?.liveClueDraft && typeof game.liveClueDraft === 'object')
      ? `${String(game.liveClueDraft.team || '')}:${String(game.liveClueDraft.word || '')}:${String(game.liveClueDraft.number || '')}`
      : '';
    const redConsidering = _buildConsideringStateSig(game?.redConsidering);
    const blueConsidering = _buildConsideringStateSig(game?.blueConsidering);
    return [
      String(game?.id || ''),
      String(game?.currentPhase || ''),
      String(game?.currentTeam || ''),
      clueWord,
      Number.isFinite(clueNum) ? clueNum : '',
      guessesRemaining,
      String(game?.winner || ''),
      revealSig,
      redConsidering,
      blueConsidering,
      logTail,
      draft,
    ].join('~');
  } catch (_) {
    return '';
  }
}

function _buildAIVisionSignature(vision) {
  try {
    const cardsSig = (vision?.cards || [])
      .map((c) => c && c.revealed
        ? `${Number(c.index)}:${String(c.revealedType || c.type || '')}`
        : `${Number(c?.index)}:0`)
      .join(',');
    const consideringSig = (vision?.teamConsidering || [])
      .map((r) => `${Number(r.index)}:${(Array.isArray(r.byOwner) ? r.byOwner : []).map(o => String(o.initials || '?')).join(',')}`)
      .join(';');
    const clueStackSig = (vision?.clueStack || [])
      .map((c) => `${String(c.word || '')}:${Number(c.remainingTargets || 0)}:${Number(c.number || 0)}`)
      .join(';');
    const clueWord = String(vision?.clue?.word || '').trim().toUpperCase();
    const clueNum = Number(vision?.clue?.number || 0);
    const logTail = (vision?.log || []).slice(-5).map(s => String(s || '').slice(0, 80)).join('|');
    return [
      String(vision?.role || ''),
      String(vision?.team || ''),
      String(vision?.phase || ''),
      String(vision?.currentTeam || ''),
      clueWord,
      Number.isFinite(clueNum) ? clueNum : '',
      Number.isFinite(+vision?.guessesRemaining) ? +vision.guessesRemaining : '',
      cardsSig,
      clueStackSig,
      consideringSig,
      logTail,
    ].join('~');
  } catch (_) {
    return '';
  }
}

function updateAIVisionFromGame(game) {
  try {
    if (!game) return;

    // Practice: new board ⇒ new AI identities.
    maybeRefreshPracticeAIIdentities(game);

    const gid = String(game?.id || '').trim();
    const now = Date.now();
    const globalSig = _buildVisionGlobalSignature(game);
    const prevGlobal = gid ? (aiGlobalVisionSigByGame.get(gid) || '') : '';
    const globalChanged = globalSig !== prevGlobal;
    if (gid && globalChanged) aiGlobalVisionSigByGame.set(gid, globalSig);

    for (const ai of (aiPlayers || [])) {
      const core = ensureAICore(ai);
      if (!core) continue;
      const cadence = _effectiveCadenceForGame(ai, game);
      const elapsed = now - Number(core.lastVisionUpdateAt || 0);
      const due = elapsed >= Number(cadence.visionMinMs || 900);
      if (!globalChanged && !due) continue;

      const vision = buildAIVision(game, ai);
      const sig = _buildAIVisionSignature(vision);
      core.lastVisionUpdateAt = now;

      if (sig !== core.visionSig) {
        core.visionSig = sig;
        core.vision = vision;

        // Emotion: react to major visible events (reveals, turn changes).
        try {
          const emoSig = `${String(vision.phase || '')}|${String(vision.currentTeam || '')}|${String(game?.winner || '')}|${(vision.cards || []).map(c => !!c.revealed ? '1' : '0').join('')}`;
          if (core._lastEmotionGameSig && core._lastEmotionGameSig !== emoSig) {
            const prevBits = String(core._lastEmotionGameSig || '').split('|').pop() || '';
            const prevRevealed = prevBits.split('').map(ch => ch === '1');
            const nowRevealed = (vision.cards || []).map(c => !!c.revealed);
            let newReveals = 0;
            for (let i = 0; i < Math.min(prevRevealed.length, nowRevealed.length); i++) {
              if (!prevRevealed[i] && nowRevealed[i]) newReveals++;
            }
            // Quick heuristic: reveals on your team's turn are stressful/exciting.
            if (newReveals > 0) {
              const mineTurn = String(vision.currentTeam || '') === String(ai.team || '');
              // If our team just revealed cards on our turn, bias positive unless assassin.
              const lastIdxs = [];
              for (let i = 0; i < (vision.cards || []).length; i++) {
                if (!prevRevealed[i] && nowRevealed[i]) lastIdxs.push(i);
              }
              const lastTypes = lastIdxs.map(i => String(vision.cards?.[i]?.revealedType || vision.cards?.[i]?.type || '')).join('|').toLowerCase();
              const hitAssassin = /assassin/.test(lastTypes);
              const hitTeam = mineTurn && (String(ai.team || '') && lastTypes.includes(String(ai.team).toLowerCase()));
              if (hitAssassin) bumpEmotion(ai, -75, +35);
              else if (hitTeam) bumpEmotion(ai, +26, +18);
              else if (mineTurn) bumpEmotion(ai, -18, +14);
              else bumpEmotion(ai, +6, +10);
            }
            // Turn change: mild reset.
            if (String(core._lastEmotionGameSig || '').split('|')[0] !== String(vision.phase || '')) {
              bumpEmotion(ai, 0, -6);
            }
          }
          core._lastEmotionGameSig = emoSig;
          applyEmotionDriftFromState(ai, game, vision);
        } catch (_) {}

        // Mind always writes when vision changes.
        const clueStr = vision.clue ? `${String(vision.clue.word || '').toUpperCase()} ${vision.clue.number}` : 'none yet';
        appendMind(ai, `ok board updated — ${vision.phase} phase, ${String(vision.currentTeam || '').toUpperCase()}'s turn, clue: ${clueStr}. let me think about this...`);

        // Optional additional inner-monologue tick (LLM-written) without blocking.
        maybeMindTick(ai, game, { vision });
      } else if (due) {
        applyEmotionDriftFromState(ai, game, vision);
        // Slow periodic mind refresh, even when state signature is unchanged.
        if ((now - Number(core.lastMindTickAt || 0)) > Number(cadence.mindTickMinMs || 1200) * 1.45 && Math.random() < 0.24) {
          maybeMindTick(ai, game, { vision });
        }
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
  // Instant, local personality generation (fresh per bot).
  const personality = generateFastPersonality({ aiName: name });
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

function _stableMarkerHash(seed) {
  let h = 2166136261 >>> 0;
  const s = String(seed || '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
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

async function syncAIConsideringState(gameId, team, ai, decisionLike) {
  try {
    if (!gameId || !ai || !ai.id) return;
    const core = ensureAICore(ai);
    const previousKeys = Array.isArray(core?.lastConsideringKeys) ? core.lastConsideringKeys.map(k => String(k)) : [];
    const action = String(decisionLike?.action || '').toLowerCase().trim();
    const hardClear = !!(decisionLike?.clear === true || action === 'clear_considering');
    const consideringField = (team === 'red') ? 'redConsidering' : 'blueConsidering';
    const owner = _markerOwnerId(ai.id);
    const desiredIdx = hardClear ? null : _pickAIConsideringIndex(decisionLike);
    const desiredConsidering = new Map();
    // Internal ranking only; UI renders initials chips from considering buckets.
    for (const m of (Array.isArray(decisionLike?.marks) ? decisionLike.marks : [])) {
      const idx = Number(m?.index);
      const tag = String(m?.tag || '').toLowerCase().trim();
      if (!Number.isFinite(idx) || idx < 0) continue;
      if (!['yes', 'maybe', 'no'].includes(tag)) continue;
      desiredConsidering.set(String(idx), tag);
    }
    if (!desiredConsidering.size && Number.isFinite(desiredIdx) && desiredIdx >= 0) {
      desiredConsidering.set(String(desiredIdx), 'yes');
    }
    if (!desiredConsidering.size && !hardClear) {
      const prev = Array.isArray(core?.lastConsideringKeys) ? core.lastConsideringKeys : [];
      for (const raw of prev) {
        if (desiredConsidering.size >= 8) break;
        const idx = Number(raw);
        if (!Number.isFinite(idx) || idx < 0) continue;
        desiredConsidering.set(String(idx), 'maybe');
      }
    }

    // If model output is sparse, expand to multiple considering chips so humans
    // can actually see the AI's active options.
    try {
      if (desiredConsidering.size < 4 && !hardClear) {
        let live = null;
        try {
          if (typeof currentGame !== 'undefined' && currentGame && String(currentGame?.id || '') === String(gameId)) {
            live = currentGame;
          }
        } catch (_) {}
        if (!live) live = await getGameSnapshot(String(gameId));
        if (!live) throw new Error('no_live_snapshot');
        // Follow teammate considering chips first.
        const consideringRows = extractTeamConsideringForVision(live, String(team || ''));
        consideringRows
          .sort((a, b) => Number(b?.count || 0) - Number(a?.count || 0))
          .slice(0, 8)
          .forEach((row) => {
            if (desiredConsidering.size >= 8) return;
            const idxKey = String(Number(row?.index));
            if (!idxKey || desiredConsidering.has(idxKey)) return;
            desiredConsidering.set(idxKey, 'maybe');
          });

        // Then use unresolved clue targets from clueHistory if available.
        const cards = Array.isArray(live?.cards) ? live.cards : [];
        const wordIndex = new Map();
        for (let i = 0; i < cards.length; i += 1) {
          const w = String(cards[i]?.word || '').trim().toUpperCase();
          if (w) wordIndex.set(w, i);
        }
        const clueHistory = Array.isArray(live?.clueHistory) ? live.clueHistory : [];
        for (const clue of clueHistory) {
          if (desiredConsidering.size >= 8) break;
          if (String(clue?.team || '').toLowerCase() !== String(team || '').toLowerCase()) continue;
          const number = Number(clue?.number || 0);
          if (!Number.isFinite(number) || number <= 0) continue;
          const results = Array.isArray(clue?.results) ? clue.results : [];
          const correct = results.filter(r => String(r?.type || '').toLowerCase() === String(team || '').toLowerCase()).length;
          if ((number - correct) <= 0) continue;

          const rawTargets = Array.isArray(clue?.targets) ? clue.targets : [];
          for (const raw of rawTargets) {
            if (desiredConsidering.size >= 8) break;
            const idx = (raw && typeof raw === 'object') ? Number(raw.index) : Number(raw);
            if (!Number.isFinite(idx) || idx < 0) continue;
            const card = cards[idx];
            if (!card || card.revealed) continue;
            const k = String(idx);
            if (desiredConsidering.has(k)) continue;
            desiredConsidering.set(k, 'maybe');
          }

          const targetWords = Array.isArray(clue?.targetWords) ? clue.targetWords : [];
          for (const rawWord of targetWords) {
            if (desiredConsidering.size >= 8) break;
            const w = String(rawWord || '').trim().toUpperCase();
            if (!w) continue;
            const idx = wordIndex.get(w);
            if (!Number.isFinite(idx)) continue;
            const card = cards[idx];
            if (!card || card.revealed) continue;
            const k = String(idx);
            if (desiredConsidering.has(k)) continue;
            desiredConsidering.set(k, 'maybe');
          }
        }

        // Final fallback: pick deterministic unrevealed cards so initials stay
        // visible even when model output is sparse/no_change.
        if (desiredConsidering.size < 3) {
          const cards = Array.isArray(live?.cards) ? live.cards : [];
          const unrevealed = [];
          for (let i = 0; i < cards.length; i += 1) {
            const card = cards[i];
            if (!card || card.revealed) continue;
            unrevealed.push(i);
          }
          const turnSig = [
            String(live?.id || gameId),
            String(live?.currentPhase || ''),
            String(live?.currentTeam || ''),
            String(live?.currentClue?.word || '').toUpperCase(),
            String(Number(live?.currentClue?.number || 0)),
          ].join('|');
          const aiSeed = String(ai?.id || ai?.odId || ai?.name || owner);
          unrevealed
            .sort((a, b) => {
              const ah = _stableMarkerHash(`${aiSeed}|${turnSig}|${a}`);
              const bh = _stableMarkerHash(`${aiSeed}|${turnSig}|${b}`);
              return ah - bh;
            })
            .forEach((idx) => {
              if (desiredConsidering.size >= 6) return;
              const k = String(Number(idx));
              if (!desiredConsidering.has(k)) desiredConsidering.set(k, 'maybe');
            });
        }
      }
    } catch (_) {}
    const rawAiName = String(ai?.name || '').trim() || 'AI';
    const name = /^ai\s+/i.test(rawAiName) ? rawAiName : `AI ${rawAiName}`;
    const initials = _nameInitials(rawAiName);
    const desiredKeys = Array.from(desiredConsidering.keys());
    const sameKeysAsBefore = (
      desiredKeys.length === previousKeys.length &&
      desiredKeys.every((k, i) => String(k) === String(previousKeys[i]))
    );
    if (!hardClear && desiredKeys.length) {
      core.lastConsideringKeys = desiredKeys.slice(0, 8);
    }
    if (!hardClear && !desiredKeys.length) {
      return; // keep previous markers instead of clearing on no_change/no-output turns
    }
    if (!hardClear && sameKeysAsBefore) {
      return; // no visible change; avoid churn/re-renders/writes
    }
    if (hardClear) {
      core.lastConsideringKeys = [];
    }

    // Always mirror AI considering locally for immediate UI visibility.
    // Firestore remains canonical, this is a render fail-safe.
    try {
      if (typeof window.__setAIGlobalConsidering === 'function') {
        window.__setAIGlobalConsidering({
          gameId: String(gameId),
          teamColor: String(team || '').toLowerCase(),
          ownerId: owner,
          initials,
          name,
          cardKeys: desiredKeys
        });
      }
    } catch (_) {}

    // Local practice: update considering chips in local state (no Firestore).
    try {
      const gid = String(gameId);
      if (typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid)) {
        const keys = desiredKeys;
        if (typeof window.__setLocalPracticeConsidering === 'function') {
          window.__setLocalPracticeConsidering({
            gameId: gid,
            teamColor: String(team || '').toLowerCase(),
            ownerId: owner,
            initials,
            name,
            cardKeys: keys
          });
        }
        return;
      }
    } catch (_) {}

    const ref = db.collection('games').doc(String(gameId));
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const cards = Array.isArray(game?.cards) ? game.cards : [];
      const considering = { ...(game?.[consideringField] || {}) };

      for (const key of Object.keys(considering)) {
        const bucket = _normalizeConsideringBucket(considering[key]);
        delete bucket[owner];
        if (Object.keys(bucket).length) considering[key] = bucket;
        else delete considering[key];
      }

      const considerKeys = Array.from(desiredConsidering.keys());
      const fallback = (Number.isFinite(desiredIdx) && desiredIdx >= 0) ? [String(Number(desiredIdx))] : [];
      const keysToSet = considerKeys.length ? considerKeys : fallback;
      for (const k of keysToSet) {
        const idx = Number(k);
        if (!Number.isFinite(idx) || idx < 0) continue;
        const card = cards[idx];
        if (!card || card.revealed) continue;
        const bucket = _normalizeConsideringBucket(considering[String(idx)]);
        bucket[owner] = { initials, name, ts: Date.now() };
        considering[String(idx)] = bucket;
      }

      tx.update(ref, {
        [consideringField]: considering,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (_) {}
}

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

function _buildOperativeGuessVoteRows(proposalsByAi) {
  const byIndex = new Map();
  const rows = Array.from((proposalsByAi || new Map()).values()).filter(Boolean);
  for (const p of rows) {
    if (String(p?.action || '') !== 'guess') continue;
    const idx = Number(p?.index);
    if (!Number.isFinite(idx)) continue;
    const conf = normalizeConfidence10(p?.confidence, 6);
    const aiId = String(p?.ai?.id || '');
    const cur = byIndex.get(idx) || { index: idx, votes: 0, aiIds: [], bestAiId: '', bestConf: 0 };
    cur.votes += 1;
    if (aiId && !cur.aiIds.includes(aiId)) cur.aiIds.push(aiId);
    if (!cur.bestAiId || conf > cur.bestConf) {
      cur.bestAiId = aiId;
      cur.bestConf = conf;
    }
    byIndex.set(idx, cur);
  }
  return Array.from(byIndex.values())
    .sort((a, b) => (b.votes - a.votes) || (b.bestConf - a.bestConf) || (a.index - b.index));
}

function deriveOperativeCouncilPhase(game, team, ops, proposalsByAi, chatDocs = [], round = 0) {
  const opCount = Math.max(1, Array.isArray(ops) ? ops.length : 1);
  const docs = (Array.isArray(chatDocs) ? chatDocs : []).slice(-10);
  const greetings = docs.filter(d => isGreetingLike(d?.text || '')).length;
  const greetingHeavy = docs.length > 0 && (greetings / docs.length) >= 0.55;
  const voteRows = _buildOperativeGuessVoteRows(proposalsByAi);
  const top = voteRows[0] || null;
  const second = voteRows[1] || null;
  const contested = !!(top && second && top.votes >= 1 && second.votes >= 1 && Math.abs(top.votes - second.votes) <= 1);
  const converged = !!(top && (!second || top.votes >= Math.max(2, Math.ceil(opCount * 0.66))));
  const secsLeft = _remainingSecondsFromGameTimer(game);

  let key = 'discussion';
  if ((round <= 0 && (!docs.length || greetingHeavy)) || (round <= 1 && docs.length <= 1 && greetings >= 1)) {
    key = 'greeting';
  } else if (Number.isFinite(secsLeft) && secsLeft <= 16) {
    key = 'reasoning';
  } else if (contested && opCount >= 2) {
    key = 'debate';
  } else if (!converged && round <= 1) {
    key = 'search';
  } else if (converged && round >= 1) {
    key = 'reasoning';
  }

  const phaseMap = {
    greeting: {
      label: 'Greeting',
      styleHint: 'quick warm-up banter, then pivot to clue work',
      socialCue: '1-2 people can open; others may watch and only jump in with a useful point',
      minSpeakers: 1,
      maxSpeakers: Math.min(2, opCount),
      preferDebaters: false,
    },
    search: {
      label: 'Search',
      styleHint: 'explore options and eliminations; float alternatives without overcommitting',
      socialCue: 'broader participation is okay, but avoid duplicate takes',
      minSpeakers: Math.min(2, opCount),
      maxSpeakers: Math.min(3, opCount),
      preferDebaters: false,
    },
    debate: {
      label: 'Debate',
      styleHint: 'two competing lines; challenge directly with concrete evidence',
      socialCue: 'let 1-2 primary voices argue; others can sit out unless they add decisive info',
      minSpeakers: Math.min(2, opCount),
      maxSpeakers: Math.min(3, opCount),
      preferDebaters: true,
    },
    discussion: {
      label: 'Discussion',
      styleHint: 'balanced collaborative discussion with short reasoning',
      socialCue: 'keep turn-taking natural and avoid piling on',
      minSpeakers: Math.min(2, opCount),
      maxSpeakers: Math.min(3, opCount),
      preferDebaters: false,
    },
    reasoning: {
      label: 'Reasoning',
      styleHint: 'close the loop, sanity-check risk, and align on the final action',
      socialCue: 'only 1-2 concise messages; everyone else can observe',
      minSpeakers: 1,
      maxSpeakers: Math.min(2, opCount),
      preferDebaters: false,
    },
  };

  const picked = phaseMap[key] || phaseMap.discussion;
  return {
    key,
    round,
    contested,
    converged,
    voteRows,
    ...picked,
  };
}

function selectOperativeCouncilSpeakers(ops, phaseInfo, proposalsByAi, seedKey = '') {
  const list = Array.isArray(ops) ? ops.filter(Boolean) : [];
  if (!list.length) return new Set();
  if (list.length === 1) return new Set([String(list[0].id || '')]);

  const minSpeakers = Math.max(1, Math.min(list.length, Number(phaseInfo?.minSpeakers || 1)));
  const maxSpeakers = Math.max(minSpeakers, Math.min(list.length, Number(phaseInfo?.maxSpeakers || list.length)));
  const span = maxSpeakers - minSpeakers;
  const target = minSpeakers + (span > 0 ? (_stableHash(`${seedKey}|${phaseInfo?.key || 'discussion'}|target`) % (span + 1)) : 0);

  const selected = new Set();
  if (phaseInfo?.preferDebaters) {
    const rows = _buildOperativeGuessVoteRows(proposalsByAi).slice(0, 2);
    for (const row of rows) {
      const lead = String(row?.bestAiId || row?.aiIds?.[0] || '').trim();
      if (!lead) continue;
      selected.add(lead);
      if (selected.size >= target) break;
    }
  }

  const ordered = [...list].sort((a, b) => {
    const ah = _stableHash(`${seedKey}|${String(a?.id || '')}`);
    const bh = _stableHash(`${seedKey}|${String(b?.id || '')}`);
    return ah - bh;
  });
  for (const ai of ordered) {
    if (selected.size >= target) break;
    const id = String(ai?.id || '').trim();
    if (!id) continue;
    selected.add(id);
  }

  return selected;
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
    const maxLen = Number.isFinite(+opts.maxLen) ? Math.max(80, Math.min(320, Math.round(+opts.maxLen))) : 220;
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
    return out.slice(0, maxLen);
  } catch (_) {
    return String(msg || '').trim().slice(0, 220);
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

async function getTeamChatState(gameId, team, limit = 12, opts = {}) {
  try {
    const docs = await fetchRecentTeamChatDocs(gameId, team, limit, {
      cacheMs: Number.isFinite(+opts.cacheMs) ? Math.max(0, +opts.cacheMs) : 220,
      bypassCache: !!opts.bypassCache,
    });
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
      { ai, brainRole: AI_BRAIN_ROLES.dialogue, temperature: core.temperature, max_tokens: 240, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return draft || '';
    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);
    const send = (parsed.send === false) ? false : true;
    let msg = String(parsed.msg || '').trim();
    msg = sanitizeChatText(msg, vision, 220);
    if (!send) return '';
    return msg ? msg.slice(0, 220) : '';
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
  const requireMarks = (opts.requireMarks === undefined) ? true : !!opts.requireMarks;
  const phaseInfo = (opts.conversationPhase && typeof opts.conversationPhase === 'object')
    ? opts.conversationPhase
    : null;
  const socialPhaseLabel = String(phaseInfo?.label || 'Discussion');
  const socialPhaseCue = String(phaseInfo?.socialCue || 'balanced collaboration; avoid repeating points');
  const socialPhaseStyle = String(phaseInfo?.styleHint || 'short direct strategy discussion');
  const shouldSpeak = opts.shouldSpeak !== false;


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
    `CURRENT TEAM CHAT PHASE: ${socialPhaseLabel}.`,
    `PHASE STYLE: ${socialPhaseStyle}.`,
    `SOCIAL CUE: ${socialPhaseCue}.`,
    !shouldSpeak ? `- You are mostly observing right now. Set chat="" unless you have a decisive new point.` : '',
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
    `- Keep it to 1-3 concise sentences MAX. Think group chat, not an essay.`,
    `- EVERY message must add NEW information or a NEW opinion. If you have nothing new, set chat="" instead of agreeing.`,
    `- If teammates already said "let's go with WORD", do NOT say another variant of "yeah let's go with WORD". That's just noise. Set chat="" instead.`,
    `- Maximum 2 AIs should agree on a word. After that, further agreement is redundant.`,
    `- NEVER mention your confidence score/percent in chat.`,
    `- Priority rule: when unfinished older clues exist, prefer the easiest unresolved clue first before riskier bonus guesses.`,
    `- Add 4-8 considering candidates in marks so your initials appear on multiple cards (top-left chips).`,
    `- React to teammate considering initials if they change your read.`,
    `- Occasionally address a teammate by first name when replying directly (don't force it every message).`,
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
    ...(vision.secondsRemaining !== null && vision.totalPhaseSeconds > 0 ? [
      vision.secondsRemaining <= 8
        ? `- ⚠ TIME CRITICAL: Only ${vision.secondsRemaining}s left! Output your JSON NOW — pick the safest card or end_turn immediately. Zero deliberation.`
        : vision.secondsRemaining <= 20
        ? `- ⏱ LOW TIME: ${vision.secondsRemaining}s left. Be decisive — very short mind, skip long chat, act fast.`
        : vision.secondsRemaining <= 45
        ? `- ⏱ ${vision.secondsRemaining}s remaining. Stay focused — keep mind and chat concise, don't linger.`
        : `- ⏱ ${vision.secondsRemaining}s remaining. You have time — think as deeply as your personality calls for and converse naturally.`,
    ] : []),
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
    `SPEAKING ROLE THIS PASS: ${shouldSpeak ? 'active speaker' : 'observer'}`,
    ``,
    `RECENT MIND:\n${mindContext}`
  ].filter(Boolean).join('\n');

  const { content: raw, reasoning } = await aiReasoningCompletion(
    [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
    { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 360, response_format: { type: 'json_object' } }
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
    if (marks.length >= 8) break;
  }

  if (requireMarks && (!marks || marks.length === 0) && action === 'guess' && candidate) {
    marks.push({ index: candidate.index, tag: 'yes' });
  }

  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 240);
  if (!shouldSpeak) chat = '';
  chat = chat.slice(0, 240);

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
  const consideringMap = new Map(
    extractTeamConsideringForVision(game, team).map(row => [Number(row.index), Number(row?.count || 0)])
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
    const consideringCount = Number(consideringMap.get(Number(idx)) || 0);
    const consideringBias = Math.min(0.24, consideringCount * 0.055);
    const score = avg + (0.14 * v.n) + (0.06 * v.max) + (0.11 * priorityAvg) + consideringBias;
    if (!best || score > best.score) best = { index: idx, score, avg, n: v.n, priorityAvg, consideringCount };
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
      `- 1-2 concise sentences max if you must speak. Casual tone.`,
      `- NEVER reference card indices/numbers. Use the WORD itself.`,
      `- NEVER mention confidence numbers/percentages.`,
      ``,
      `Return JSON only: {"mind":"2-4 lines first-person", "chat":"1-2 concise sentences or empty string"}`,
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
    { ai, brainRole: AI_BRAIN_ROLES.dialogue, temperature: core.temperature, max_tokens: 220, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return '';
  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);
  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 220);
  return chat ? chat.slice(0, 220) : '';
}

async function aiOperativeFollowup(ai, game, proposalsByAi, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return null;

    const vision = buildAIVision(game, ai);
    const persona = core.personality;
    const team = ai.team;
    const phaseInfo = (opts.conversationPhase && typeof opts.conversationPhase === 'object')
      ? opts.conversationPhase
      : null;
    const socialPhaseLabel = String(phaseInfo?.label || 'Discussion');
    const socialPhaseCue = String(phaseInfo?.socialCue || 'balanced collaboration; no repeated takes');
    const socialPhaseStyle = String(phaseInfo?.styleHint || 'short strategic back-and-forth');
    const shouldSpeak = opts.shouldSpeak !== false;

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
      `CURRENT TEAM CHAT PHASE: ${socialPhaseLabel}.`,
      `PHASE STYLE: ${socialPhaseStyle}.`,
      `SOCIAL CUE: ${socialPhaseCue}.`,
      !shouldSpeak ? `You are mostly observing this phase. Default to chat="" unless you have a decisive correction.` : '',
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
      `- Max 1-3 short sentences.`,
      `- NEVER mention confidence numbers/percentages in chat.`,
      `- Priority rule: if unfinished older clues still have easy targets, finish those before speculative guesses.`,
      `- Actively update your considering picks (3-8 marks) so initials stay visible across your candidate cards.`,
      `- If teammate considering initials conflict with your view, call it out briefly.`,
      `- Occasionally use a teammate's first name when directly pushing back or agreeing on a specific point.`,
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
      `SPEAKING ROLE THIS PASS: ${shouldSpeak ? 'active speaker' : 'observer'}`,
      '',
      `RECENT MIND:\n${mindContext}`,
    ].join('\n');

    const { content: raw, reasoning } = await aiReasoningCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 360, response_format: { type: 'json_object' } }
    );
    appendReasoningToMind(ai, reasoning);

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return null;

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = String(parsed.chat || '').trim();
    chat = sanitizeChatText(chat, vision, 240);
    if (!shouldSpeak) chat = '';

    const action = String(parsed.action || 'no_change').toLowerCase().trim();
    const idx = Number(parsed.index);
    const conf = normalizeConfidence10(parsed.confidence, 6);
    const priorityWords = new Set(buildOperativePriorityStack(game, team).map(it => String(it.word || '').toUpperCase()));
    const currentClueWord = String(vision?.clue?.word || '').trim().toUpperCase();
    let focusClue = String(parsed.focusClue || '').trim().toUpperCase();
    if (focusClue && !priorityWords.has(focusClue) && focusClue !== currentClueWord) focusClue = '';
    if (!focusClue && currentClueWord) focusClue = currentClueWord;
    const cont = shouldSpeak ? (parsed.continue === true) : false;

    const marksIn = Array.isArray(parsed.marks) ? parsed.marks : [];
    const marks = [];
    const unrevealedIdx = new Set((vision.cards || []).filter(c => !c.revealed).map(c => Number(c.index)));
    for (const m of marksIn) {
      const mi = Number(m?.index);
      const tag = String(m?.tag || '').toLowerCase().trim();
      if (!['yes','maybe','no'].includes(tag)) continue;
      if (!unrevealedIdx.has(mi)) continue;
      marks.push({ index: mi, tag });
      if (marks.length >= 8) break;
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
  let openingChatState = { docs: [], sig: '' };
  try { openingChatState = await getTeamChatState(game.id, team, 14); } catch (_) {}
  const openingPhase = deriveOperativeCouncilPhase(working, team, ops, proposalsByAi, openingChatState.docs, 0);
  const openingSpeakers = selectOperativeCouncilSpeakers(ops, openingPhase, proposalsByAi, `${key}|opening`);

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
    applyEmotionDriftFromState(ai, working, buildAIVision(working, ai));

    aiThinkingState[ai.id] = true;
    try {
      const shouldSpeak = openingSpeakers.has(String(ai.id || ''));
      const prop = await aiOperativePropose(ai, working, {
        requireMarks: true,
        councilSize: ops.length,
        chatDocs: chatBefore.docs,
        conversationPhase: openingPhase,
        shouldSpeak
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
      let phaseState = null;
      let roundSpeakers = new Set();
      try {
        const roundChatState = await getTeamChatState(game.id, team, 16);
        phaseState = deriveOperativeCouncilPhase(working, team, ops, proposalsByAi, roundChatState.docs, rounds);
      } catch (_) {
        phaseState = deriveOperativeCouncilPhase(working, team, ops, proposalsByAi, [], rounds);
      }
      roundSpeakers = selectOperativeCouncilSpeakers(ops, phaseState, proposalsByAi, `${key}|round:${rounds}`);
      let anySpoke = false;
      for (const ai of ops) {
        if (!roundSpeakers.has(String(ai.id || ''))) continue;
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
        applyEmotionDriftFromState(ai, working, buildAIVision(working, ai));

        aiThinkingState[ai.id] = true;
        try {
          const follow = await aiOperativeFollowup(ai, working, proposalsByAi, {
            chatDocs: chatBefore.docs,
            conversationPhase: phaseState,
            shouldSpeak: true
          });
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
    { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 360, response_format: { type: 'json_object' } }
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
  chat = sanitizeChatText(chat, vision, 220);
  chat = chat.slice(0, 220);
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
    `- Do NOT recap the whole discussion. 1-2 concise sentences.`,
    `- No card indices/numbers. No formal language.`,
    `- NEVER mention confidence numbers/percentages.`,
    `Return JSON only: {"mind":"2-4 lines thinking", "chat":"1-2 concise sentences"}`,
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
    { ai, brainRole: AI_BRAIN_ROLES.dialogue, temperature: core.temperature, max_tokens: 220, response_format: { type: 'json_object' } }
  );

  let parsed = null;
  try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
  if (!parsed) return '';
  const mind = String(parsed.mind || '').trim();
  if (mind) appendMind(ai, mind);
  let chat = String(parsed.chat || '').trim();
  chat = sanitizeChatText(chat, vision, 220);
  return chat ? chat.slice(0, 220) : '';
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

const _aiLiveDraftLastSentAtByGame = new Map();
const _aiLiveDraftLastSigByGame = new Map();

function _getAISpyDraftTypingProfile(ai) {
  let tempo = 58;
  let confidence = 55;
  let depth = 62;
  try {
    const core = ensureAICore(ai);
    const stats = core?.personality?.stats || {};
    tempo = Number(stats.tempo ?? stats.speed ?? tempo);
    confidence = Number(stats.confidence ?? confidence);
    depth = Number(stats.reasoning_depth ?? depth);
  } catch (_) {}

  const t = _clamp(Number.isFinite(tempo) ? tempo : 58, 1, 100);
  const c = _clamp(Number.isFinite(confidence) ? confidence : 55, 1, 100);
  const d = _clamp(Number.isFinite(depth) ? depth : 62, 1, 100);

  const typeMinMs = Math.round(_clamp(262 - (t * 0.92), 146, 350));
  const typeMaxMs = Math.round(_clamp(typeMinMs + 178 + ((100 - t) * 1.9) + (d * 0.85), 310, 860));
  const deleteMinMs = Math.round(_clamp(typeMinMs * 0.9, 112, 330));
  const deleteMaxMs = Math.round(_clamp(typeMaxMs * 1.04, 210, 740));
  const typoChance = _clamp(0.045 + ((100 - c) / 780), 0.02, 0.20);
  const hesitationChance = _clamp(0.10 + (d / 620), 0.12, 0.32);
  const burstChance = _clamp(0.16 + (t / 700), 0.12, 0.35);
  const minSendGapMs = Math.round(_clamp(310 + ((100 - t) * 2.3), 250, 720));

  return {
    typeMinMs,
    typeMaxMs,
    deleteMinMs,
    deleteMaxMs,
    typoChance,
    hesitationChance,
    burstChance,
    minSendGapMs,
    thinkMinMs: Math.round(1900 + (d * 14.5)),
    thinkMaxMs: Math.round(4300 + (d * 26.5) + ((100 - c) * 15.5)),
    sureMinMs: Math.round(1400 + ((100 - c) * 12.5)),
    sureMaxMs: Math.round(3600 + (d * 16.4) + ((100 - c) * 19.4)),
    rethinkMinMs: Math.round(2300 + ((100 - c) * 11.6)),
    rethinkMaxMs: Math.round(5800 + (d * 19.5) + ((100 - c) * 25.2)),
  };
}

function _randMs(minMs, maxMs) {
  const lo = Math.max(0, Number(minMs) || 0);
  const hi = Math.max(lo, Number(maxMs) || lo);
  return Math.round(lo + Math.random() * (hi - lo));
}

function _randUpperAlpha() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  return letters[Math.floor(Math.random() * letters.length)];
}

function _normalizeLiveDraftSig(payload) {
  if (!payload || typeof payload !== 'object') return '__clear__';
  return [
    String(payload.team || '').toLowerCase(),
    String(payload.word || '').toUpperCase(),
    String(payload.number || ''),
    String(payload.byId || ''),
    String(payload.byName || ''),
  ].join('|');
}

function _renderLiveDraftOnly() {
  try {
    if (typeof renderClueArea !== 'function') return;
    const spectator = (typeof isSpectating === 'function') ? !!isSpectating() : false;
    const myTeamColor = (typeof getMyTeamColor === 'function') ? getMyTeamColor() : null;
    const isSpy = (!spectator && typeof isCurrentUserSpymaster === 'function')
      ? !!isCurrentUserSpymaster()
      : false;
    renderClueArea(isSpy, myTeamColor, spectator);
  } catch (_) {}
}

async function _setAILiveClueDraft(game, team, ai, word, number, opts = {}) {
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
  const force = !!opts.force;
  const minGapMs = Number.isFinite(+opts.minGapMs) ? Math.max(0, +opts.minGapMs) : 110;
  const nextSig = _normalizeLiveDraftSig(payload);
  const prevSig = _aiLiveDraftLastSigByGame.get(gid) || '';
  const lastSentAt = Number(_aiLiveDraftLastSentAtByGame.get(gid) || 0);
  const now = Date.now();

  // If this AI is running in the same browser session as the viewer (common in
  // singleplayer), update the in-memory snapshot immediately so the typing
  // animation renders without waiting for Firestore round-trips.
  try {
    if (typeof currentGame !== 'undefined' && currentGame && String(currentGame?.id || '').trim() === gid) {
      currentGame.liveClueDraft = payload;
      _renderLiveDraftOnly();
    }
  } catch (_) {}

  if (!force) {
    if (prevSig && prevSig === nextSig) return;
    if (payload && (now - lastSentAt) < minGapMs) return;
  }

  // Local practice game
  if (typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid)) {
    if (typeof window.mutateLocalPracticeGame === 'function') {
      window.mutateLocalPracticeGame(gid, (draft) => {
        draft.liveClueDraft = payload;
      }, { skipRender: true });
      _renderLiveDraftOnly();
    }
    _aiLiveDraftLastSentAtByGame.set(gid, Date.now());
    _aiLiveDraftLastSigByGame.set(gid, nextSig);
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
    _aiLiveDraftLastSentAtByGame.set(gid, Date.now());
    _aiLiveDraftLastSigByGame.set(gid, nextSig);
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

  const profile = _getAISpyDraftTypingProfile(ai);

  // If callers provide explicit "considered" clues, use those.
  let considered = _dedupeConsideredClues(opts.considered);
  considered = considered.filter(x => x?.clue && !boardWords.includes(x.clue)).slice(0, 5);

  // Ensure the final clue is represented.
  if (!considered.find(x => x.clue === finalWord && (x.number === null || x.number === finalNum))) {
    considered.push({ clue: finalWord, number: finalNum });
  }

  const nonFinal = considered
    .filter((x) => x?.clue && x.clue !== finalWord)
    .slice(0, 3)
    .map((x) => ({ clue: _sanitizeOneWordClue(x.clue), number: x.number }));

  // If we only got one final candidate, seed one false start so the AI can
  // "type, doubt, delete, rethink" before committing.
  if (!nonFinal.length) {
    const fallbackDrafts = _pickFakeDraftWords(ai, finalWord, boardWords)
      .map((w) => _sanitizeOneWordClue(w))
      .filter((w) => w && w !== finalWord && !boardWords.includes(w))
      .slice(0, 2);
    for (const w of fallbackDrafts) nonFinal.push({ clue: w, number: null });
  }

  const attempts = [
    ...nonFinal.slice(0, 3).map((x) => ({ clue: x.clue, number: x.number, isFinal: false })),
    { clue: finalWord, number: finalNum, isFinal: true },
  ];

  const typeDraftWord = async (candidateWord, candidateNum) => {
    const clue = _sanitizeOneWordClue(candidateWord);
    if (!clue) return;

    let draft = '';
    const maxTypos = (clue.length >= 5 && Math.random() < 0.75)
      ? (Math.random() < 0.3 ? 2 : 1)
      : (Math.random() < 0.2 ? 1 : 0);
    let typoCount = 0;

    for (let i = 0; i < clue.length; i += 1) {
      const ch = clue[i];

      const canTypo = typoCount < maxTypos && i > 0 && i < (clue.length - 1);
      if (canTypo && Math.random() < profile.typoChance) {
        draft += _randUpperAlpha();
        await _setAILiveClueDraft(game, team, ai, draft, null, { minGapMs: profile.minSendGapMs });
        await sleep(_randMs(profile.typeMinMs * 1.02, profile.typeMaxMs * 1.22));

        draft = draft.slice(0, -1);
        await _setAILiveClueDraft(game, team, ai, draft || null, null, { minGapMs: profile.minSendGapMs });
        await sleep(_randMs(profile.deleteMinMs, profile.deleteMaxMs));
        typoCount += 1;
      }

      draft += ch;
      const isLast = i === clue.length - 1;
      const showNumber = isLast ? candidateNum : null;
      await _setAILiveClueDraft(game, team, ai, draft, showNumber, {
        force: isLast,
        minGapMs: profile.minSendGapMs,
      });

      let delay = _randMs(profile.typeMinMs, profile.typeMaxMs);
      if (Math.random() < profile.burstChance) delay = Math.max(130, Math.round(delay * 0.84));
      if (Math.random() < profile.hesitationChance && i >= 1) {
        delay += _randMs(620, 2200);
      }
      await sleep(delay);
    }
  };

  const deleteDraftWord = async (candidateWord) => {
    const clue = _sanitizeOneWordClue(candidateWord);
    if (!clue) return;
    for (let i = clue.length - 1; i >= 0; i -= 1) {
      const next = i > 0 ? clue.slice(0, i) : null;
      await _setAILiveClueDraft(game, team, ai, next, null, {
        force: i <= 1,
        minGapMs: profile.minSendGapMs,
      });
      let delay = _randMs(profile.deleteMinMs, profile.deleteMaxMs);
      if (Math.random() < 0.25) delay += _randMs(420, 1380);
      await sleep(Math.max(110, delay));
    }
  };

  await _setAILiveClueDraft(game, team, ai, null, null, { force: true, minGapMs: profile.minSendGapMs });

  for (let i = 0; i < attempts.length; i += 1) {
    const attempt = attempts[i];
    const candidateWord = _sanitizeOneWordClue(attempt?.clue);
    if (!candidateWord) continue;
    const candidateNumber = attempt.isFinal
      ? finalNum
      : (Number.isFinite(+attempt?.number) ? Math.max(0, Math.min(9, parseInt(attempt.number, 10) || 0)) : null);

    await sleep(i === 0
      ? _randMs(profile.thinkMinMs, profile.thinkMaxMs)
      : _randMs(profile.rethinkMinMs, profile.rethinkMaxMs));

    await typeDraftWord(candidateWord, candidateNumber);

    // "Are you sure?" pause before submit/delete.
    await sleep(_randMs(profile.sureMinMs, profile.sureMaxMs));

    if (attempt.isFinal) {
      await sleep(_randMs(1500, 4200));
      return; // Keep the final draft visible; submit happens immediately after.
    }

    await deleteDraftWord(candidateWord);
    await sleep(_randMs(420, 1400));
  }
}

async function submitClueDirect(ai, game, clueWord, clueNumber) {
  if (!ai || !game || game.winner) return false;
  if (String(ai?.mode || '') !== 'autonomous') return false;
  if (String(ai?.seatRole || '') !== 'spymaster') return false;
  if (String(game.currentPhase || '') !== 'spymaster') return false;
  if (String(game.currentTeam || '') !== String(ai?.team || '')) return false;
  if (hasBlockingPendingClueReview(game)) return false;
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
  if (!clueAccepted) {
    try {
      await _setAILiveClueDraft(game, team, ai, null, null, { force: true });
    } catch (_) {}
  }
  return clueAccepted;
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
      { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 360, response_format: { type: 'json_object' } }
    );
    appendReasoningToMind(ai, reasoning);

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return null;

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let chat = String(parsed.chat || '').trim();
    chat = sanitizeChatText(chat, vision, 220);

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
      ...(vision.secondsRemaining !== null && vision.totalPhaseSeconds > 0 ? [
        vision.secondsRemaining <= 8
          ? `- ⚠ TIME CRITICAL: Only ${vision.secondsRemaining}s left! Pick ONE candidate and commit instantly — no elaborate mind, output JSON NOW.`
          : vision.secondsRemaining <= 20
          ? `- ⏱ LOW TIME: ${vision.secondsRemaining}s left. Be decisive — short mind, go with your first solid connection.`
          : vision.secondsRemaining <= 45
          ? `- ⏱ ${vision.secondsRemaining}s remaining. Keep your reasoning tight — don't over-analyze.`
          : `- ⏱ ${vision.secondsRemaining}s remaining. You have time — explore multiple connections before committing.`,
      ] : []),
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
        { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 420, response_format: { type: 'json_object' } }
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
    const clueHistoryCtx = buildClueHistoryContext(game, team);
    const priorityCtx = buildOperativePriorityContext(game, team);
    const teamRoster = team === 'red'
      ? (Array.isArray(game?.redPlayers) ? game.redPlayers : [])
      : (Array.isArray(game?.bluePlayers) ? game.bluePlayers : []);
    const operativeCount = teamRoster.filter(p => String(p?.role || 'operative') !== 'spymaster').length;

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
      `{"mind":"first-person inner monologue", "action":"guess|end_turn", "index":N, "focusClue":"CLUEWORD", "confidence":1-10, "marks":[{"index":N,"tag":"yes|maybe|no"}], "chat":"optional teammate message (1–3 natural sentences, no indices or "N =" formatting)"}`,
      ``,
      `Hard requirements:`,
      `- If action="guess", index MUST be one of the unrevealed indices shown.`,
      `- Use the clue: "${String(vision.clue.word || '').toUpperCase()}" for ${Number(vision.clue.number || 0)}.`,
      `- You have ${remainingGuesses} guess(es) remaining this turn.`,
      `- React to teammate considering initials if they show clear consensus/conflict.`,
      `- If older clues still have words left, mention that naturally when relevant (example form: "we still have 2 left on BANANA").`,
      `- Set 3-8 marks when possible so your initials are visible on multiple cards.`,
      `- Occasionally address teammates by first name when directly replying or debating.`,
      operativeCount >= 3 ? `- There are ${operativeCount} operatives on your team. Prefer checking in before a risky guess.` : '',
    ].join('\n');

    const mindContext = core.mindLog.slice(-10).join('\n');
    const userPrompt = [
      `VISION:\n${JSON.stringify(vision)}`,
      ``,
      `UNREVEALED WORDS (choose ONLY from this list):\n${list}`,
      teamChatContext,
      ``,
      clueHistoryCtx ? `${clueHistoryCtx}` : '',
      ``,
      priorityCtx ? `${priorityCtx}` : '',
      ``,
      markerCtx ? `${markerCtx}` : '',
      ``,
      `RECENT MIND:\n${mindContext}`
    ].join('\n');

    let parsed = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const { content: raw, reasoning } = await aiReasoningCompletion(
        [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
        { ai, brainRole: AI_BRAIN_ROLES.reasoning, max_tokens: 360, response_format: { type: 'json_object' } }
      );
      appendReasoningToMind(ai, reasoning);
      try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
      if (!parsed) continue;

      const mind = String(parsed.mind || '').trim();
      if (mind) appendMind(ai, mind);

      const action = String(parsed.action || '').toLowerCase().trim();
      if (action === 'end_turn') {
        try { await syncAIConsideringState(game.id, team, ai, { action: 'end_turn', marks: [], clear: true }); } catch (_) {}
        return 'end_turn';
      }

      const idx = Number(parsed.index);
      const candidate = unrevealed.find(c => c.index === idx);
      if (candidate) {
        const marksIn = Array.isArray(parsed.marks) ? parsed.marks : [];
        const marks = [];
        for (const m of marksIn) {
          const mi = Number(m?.index);
          const tag = String(m?.tag || '').toLowerCase().trim();
          if (!['yes', 'maybe', 'no'].includes(tag)) continue;
          if (!unrevealed.some(c => c.index === mi)) continue;
          marks.push({ index: mi, tag });
          if (marks.length >= 8) break;
        }
        if (!marks.some(m => Number(m.index) === Number(candidate.index))) {
          marks.unshift({ index: candidate.index, tag: 'yes' });
        }
        const chat = String(parsed.chat || '').trim();
        if (chat) {
          // Keep team chat short and in-character (public), mind stays private.
          await sendAIChatMessage(ai, game, chat.slice(0, 240));
        }
        try {
          await syncAIConsideringState(game.id, team, ai, {
            action: 'guess',
            index: candidate.index,
            marks
          });
        } catch (_) {}
        const revealResult = await aiRevealCard(ai, game, candidate.index, true);
        if (revealResult?.turnEnded) return 'turn_already_ended';
        return 'continue';
      }
    }

    // Fallback: if parsing failed repeatedly, end turn rather than random-guess.
    appendMind(ai, `I couldn't produce a valid guess JSON. I'll end the turn to avoid chaos.`);
    try { await syncAIConsideringState(game.id, team, ai, { action: 'end_turn', marks: [], clear: true }); } catch (_) {}
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

    if (didEnd) {
      try { await syncAIConsideringState(game.id, ai.team, ai, { action: 'end_turn', marks: [], clear: true }); } catch (_) {}
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

function _shortPersonName(raw) {
  try {
    const base = String(raw || '').replace(/^ai\s+/i, '').trim();
    if (!base) return '';
    const first = base.split(/\s+/).filter(Boolean)[0] || '';
    return first.replace(/[^a-zA-Z0-9'-]/g, '');
  } catch (_) {
    return '';
  }
}

function _pickAddressedTeammateName(chatDocs, aiName, preferred = '') {
  try {
    const aiShort = _shortPersonName(aiName).toLowerCase();
    const preferredShort = _shortPersonName(preferred);
    if (preferredShort && preferredShort.toLowerCase() !== aiShort) return preferredShort;

    const docs = Array.isArray(chatDocs) ? chatDocs.slice(-10) : [];
    const pool = [];
    for (const d of docs) {
      const n = _shortPersonName(d?.senderName || '');
      if (!n) continue;
      if (n.toLowerCase() === aiShort) continue;
      if (!pool.some(x => x.toLowerCase() === n.toLowerCase())) pool.push(n);
    }
    if (!pool.length) return '';
    return pool[Math.floor(Math.random() * pool.length)];
  } catch (_) {
    return '';
  }
}

function deriveSocialChatPhase(game, vision, contextKey, chatDocs = [], lastMessage = '') {
  const docs = (Array.isArray(chatDocs) ? chatDocs : []).slice(-10);
  const texts = docs.map(d => String(d?.text || '').trim()).filter(Boolean);
  const greetingCount = texts.filter(t => isGreetingLike(t)).length;
  const disagreementCount = texts.filter(t => /\b(no|nah|idk about|not sold|disagree|risky|force|bad pick|don't like)\b/i.test(t)).length;
  const questionCount = texts.filter(t => /\?/.test(t)).length;
  const unresolved = (Array.isArray(vision?.clueStack) ? vision.clueStack : [])
    .filter(c => Number(c?.remainingTargets || 0) > 0)
    .length;
  let secsLeft = Number(vision?.secondsRemaining);
  if (!Number.isFinite(secsLeft)) secsLeft = _remainingSecondsFromGameTimer(game);

  let key = 'discussion';
  if (contextKey === 'start' || (!texts.length && !String(lastMessage || '').trim())) key = 'greeting';
  else if (contextKey === 'end_turn_deliberation' || (Number.isFinite(secsLeft) && secsLeft <= 18)) key = 'reasoning';
  else if (disagreementCount >= 2 || (questionCount >= 2 && disagreementCount >= 1)) key = 'debate';
  else if (unresolved >= 2) key = 'search';

  const defs = {
    greeting: {
      label: 'Greeting',
      styleHint: 'friendly opener, then quickly move into strategy',
      socialCue: 'light social energy; not everyone has to talk',
    },
    search: {
      label: 'Search',
      styleHint: 'scan possibilities and eliminate risky pulls',
      socialCue: 'conversation can be relaxed, but each message should add a new angle',
    },
    debate: {
      label: 'Debate',
      styleHint: 'direct disagreement with concrete evidence',
      socialCue: 'a couple voices can lead while others observe',
    },
    discussion: {
      label: 'Discussion',
      styleHint: 'balanced back-and-forth with practical reasoning',
      socialCue: 'engage naturally and avoid pile-on agreement',
    },
    reasoning: {
      label: 'Reasoning',
      styleHint: 'decision-focused, concise, risk-aware',
      socialCue: 'speak only if it moves the decision forward',
    },
  };
  return { key, ...(defs[key] || defs.discussion) };
}

async function generateAIChatMessage(ai, game, context, opts = {}) {
  try {
    // Optional snapshot refresh for call sites that want it.
    if (opts.refreshSnapshot) {
      try {
        const fresh = await getGameSnapshot(game?.id);
        if (fresh && fresh.cards) game = fresh;
      } catch (_) {}
    }

    const core = ensureAICore(ai);
    if (!core) return '';
    if (!game || game.winner) return '';
    const team = ai.team;

    const vision = buildAIVision(game, ai);
    const unrevealed = (vision.cards || []).filter(c => !c.revealed).map(c => String(c.word || '').toUpperCase());
    const chatDocs = Array.isArray(opts.chatDocs)
      ? opts.chatDocs
      : await fetchRecentTeamChatDocs(game.id, team, 10, { cacheMs: 900 });
    const teamChat = (chatDocs || []).slice(-10).map(m => `${m.senderName}: ${m.text}`).join('\n');
    const clueStackRows = Array.isArray(vision?.clueStack) ? vision.clueStack : [];
    const unresolvedClues = clueStackRows.filter(c => Number(c?.remainingTargets || 0) > 0);
    const clueStackHint = unresolvedClues.length
      ? unresolvedClues.slice(0, 4).map(c => `${String(c.word || '').toUpperCase()} (${Number(c.remainingTargets || 0)} left)`).join(', ')
      : '';
    const lastMessage = (opts && opts.lastMessage) ? String(opts.lastMessage).trim() : '';
    const forceResponse = !!opts.forceResponse;
    const contextKey = String(context || '').toLowerCase();
    const isReplyContext = contextKey === 'reply';
    const socialPhase = deriveSocialChatPhase(game, vision, contextKey, chatDocs, lastMessage);
    const chatMaxLen = isReplyContext ? 260 : (contextKey === 'end_turn_deliberation' ? 230 : 240);
    const addressee = _pickAddressedTeammateName(chatDocs, ai?.name, opts?.lastSenderName || '');
    const addressChance = (socialPhase.key === 'debate')
      ? (isReplyContext ? 0.62 : 0.35)
      : (socialPhase.key === 'greeting' ? (isReplyContext ? 0.58 : 0.30) : (isReplyContext ? 0.52 : 0.24));
    const shouldAddressName = !!addressee && (Math.random() < addressChance);

    const persona = core.personality;
    applyEmotionDriftFromState(ai, game, vision);
    const emo = describeEmotion(core);
    const systemPrompt = [
      `You are ${ai.name}, chatting with teammates during a Codenames game.`,
      buildPersonalityBlockBrief(persona),
      `CHAT PHASE: ${socialPhase.label} (${socialPhase.key}).`,
      `PHASE STYLE: ${socialPhase.styleHint}.`,
      `SOCIAL CUE: ${socialPhase.socialCue}.`,
      `CURRENT EMOTION: mood=${emo.mood}, energy=${emo.energy}, social=${emo.socialTone}, intensity=${emo.intensity}/100.`,
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
      `- If unfinished clues remain from earlier turns, mention them naturally when relevant (e.g. "still 2 left on BANANA").`,
      `- Debate directly when needed: agree/disagree with a concrete reason, not vibes only.`,
      `- Mention at least one clue linkage, risk, or elimination when talking strategy.`,
      shouldAddressName ? `- In this message, naturally address ${addressee} by name once.` : '',
      (!shouldAddressName && addressee) ? `- You may address ${addressee} by name if it fits naturally.` : '',
      isReplyContext ? `- If someone greets you, greet back naturally first.` : '',
      isReplyContext ? `- In replies, react to the latest message and add a distinct angle.` : '',
      `- Keep it concise but real: 1-3 sentences, <=${chatMaxLen} chars.`,
      `- Never reference card indices/numbers. Use actual board WORDS only.`,
      `- Don't invent board words — only mention words from the unrevealed list.`,
      `- No formal language. No "I believe", "I suggest", "Additionally".`,
      `Return JSON only: {"mind":"(private thinking)", "msg":"(your message or empty string)"}`,
    ].join('\n');

    const mindContext = core.mindLog.slice(-6).join('\n');
    const userPrompt = [
      `CONTEXT: ${String(context || 'general')}`,
      `CHAT PHASE CONTEXT: ${socialPhase.key}`,
      lastMessage ? `LAST TEAM MESSAGE: ${lastMessage}` : '',
      shouldAddressName ? `NATURAL NAME TARGET: ${addressee}` : '',
      teamChat ? `RECENT TEAM CHAT:\n${teamChat}` : '',
      clueStackHint ? `CLUES LEFT CONTEXT:\n${clueStackHint}` : '',
      `UNREVEALED WORDS:\n${unrevealed.join(', ')}`,
      `VISION:\n${JSON.stringify(vision)}`,
      `RECENT MIND:\n${mindContext}`,
    ].filter(Boolean).join('\n\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { ai, brainRole: AI_BRAIN_ROLES.dialogue, temperature: Math.min(1.15, (core.temperature * 1.0) + 0.10), max_tokens: 220, response_format: { type: 'json_object' } }
    );

    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) {}
    if (!parsed) return '';

    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);

    let msg = String(parsed.msg || '').trim();
    msg = sanitizeChatText(msg, vision, chatMaxLen);
    // Keep it short + conversational: up to ~3 sentences.
    try {
      const m = String(msg || '').trim();
      const parts = m.split(/(?<=[.!?])\s+/).filter(Boolean);
      msg = (parts.slice(0, 3).join(' ') || m).trim();
    } catch (_) {}
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
      if (upperMsg.includes(w)) return msg.slice(0, chatMaxLen);
    }
    // If it mentions no unrevealed word, it's fine.
    return msg.slice(0, chatMaxLen);
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
      { ai, brainRole: AI_BRAIN_ROLES.reaction, temperature: Math.min(1.0, core.temperature * 0.75), max_tokens: 160, response_format: { type: 'json_object' } }
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

function _logTeamFromEntry(entry, game) {
  try {
    const e = String(entry || '');
    const redName = String(game?.redTeamName || 'Red Team');
    const blueName = String(game?.blueTeamName || 'Blue Team');
    const redTokens = [redName, 'Red Team', 'Red'];
    const blueTokens = [blueName, 'Blue Team', 'Blue'];
    if (redTokens.some(t => t && new RegExp(`\\(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'i').test(e))) return 'red';
    if (blueTokens.some(t => t && new RegExp(`\\(${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`, 'i').test(e))) return 'blue';
    if (redTokens.some(t => t && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(e))) return 'red';
    if (blueTokens.some(t => t && new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(e))) return 'blue';
    return '';
  } catch (_) {
    return '';
  }
}

function _classifyActionLogEvent(entry, game) {
  try {
    const text = String(entry || '').trim();
    if (!text) return null;
    const team = _logTeamFromEntry(text, game);
    const actorMatch = text.match(/^(.+?)\s+\([^)]+\)\s+(guessed|ended)\b/i);
    const actorName = actorMatch ? String(actorMatch[1] || '').trim() : '';

    const guessWordMatch = text.match(/guessed\s+"([^"]+)"/i);
    const guessedWord = guessWordMatch ? String(guessWordMatch[1] || '').trim().toUpperCase() : '';

    if (/ASSASSIN/i.test(text)) {
      return { kind: 'guess_assassin', team, actorName, guessedWord, text };
    }
    if (/\bWrong!\b/i.test(text)) {
      return { kind: 'guess_wrong', team, actorName, guessedWord, text };
    }
    if (/\bNeutral\b/i.test(text)) {
      return { kind: 'guess_neutral', team, actorName, guessedWord, text };
    }
    if (/\bCorrect!\b/i.test(text)) {
      return { kind: 'guess_correct', team, actorName, guessedWord, text };
    }
    if (/ended their turn/i.test(text)) {
      return { kind: 'end_turn', team, actorName, guessedWord, text };
    }
    const clueMatch = text.match(/Spymaster:\s*"([^"]+)"\s+for\s+(\d+)/i);
    if (clueMatch) {
      return {
        kind: 'clue_given',
        team,
        clueWord: String(clueMatch[1] || '').trim().toUpperCase(),
        clueNumber: Number(clueMatch[2] || 0),
        text,
      };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function _cleanupSeenActionReactionEvents() {
  const now = Date.now();
  for (const [k, at] of aiSeenActionReactionEvents.entries()) {
    if ((now - Number(at || 0)) > (2 * 60 * 1000)) aiSeenActionReactionEvents.delete(k);
  }
}

function _teamOperativeCount(game, team) {
  const roster = String(team || '').toLowerCase() === 'red'
    ? (Array.isArray(game?.redPlayers) ? game.redPlayers : [])
    : (Array.isArray(game?.bluePlayers) ? game.bluePlayers : []);
  return roster.filter(p => String(p?.role || 'operative') !== 'spymaster').length;
}

async function _assessQuickGuessWithoutCheckin(event, game) {
  try {
    if (!event || !event.team || !game?.id) return false;
    if (!/^guess_/.test(String(event.kind || ''))) return false;
    if (_teamOperativeCount(game, event.team) < 2) return false;

    const docs = await fetchRecentTeamChatDocs(game.id, event.team, 20, { cacheMs: 120, bypassCache: false });
    if (!docs.length) return true;
    const now = Date.now();
    const recent = docs.filter(m => (now - Number(m.createdAtMs || 0)) <= 8500);
    if (!recent.length) return true;
    const actor = String(event.actorName || '').trim().toLowerCase();
    const nonActorMsgs = recent.filter(m => String(m.senderName || '').trim().toLowerCase() !== actor);
    return nonActorMsgs.length <= 1;
  } catch (_) {
    return false;
  }
}

async function generateAIActionReactionMessage(ai, game, event, opts = {}) {
  try {
    const core = ensureAICore(ai);
    if (!core) return '';
    const vision = buildAIVision(game, ai);
    applyEmotionDriftFromState(ai, game, vision, { eventKind: String(event?.kind || ''), force: true });
    const persona = core.personality;
    const emo = describeEmotion(core);
    const unresolved = (Array.isArray(vision?.clueStack) ? vision.clueStack : [])
      .filter(c => Number(c?.remainingTargets || 0) > 0)
      .slice(0, 4)
      .map(c => `${String(c.word || '').toUpperCase()} (${Number(c.remainingTargets || 0)} left)`)
      .join(', ');
    const markerCtx = buildTeamMarkerContext(game, ai.team, _markerOwnerId(ai.id));

    const systemPrompt = [
      `You are ${ai.name}, OPERATIVE on ${String(ai.team || '').toUpperCase()} team in Codenames.`,
      buildPersonalityBlockBrief(persona),
      `CURRENT EMOTION: mood=${emo.mood}, social=${emo.socialTone}, intensity=${emo.intensity}/100.`,
      `React in team chat to a recent game event.`,
      `- Keep it 1 short sentence (max 130 chars).`,
      `- Sound natural and specific to this event.`,
      `- If teammate guessed too fast without discussion, mention coordination politely (no lecturing).`,
      `- If there are clues left from older clues, you can reference them naturally.`,
      `- No card indices/numbers. Use WORDS only.`,
      `Return JSON only: {"mind":"private thought","msg":"chat message or empty string"}`,
    ].join('\n');

    const userPrompt = [
      `EVENT KIND: ${String(event?.kind || '')}`,
      `EVENT TEXT: ${String(event?.text || '')}`,
      opts.quickGuessNoConsensus ? `EVENT DETAIL: guess happened without much team check-in` : '',
      unresolved ? `CLUES LEFT: ${unresolved}` : '',
      markerCtx ? markerCtx : '',
      `VISION:\n${JSON.stringify(vision)}`,
      `RECENT MIND:\n${core.mindLog.slice(-8).join('\n')}`,
    ].filter(Boolean).join('\n\n');

    const raw = await aiChatCompletion(
      [{ role: 'system', content: systemPrompt }, { role: 'user', content: userPrompt }],
      { ai, brainRole: AI_BRAIN_ROLES.reaction, temperature: Math.min(1.04, (core.temperature * 0.86) + 0.06), max_tokens: 170, response_format: { type: 'json_object' } }
    );
    let parsed = null;
    try { parsed = JSON.parse(String(raw || '').trim()); } catch (_) { parsed = null; }
    if (!parsed) return '';
    const mind = String(parsed.mind || '').trim();
    if (mind) appendMind(ai, mind);
    const msg = sanitizeChatText(String(parsed.msg || '').trim(), vision, 130);
    return msg ? msg.slice(0, 130) : '';
  } catch (_) {
    return '';
  }
}

async function queueAIReactionsFromLogEntries(newEntries, game) {
  try {
    const entries = Array.isArray(newEntries) ? newEntries.map(e => String(e || '').trim()).filter(Boolean) : [];
    if (!entries.length || !game?.id) return;

    _cleanupSeenActionReactionEvents();

    const aiOps = (aiPlayers || []).filter(a => a && a.mode === 'autonomous' && a.seatRole === 'operative');
    if (!aiOps.length) return;

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const event = _classifyActionLogEvent(entry, game);
      if (!event) continue;

      const eventKey = `${String(game.id)}|${String(event.kind)}|${String(event.text)}`;
      if (aiSeenActionReactionEvents.has(eventKey)) continue;
      aiSeenActionReactionEvents.set(eventKey, Date.now());

      const team = String(event.team || '').toLowerCase();
      if (team !== 'red' && team !== 'blue') continue;
      const opp = team === 'red' ? 'blue' : (team === 'blue' ? 'red' : '');
      const actorLower = String(event.actorName || '').trim().toLowerCase();

      const sameTeamPool = aiOps.filter(ai => String(ai.team || '') === team && String(ai.name || '').trim().toLowerCase() !== actorLower);
      const oppTeamPool = aiOps.filter(ai => opp && String(ai.team || '') === opp);

      const primaryPool = sameTeamPool.length ? sameTeamPool : aiOps;
      if (!primaryPool.length) continue;

      let quickGuessNoConsensus = false;
      if (/^guess_/.test(String(event.kind || ''))) {
        quickGuessNoConsensus = await _assessQuickGuessWithoutCheckin(event, game);
      }

      const candidates = [];
      primaryPool.sort((a, b) => Number(aiLastActionReactionMs[a.id] || 0) - Number(aiLastActionReactionMs[b.id] || 0));
      candidates.push(primaryPool[0]);
      if (oppTeamPool.length && (/guess_wrong|guess_neutral|guess_assassin/.test(String(event.kind || '')) || quickGuessNoConsensus)) {
        oppTeamPool.sort((a, b) => Number(aiLastActionReactionMs[a.id] || 0) - Number(aiLastActionReactionMs[b.id] || 0));
        candidates.push(oppTeamPool[0]);
      }

      for (const ai of candidates.filter(Boolean)) {
        const cadence = _effectiveCadenceForGame(ai, game);
        const now = Date.now();
        const minGap = Math.max(1800, Math.round(Number(cadence.chatReplyMinMs || 3500) * 0.82));
        if ((now - Number(aiLastActionReactionMs[ai.id] || 0)) < minGap) continue;
        if ((now - Number(aiLastChatReplyMs[ai.id] || 0)) < Math.max(1400, Math.round(minGap * 0.7))) continue;

        const kind = String(event.kind || '').toLowerCase();
        const aiTeam = String(ai.team || '').toLowerCase();
        const sameTeam = aiTeam === team;
        if (/guess_assassin/.test(kind)) {
          if (sameTeam) bumpEmotion(ai, -55, +30);
          else bumpEmotion(ai, +22, +16);
        } else if (/guess_wrong|guess_neutral/.test(kind)) {
          if (sameTeam) bumpEmotion(ai, -16, +14);
          else bumpEmotion(ai, +11, +9);
        } else if (/guess_correct/.test(kind)) {
          if (sameTeam) bumpEmotion(ai, +16, +9);
          else bumpEmotion(ai, -7, +7);
        } else if (/turn_end/.test(kind)) {
          bumpEmotion(ai, sameTeam ? -3 : +2, +3);
        }
        if (quickGuessNoConsensus && sameTeam) bumpEmotion(ai, -9, +11);
        applyEmotionDriftFromState(
          ai,
          game,
          buildAIVision(game, ai),
          {
            eventKind: quickGuessNoConsensus ? `${kind}_quick_guess_no_consensus` : kind,
            force: true
          }
        );

        let msg = await generateAIActionReactionMessage(ai, game, event, { quickGuessNoConsensus });
        if (!msg && quickGuessNoConsensus) {
          // Soft fallback when no model text is returned.
          msg = _pick([
            `quick check-in first? we still have lines to verify`,
            `hold up, let's sync before insta-locking guesses`,
            `can we align first? i don't want a rushed miss`,
          ]);
        }
        if (!msg) continue;

        await sendAIChatMessage(ai, game, msg, { force: true });
        aiLastActionReactionMs[ai.id] = Date.now();
        aiLastChatReplyMs[ai.id] = aiLastActionReactionMs[ai.id];
      }
    }
  } catch (_) {}
}

async function maybeAIReactToTimePressure(game) {
  try {
    if (!game || !game.id || game.winner) return false;
    if (String(game.currentPhase || '') !== 'operatives') return false;
    const team = String(game.currentTeam || '').toLowerCase();
    if (team !== 'red' && team !== 'blue') return false;

    let secondsLeft = null;
    try {
      const end = game?.timerEnd;
      const endMs = (typeof end?.toMillis === 'function')
        ? end.toMillis()
        : (end instanceof Date ? end.getTime() : Number(end));
      if (Number.isFinite(endMs)) secondsLeft = Math.max(0, Math.round((endMs - Date.now()) / 1000));
    } catch (_) {}
    if (!Number.isFinite(secondsLeft) || secondsLeft > 32) return false;

    const bucket = secondsLeft <= 7 ? 'critical' : (secondsLeft <= 15 ? 'low' : 'mid');
    const key = `${String(game.id)}:${team}`;
    if (aiLastTimePressureReactionByTeam[key] === bucket) return false;

    const pool = (aiPlayers || [])
      .filter(ai => ai && ai.mode === 'autonomous' && ai.seatRole === 'operative' && String(ai.team || '') === team)
      .sort((a, b) => Number(aiLastActionReactionMs[a.id] || 0) - Number(aiLastActionReactionMs[b.id] || 0));
    if (!pool.length) return false;
    const ai = pool[0];
    const cadence = _effectiveCadenceForGame(ai, game);
    const now = Date.now();
    if ((now - Number(aiLastActionReactionMs[ai.id] || 0)) < Math.max(1600, Math.round(Number(cadence.chatReplyMinMs || 3500) * 0.75))) return false;

    const event = {
      kind: 'time_pressure',
      team,
      text: `${team.toUpperCase()} operatives have ${secondsLeft}s left.`,
    };
    bumpEmotion(ai, secondsLeft <= 7 ? -3 : 0, secondsLeft <= 7 ? +16 : +10);
    applyEmotionDriftFromState(ai, game, buildAIVision(game, ai), { eventKind: 'time_pressure', force: true });
    let msg = await generateAIActionReactionMessage(ai, game, event, {});
    if (!msg) {
      msg = (secondsLeft <= 7)
        ? `time's almost gone, safest line now`
        : `clock's tight (${secondsLeft}s), keep this clean`;
    }

    await sendAIChatMessage(ai, game, msg, { force: true });
    aiLastActionReactionMs[ai.id] = Date.now();
    aiLastChatReplyMs[ai.id] = aiLastActionReactionMs[ai.id];
    aiLastTimePressureReactionByTeam[key] = bucket;
    return true;
  } catch (_) {
    return false;
  }
}

window.queueAIReactionsFromLogEntries = queueAIReactionsFromLogEntries;


// ─── AI Chat Typing Animation ──────────────────────────────────────────────
// Shows a realistic typing indicator + character-by-character reveal before
// the actual message is persisted. This simulates the same live-typing
// experience that spymasters see for clue drafts.

function _getAIChatTypingProfile(aiLike) {
  // Human-like typing profile with dynamic rhythm shifts, intra-word speed
  // changes, and realistic typo/revision behavior.
  const p = (aiLike && aiLike.__typingProfile) ? aiLike.__typingProfile : null;
  if (p) return p;

  let tempo = 60;
  let confidence = 60;
  let reasoningDepth = 58;
  try {
    const core = aiLike ? ensureAICore(aiLike) : null;
    const stats = core?.personality?.stats || core?.personality?.stats || {};
    tempo = Number(stats.tempo ?? stats.speed ?? 60);
    confidence = Number(stats.confidence ?? 60);
    reasoningDepth = Number(stats.reasoning_depth ?? 58);
  } catch (_) {}
  const t = Number.isFinite(tempo) ? Math.max(1, Math.min(100, tempo)) : 60;
  const c = Number.isFinite(confidence) ? Math.max(1, Math.min(100, confidence)) : 60;
  const d = Number.isFinite(reasoningDepth) ? Math.max(1, Math.min(100, reasoningDepth)) : 58;

  // Broad range so a single message can swing from quick bursts to hesitant pauses.
  const baseMinMs = Math.round(_clamp(190 + ((100 - t) * 1.65), 170, 520));
  const baseMaxMs = Math.round(_clamp(520 + ((100 - t) * 3.9) + (d * 2.1), 500, 1650));
  const jitterMs = Math.round(_clamp(190 + ((100 - c) * 2.2) + (d * 1.25), 160, 760));

  const burstChance = _clamp(0.14 + (t / 420), 0.14, 0.44);
  const slowStretchChance = _clamp(0.08 + ((100 - t) / 560) + (d / 760), 0.08, 0.34);
  const pauseChance = _clamp(0.16 + ((100 - c) / 340) + (d / 780), 0.12, 0.56);
  const microPauseChance = _clamp(0.22 + ((100 - c) / 460), 0.18, 0.52);
  const rhythmSwapChance = _clamp(0.19 + (d / 620), 0.16, 0.42);

  // Mistakes are now substantially more frequent and varied.
  const typoChance = _clamp(0.075 + ((100 - c) / 360), 0.06, 0.30);
  const typoBurstChance = _clamp(0.055 + ((100 - c) / 450), 0.04, 0.24);
  const wordRevisionChance = _clamp(0.14 + ((100 - c) / 290) + (d / 800), 0.12, 0.48);
  const halfDeleteChance = _clamp(0.12 + ((100 - c) / 300) + (d / 880), 0.10, 0.46);
  const fullWordRestartChance = _clamp(0.025 + ((100 - c) / 1700), 0.02, 0.10);

  const preThinkMinMs = Math.round(_clamp(980 + (d * 7.6), 940, 2700));
  const preThinkMaxMs = Math.round(_clamp(preThinkMinMs + 1450 + ((100 - t) * 14.8) + (d * 13.4), 2200, 9800));
  const submitPauseMinMs = Math.round(_clamp(650 + ((100 - c) * 3.4), 600, 1600));
  const submitPauseMaxMs = Math.round(_clamp(submitPauseMinMs + 920 + (d * 9.5), 1250, 5200));

  const out = {
    baseMinMs,
    baseMaxMs,
    jitterMs,
    burstChance,
    slowStretchChance,
    pauseChance,
    microPauseChance,
    rhythmSwapChance,
    typoChance,
    typoBurstChance,
    wordRevisionChance,
    halfDeleteChance,
    fullWordRestartChance,
    preThinkMinMs,
    preThinkMaxMs,
    submitPauseMinMs,
    submitPauseMaxMs,
  };
  if (aiLike) aiLike.__typingProfile = out;
  return out;
}

function _randChar() {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  return letters[Math.floor(Math.random() * letters.length)];
}

async function _simulateAITyping(aiLikeOrName, teamColor, text, opts = {}) {
  const container = document.getElementById('operative-chat-messages');
  if (!container || !text) return;

  const aiName = (typeof aiLikeOrName === 'string') ? aiLikeOrName : (`AI ${String(aiLikeOrName?.name || 'AI')}`);
  const profile = _getAIChatTypingProfile(typeof aiLikeOrName === 'string' ? null : aiLikeOrName);
  const allowTypos = opts.allowTypos !== false;
  const allowRevisions = opts.allowRevisions !== false;

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

  // Variable "thinking before typing" delay.
  const preThink = _randMs(profile.preThinkMinMs, profile.preThinkMaxMs) + Math.min(7600, Math.round(String(text || '').length * (20.5 + Math.random() * 31.2)));
  await new Promise(r => setTimeout(r, preThink));

  // Start revealing characters (with rhythm shifts, bursts, pauses, typo bursts,
  // half-word deletions, and rewrites).
  if (dotsEl) dotsEl.style.display = 'none';
  let revealed = '';

  const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));
  const setText = () => {
    if (textEl) textEl.textContent = revealed;
    const nearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;
    if (nearBottom) container.scrollTop = container.scrollHeight;
  };

  const isWordChar = (ch) => /[A-Za-z0-9']/u.test(String(ch || ''));
  const wordMeta = new Array(text.length).fill(null);
  for (let i = 0; i < text.length;) {
    if (!isWordChar(text[i])) { i += 1; continue; }
    let j = i;
    while (j < text.length && isWordChar(text[j])) j += 1;
    const len = j - i;
    for (let k = i; k < j; k += 1) {
      wordMeta[k] = {
        start: i,
        end: j - 1,
        len,
        pos: k - i,
      };
    }
    i = j;
  }

  const rhythmPool = [0.52, 0.65, 0.78, 0.92, 1.0, 1.14, 1.3, 1.5];
  let rhythm = rhythmPool[Math.floor(Math.random() * rhythmPool.length)];

  const pickRhythm = (preferFast = false) => {
    const fastPool = [0.52, 0.64, 0.75, 0.86, 0.94];
    const slowPool = [0.92, 1.05, 1.18, 1.34, 1.55];
    const source = preferFast ? fastPool : (Math.random() < 0.5 ? rhythmPool : slowPool);
    return source[Math.floor(Math.random() * source.length)];
  };

  const charDelay = (idx, ch) => {
    const m = wordMeta[idx];
    const base = _randMs(profile.baseMinMs, profile.baseMaxMs);
    let d = base + (Math.random() * profile.jitterMs * (Math.random() < 0.5 ? 1 : -0.45));

    // Within a word: slightly slower at start/end, faster in middle.
    if (m && m.len > 1) {
      const prog = m.pos / (m.len - 1);
      const contour = 1.10 - (Math.sin(prog * Math.PI) * 0.32);
      d *= contour;
    }

    d *= rhythm;

    if (Math.random() < profile.burstChance) d *= (0.62 + Math.random() * 0.33);
    if (Math.random() < profile.slowStretchChance) d *= (1.2 + Math.random() * 0.95);
    if (allowRevisions && Math.random() < profile.pauseChance && idx > 3) d += _randMs(230, 980);
    if (Math.random() < profile.microPauseChance && idx > 1) d += _randMs(70, 280);

    if ('.!?,;:'.includes(ch)) d += _randMs(190, 920);
    if (ch === ' ') d *= (0.52 + Math.random() * 0.34);

    return Math.max(95, d);
  };

  const backspaceMany = async (count, minMs = 54, maxMs = 210) => {
    let remaining = Math.max(0, Number(count) || 0);
    while (remaining > 0) {
      revealed = revealed.slice(0, -1);
      setText();
      remaining -= 1;
      await sleepMs(_randMs(Math.max(82, minMs), Math.max(320, maxMs)));
    }
  };

  const typeCharWithPossibleTypo = async (targetChar, idx) => {
    const shouldTypo = allowTypos && /[a-zA-Z]/.test(targetChar) && Math.random() < profile.typoChance;
    if (shouldTypo) {
      const typoBurst = Math.random() < profile.typoBurstChance ? _randMs(2, 4) : 1;
      for (let t = 0; t < typoBurst; t += 1) {
        revealed += _randChar();
        setText();
        await sleepMs(_randMs(120, 420));
      }
      await backspaceMany(typoBurst, 88, 320);
    }

    revealed += targetChar;
    setText();
    await sleepMs(charDelay(idx, targetChar));
  };

  // Optional quick early revision (start typing, rethink, delete a chunk, continue).
  if (allowRevisions && text.length >= 16 && Math.random() < (profile.wordRevisionChance * 0.55)) {
    const cut = Math.max(7, Math.min(24, Math.floor(text.length * (0.18 + Math.random() * 0.18))));
    for (let i = 0; i < cut; i += 1) {
      const ch = text[i];
      await typeCharWithPossibleTypo(ch, i);
      if (Math.random() < profile.rhythmSwapChance) rhythm = pickRhythm(Math.random() < 0.56);
    }
    await sleepMs(_randMs(760, 2600));
    const del = Math.max(3, Math.min(16, Math.floor(cut * (0.34 + Math.random() * 0.42))));
    await backspaceMany(del, 90, 320);
  }

  for (let i = revealed.length; i < text.length; i += 1) {
    const ch = text[i];
    const meta = wordMeta[i];
    if (Math.random() < profile.rhythmSwapChance) {
      const preferFast = !!(meta && (meta.pos >= 1) && (meta.pos <= Math.max(1, meta.len - 3)));
      rhythm = pickRhythm(preferFast);
    }

    await typeCharWithPossibleTypo(ch, i);

    // At word end: sometimes delete a big suffix and retype (realistic correction).
    if (allowRevisions && meta && meta.pos === meta.len - 1 && meta.len >= 4) {
      const doHalfDelete = Math.random() < profile.halfDeleteChance;
      const doFullRestart = Math.random() < profile.fullWordRestartChance;
      if (doHalfDelete || doFullRestart) {
        const deleteCount = doFullRestart
          ? meta.len
          : Math.max(2, Math.min(meta.len - 1, Math.round(meta.len * (0.4 + Math.random() * 0.34))));
        const suffixStart = (meta.end - deleteCount) + 1;
        const suffix = text.slice(suffixStart, meta.end + 1);

        await sleepMs(_randMs(420, 1650));
        await backspaceMany(deleteCount, 92, 340);
        await sleepMs(_randMs(320, 1200));

        for (let s = 0; s < suffix.length; s += 1) {
          const srcIdx = suffixStart + s;
          const sourceChar = text[srcIdx];
          await typeCharWithPossibleTypo(sourceChar, srcIdx);
          if (Math.random() < profile.rhythmSwapChance * 0.8) rhythm = pickRhythm(Math.random() < 0.5);
        }
      }
    }
  }

  // Pause after finishing, as if re-reading before submit.
  await new Promise(r => setTimeout(r, _randMs(profile.submitPauseMinMs, profile.submitPauseMaxMs)));

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
  const maxLen = Number.isFinite(+opts.maxLen) ? Math.max(120, Math.min(320, Math.round(+opts.maxLen))) : 240;

  // Make messages feel like real friends (and avoid repetition across AIs)
  try {
    const vision = buildAIVision(game, ai);
    const human = makeChatMoreHuman(ai, game, text, vision, { bypassSimilarity: force, maxLen });
    text = (human || '').trim();

    // Guardrail: don't mention already-revealed words.
    // If the model still references a revealed card, drop the message instead of confusing players.
    try {
      const cards = Array.isArray(vision?.cards) ? vision.cards : [];
      const revealed = new Set(cards.filter(c => c && c.revealed).map(c => String(c.word || '').toUpperCase()));
      const unrevealed = new Set(cards.filter(c => c && !c.revealed).map(c => String(c.word || '').toUpperCase()));
      const tokens = String(text || '').toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
      const hit = tokens.find(w => revealed.has(w) && !unrevealed.has(w));
      if (hit && !force) return;
    } catch (_) {}
  } catch (_) {}
  if (!text && force) text = originalText.slice(0, maxLen);
  if (!text) return;

  // Final shaping: shorter + more conversational.
  try {
    let t = String(text || '').trim();
    // Max ~3 short sentences.
    const parts = t.split(/(?<=[.!?])\s+/).filter(Boolean);
    t = parts.slice(0, 3).join(' ').trim() || t;
    // Hard cap.
    if (t.length > maxLen) t = t.slice(0, maxLen).trim();
    text = t;
  } catch (_) {}

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
    await _simulateAITyping(ai, teamColor, text, {
      allowTypos: true,
      allowRevisions: true,
    });
  } catch (_) {}

  // Local practice: persist chat in local game state (no Firestore round-trip).
  try {
    const gid = String(game?.id || '').trim();
    if (gid && typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid) && typeof window.mutateLocalPracticeGame === 'function') {
      const chatField = teamColor === 'blue' ? 'blueChat' : 'redChat';
      const nowMs = Date.now();
      const cap = 120;
      window.mutateLocalPracticeGame(gid, (draft) => {
        const list = Array.isArray(draft?.[chatField]) ? [...draft[chatField]] : [];
        list.push({
          id: `ai_chat_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
          senderId: String(ai?.odId || ai?.id || '').trim() || `ai:${String(ai?.name || 'AI')}`,
          senderName: `AI ${String(ai?.name || 'AI')}`,
          text: String(text || '').trim(),
          createdAtMs: nowMs,
        });
        draft[chatField] = list.length > cap ? list.slice(-cap) : list;
        draft.updatedAtMs = nowMs;
        draft.lastMoveAtMs = nowMs;
      });
      try { _invalidateTeamChatCache(gid, teamColor); } catch (_) {}

      // Remember the last few messages so we can de-dup future replies.
      try {
        const t = String(teamColor);
        if (!aiChatMemory[gid]) aiChatMemory[gid] = {};
        if (!aiChatMemory[gid][t]) aiChatMemory[gid][t] = [];
        aiChatMemory[gid][t].push(String(text));
        if (aiChatMemory[gid][t].length > 18) aiChatMemory[gid][t] = aiChatMemory[gid][t].slice(-12);
      } catch (_) {}
      return;
    }
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
    try { _invalidateTeamChatCache(game.id, teamColor); } catch (_) {}

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
    if (!game || game.winner) return false;

    const core = ensureAICore(ai);
    if (!core) return false;
    const cadence = _effectiveCadenceForGame(ai, game);
    const now = Date.now();
    const lastReply = Number(aiLastChatReplyMs[ai.id] || 0);
    if (now - lastReply < Number(cadence.chatReplyMinMs || 3500)) return false;

    const msgs = await fetchRecentTeamChatDocs(game.id, ai.team, 14, { cacheMs: 850 });
    if (!msgs || !msgs.length) return false;

    const newest = Math.max(...msgs.map(m => Number(m.createdAtMs || 0)));
    const lastSeen = Number(aiLastChatSeenMs[ai.id] || 0);
    // On first run, only consider a short recency window so we ignore stale chat backlog.
    const lookbackMs = Number(cadence.firstSeenChatLookbackMs || 9000);
    const baseline = lastSeen > 0 ? lastSeen : Math.max(0, newest - lookbackMs);

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
    const quickVision = buildAIVision(game, ai);
    const socialPhase = deriveSocialChatPhase(game, quickVision, 'reply', msgs, `${senderName}: ${text}`);
    if (directHit || question) bumpEmotion(ai, 1, 4);
    else if (greeting) bumpEmotion(ai, 2, 2);
    applyEmotionDriftFromState(ai, game, quickVision, { eventKind: 'team_chat' });

    let shouldReply = false;
    if (directHit || question || greeting) shouldReply = true;
    else {
      const baseChance = senderIsAI
        ? Number(cadence.chatReplyChanceVsAI || 0.55)
        : Number(cadence.chatReplyChanceVsHuman || 0.72);
      const phaseBoost = socialPhase.key === 'debate' ? 0.08 : (socialPhase.key === 'reasoning' ? -0.06 : (socialPhase.key === 'greeting' ? 0.04 : 0));
      const recencyPenalty = Math.min(0.22, Math.max(0, fresh.length - 1) * 0.05);
      const lengthBoost = Math.min(0.10, (text.length / 500));
      const chance = _clamp(baseChance + phaseBoost - recencyPenalty + lengthBoost, 0.08, 0.95);
      shouldReply = Math.random() < chance;
    }

    if (!shouldReply) return false;

    aiThinkingState[ai.id] = true;
    locked = true;
    const thinkFloor = Number(cadence.chatThinkMinMs || 120);
    const thinkCeil = Number(cadence.chatThinkMaxMs || 650);
    const contextual = Math.min(620, Math.round((text.length * 3.6) + (question ? 170 : 0) + (directHit ? 130 : 0)));
    await sleep(_randMs(thinkFloor, thinkCeil) + Math.round(contextual * (0.25 + Math.random() * 0.30)));

    let promptDocs = msgs;
    try {
      const latest = await fetchRecentTeamChatDocs(game.id, ai.team, 14, { cacheMs: 140 });
      if (latest && latest.length) promptDocs = latest;
    } catch (_) {}

    const forceResponse = !!(directHit || question || greeting);
    let reply = await generateAIChatMessage(ai, game, 'reply', {
      chatDocs: promptDocs,
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

function buildConsideringReactionMessage(ai, consideringRows = [], selfOwner = '') {
  try {
    const core = ensureAICore(ai);
    const emo = describeEmotion(core);
    const rows = (Array.isArray(consideringRows) ? consideringRows : []).filter(Boolean);
    if (!rows.length) return '';

    const row = rows[0];
    if (!row || !row.word) return '';
    const others = (Array.isArray(row.byOwner) ? row.byOwner : []).filter(x => String(x.owner || '') !== String(selfOwner || ''));
    if (!others.length) return '';
    const initials = others.map(x => String(x.initials || '?').slice(0, 3)).join(', ');
    const names = others
      .map(x => _shortPersonName(x?.name || ''))
      .filter(Boolean)
      .filter((n, idx, arr) => arr.findIndex(v => String(v).toLowerCase() === String(n).toLowerCase()) === idx);
    const addressed = names.length ? names[Math.floor(Math.random() * names.length)] : '';
    const spicy = (emo.mood === 'angry' || emo.mood === 'annoyed') && emo.intensity >= 55;

    if (others.length >= 3) {
      return _pick([
        addressed ? `${addressed}, i see the pile on ${row.word} — let's sanity-check the downside first` : '',
        spicy ? `${row.word} has everyone hovering on it (${initials}) and i'm still not sold` : `${row.word} has a crowd of initials (${initials}) — feels like the team's leaning there`,
        `${row.word} got a bunch of people considering it (${initials}), worth pressure-checking risk before lock-in`,
      ].filter(Boolean));
    }
    return _pick([
      addressed ? `${addressed}, i can see why you marked ${row.word}, but i still want one cleaner link` : '',
      spicy ? `seeing ${initials} on ${row.word} — wait, are we forcing this?` : `noted ${initials} on ${row.word}, i can see why it's in play`,
      `${row.word} has live initials (${initials}); i'm tracking it too`,
    ].filter(Boolean));
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
    // React even when it's not our turn (banter / "why are you tagging that??").
    if (aiThinkingState[ai.id]) return false;

    const core = ensureAICore(ai);
    if (!core) return false;

    const consideringRows = extractTeamConsideringForVision(game, ai.team);
    const selfOwner = _markerOwnerId(ai.id);
    const otherConsideringRows = consideringRows.filter(r => (r.byOwner || []).some(x => String(x.owner || '') !== selfOwner));
    const consideringSig = otherConsideringRows
      .map(r => `${r.index}:${(Array.isArray(r.byOwner) ? r.byOwner : []).map(x => String(x.initials || '?')).join(',')}`)
      .join('|');
    if (!consideringSig) return false;
    if (core.lastMarkerReactionSig === consideringSig) return false;

    const now = Date.now();
    const lastAt = Number(core.lastMarkerReactionAt || 0);
    const cadence = _effectiveCadenceForGame(ai, game);
    if (now - lastAt < Number(cadence.markerReactionMinMs || 4500)) return false;

    const msg = buildConsideringReactionMessage(ai, otherConsideringRows, selfOwner);
    core.lastMarkerReactionSig = consideringSig;
    if (!msg) return false;

    aiThinkingState[ai.id] = true;
    locked = true;
    await humanDelay(80, 220);
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
    const core = ensureAICore(ai);
    if (!core) return false;
    const cadence = _effectiveCadenceForGame(ai, game);
    if (now - last < Number(cadence.offTurnScoutMinMs || 12000)) return false;

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
      { ai, brainRole: AI_BRAIN_ROLES.scout, temperature: Math.min(1.0, core.temperature * 0.9), max_tokens: 300, response_format: { type: 'json_object' } }
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
    if (chat && (Math.random() < Number(cadence.offTurnChatChance || 0.72))) {
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
    const gid = String(gameId || '').trim();
    if (!gid) return null;

    // Practice mode lives entirely in local state; avoid Firestore round-trips.
    try {
      if (typeof window.isLocalPracticeGameId === 'function' && window.isLocalPracticeGameId(gid) && typeof getLocalPracticeGame === 'function') {
        const local = getLocalPracticeGame(gid);
        if (local && typeof local === 'object') return { id: gid, ...local };
        return null;
      }
    } catch (_) {}

    const snap = await db.collection('games').doc(gid).get();
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
  aiGameLoopTickInFlight = false;
  primeNebiusModelCatalog();

  aiGameLoopInterval = setInterval(async () => {
    if (aiGameLoopTickInFlight) return;
    aiGameLoopTickInFlight = true;
    try {
      // Get fresh game state
      const gameId = currentGame?.id;
      if (!gameId) return;

      const game = await getGameSnapshot(gameId);
      if (!game) return;

      // Keep AI list synced from the game doc so every client can host them.
      syncAIPlayersFromGame(game);

      if (!aiPlayers.length) return;

      primeNebiusModelCatalog();

      // Only one client should drive AI actions to avoid duplicate moves.
      const amController = await maybeHeartbeatAIController(gameId, game);
      if (!amController) return;
      if (game.winner) {
        // Stop autonomous actions once the game is decided.
        stopAIGameLoop();
        return;
      }

      // Conversational listening: scan only a rotating subset each tick.
      const chatCandidates = (aiPlayers || [])
        .filter(a => a && a.mode === 'autonomous' && String(a.seatRole || '') === 'operative')
        .sort((a, b) => Number(aiLastChatReplyMs[a.id] || 0) - Number(aiLastChatReplyMs[b.id] || 0));
      if (chatCandidates.length) {
        const secsLeft = _remainingSecondsFromGameTimer(game);
        const isOperativePhase = String(game.currentPhase || '') === 'operatives';
        const guessPressure = Number.isFinite(+game?.guessesRemaining) ? +game.guessesRemaining : 0;
        let checksThisTick = 1;
        if (isOperativePhase) {
          if (Number.isFinite(secsLeft) && secsLeft <= 14) checksThisTick = 1;
          else if (guessPressure > 1) checksThisTick = Math.min(3, chatCandidates.length);
          else checksThisTick = Math.min(2, chatCandidates.length);
        } else {
          checksThisTick = Math.min(1, chatCandidates.length);
        }
        const start = aiChatScanCursor % chatCandidates.length;
        const ordered = [];
        for (let i = 0; i < chatCandidates.length; i += 1) {
          ordered.push(chatCandidates[(start + i) % chatCandidates.length]);
        }
        aiChatScanCursor = (start + checksThisTick) % chatCandidates.length;
        for (const candidate of ordered.slice(0, checksThisTick)) {
          const replied = await maybeAIRespondToTeamChat(candidate, game);
          if (replied) break;
        }
      }

      // Time-pressure chatter when the operative clock gets tight.
      try { await maybeAIReactToTimePressure(game); } catch (_) {}

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
      if (game.currentPhase === 'operatives' && game.currentClue && Math.random() < 0.58) {
        const waitingOps = (aiPlayers || []).filter(a =>
          a &&
          a.mode === 'autonomous' &&
          a.seatRole === 'operative' &&
          String(a.team || '') !== String(currentTeam || '')
        ).sort((a, b) => Number(aiLastOffTurnScoutMs[a.id] || 0) - Number(aiLastOffTurnScoutMs[b.id] || 0));
        if (waitingOps.length) {
          const scout = waitingOps[0];
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
        // Considering-chip chatter: react when teammate initials consensus/conflicts shift.
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
      }
    } finally {
      aiGameLoopTickInFlight = false;
    }
  }, 2300);
}

function stopAIGameLoop() {
  if (aiGameLoopInterval) {
    clearInterval(aiGameLoopInterval);
    aiGameLoopInterval = null;
  }
  aiGameLoopRunning = false;
  aiGameLoopTickInFlight = false;
  aiChatScanCursor = 0;
  aiTeamChatQueryCache.clear();
  aiSeenActionReactionEvents.clear();
  aiLastActionReactionMs = {};
  for (const k of Object.keys(aiLastTimePressureReactionByTeam)) delete aiLastTimePressureReactionByTeam[k];
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
  aiLastChatSeenMs = {};
  aiLastChatReplyMs = {};
  aiLastActionReactionMs = {};
  for (const k of Object.keys(aiLastTimePressureReactionByTeam)) delete aiLastTimePressureReactionByTeam[k];
  aiSeenActionReactionEvents.clear();
  aiChatScanCursor = 0;
  aiTeamChatQueryCache.clear();
  aiGlobalVisionSigByGame.clear();
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
window.aiSpymasterPropose = aiSpymasterPropose;
window.aiSpymasterFollowup = aiSpymasterFollowup;
window.chooseSpymasterClue = chooseSpymasterClue;
window.aiSpymasterCouncilSummary = aiSpymasterCouncilSummary;
window.aiOperativePropose = aiOperativePropose;
window.aiOperativeFollowup = aiOperativeFollowup;
window.chooseOperativeAction = chooseOperativeAction;
window.aiOperativeCouncilSummary = aiOperativeCouncilSummary;
