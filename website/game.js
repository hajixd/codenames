/*
  Codenames Game Logic
  - Challenge system for team matching
  - Real-time game state via Firebase
  - Role selection (Spymaster/Operative)
  - Board generation with key card
  - Clue giving and guessing mechanics
  - Win/lose conditions
*/

// Game constants
const BOARD_SIZE = 25;
const FIRST_TEAM_CARDS = 9;
const SECOND_TEAM_CARDS = 8;
const NEUTRAL_CARDS = 7;
const ASSASSIN_CARDS = 1;

// Game state
let wordsBank = [];
let wordsDecks = {}; // loaded from words.json
const DECK_CATALOG = [
  { id: 'standard', label: 'Standard', emoji: '🌍', tone: 'slate' },
  { id: 'family', label: 'Family', emoji: '🧸', tone: 'teal' },
  { id: 'pop', label: 'Pop', emoji: '🎬', tone: 'purple' },
  { id: 'sports', label: 'Sports', emoji: '🏟️', tone: 'blue' },
  { id: 'tech', label: 'Tech', emoji: '💻', tone: 'slate' },
];

function normalizeDeckId(deckId) {
  const id = String(deckId || 'standard');
  return (wordsDecks && wordsDecks[id] && Array.isArray(wordsDecks[id]) && wordsDecks[id].length >= 25) ? id : 'standard';
}

function getDeckMeta(deckId) {
  const id = normalizeDeckId(deckId);
  return DECK_CATALOG.find(d => d.id === id) || DECK_CATALOG[0];
}

function getWordsForDeck(deckId) {
  const id = normalizeDeckId(deckId);
  const bank = (wordsDecks && wordsDecks[id]) || wordsBank;
  if (Array.isArray(bank) && bank.length >= 25) return bank;
  return wordsBank;
}

let currentGame = null;
let _prevClue = null; // Track previous clue for clue animation
let _prevBoardSignature = null; // Track board identity so we can reset per-game markers/tags
const CARD_CONFIRM_ANIM_MS = 1100;
const LOCAL_REVEAL_ANIM_SUPPRESS_MS = 4500;
const _suppressRevealAnimByIndexUntil = new Map();
const _CONFIRM_BACK_TYPES = ['red', 'blue', 'neutral', 'assassin'];
let _pendingRevealRenderTimer = null;
let _deferredSnapshotRender = null;
let _localConfirmAnimUntil = 0;
let _cardAnimOverlayTimer = null;
// Expose current game phase for presence (app.js)
window.getCurrentGamePhase = () => (currentGame && currentGame.currentPhase) ? currentGame.currentPhase : null;

function normalizeConfirmBackType(rawType) {
  const t = String(rawType || '').toLowerCase();
  return _CONFIRM_BACK_TYPES.includes(t) ? t : 'neutral';
}

function getConfirmBackLabel(confirmBackType) {
  const type = normalizeConfirmBackType(confirmBackType);
  if (type === 'red') return 'RED';
  if (type === 'blue') return 'BLUE';
  if (type === 'neutral') return 'NEUTRAL';
  if (type === 'assassin') return 'ASSASSIN';
  return 'NEUTRAL';
}

function pulseCardAnimationOverlay(holdMs = CARD_CONFIRM_ANIM_MS + 260) {
  const host = document.getElementById('game-board-container');
  if (!host) return;
  host.classList.add('card-anim-overlay');
  if (_cardAnimOverlayTimer) clearTimeout(_cardAnimOverlayTimer);
  _cardAnimOverlayTimer = window.setTimeout(() => {
    _cardAnimOverlayTimer = null;
    host.classList.remove('card-anim-overlay');
  }, Math.max(260, Number(holdMs) || 0));
}

function clearConfirmAnimationClasses(cardEl) {
  if (!cardEl) return;
  cardEl.classList.remove('confirming-guess', 'confirm-animate', 'confirm-hold');
  cardEl.classList.remove(..._CONFIRM_BACK_TYPES.map((t) => `confirm-back-${t}`));
  cardEl.removeAttribute('data-confirm-back-label');
}

function applyConfirmAnimationClasses(cardEl, confirmBackType, opts = {}) {
  if (!cardEl) return;
  const replay = !!opts.replay;
  const type = normalizeConfirmBackType(confirmBackType);
  if (replay) {
    // For snapshot replays, briefly restore the unrevealed presentation first.
    cardEl.classList.remove('revealed', ..._CONFIRM_BACK_TYPES.map((t) => `card-${t}`));
  }
  clearConfirmAnimationClasses(cardEl);
  cardEl.classList.add('confirming-guess', 'confirm-animate', `confirm-back-${type}`);
  cardEl.setAttribute('data-confirm-back-label', getConfirmBackLabel(type));
  pulseCardAnimationOverlay();
}

function flushDeferredSnapshotRender() {
  const fn = _deferredSnapshotRender;
  _deferredSnapshotRender = null;
  if (typeof fn === 'function') fn();
}

function scheduleSnapshotRender(fn, delayMs = 0, opts = {}) {
  _deferredSnapshotRender = fn;
  const delay = Number.isFinite(delayMs) ? Math.max(0, Math.floor(delayMs)) : 0;
  const extend = !!opts.extend;

  if (delay <= 0) {
    // Keep latest callback queued if an animation hold is already active.
    if (_pendingRevealRenderTimer) return;
    flushDeferredSnapshotRender();
    return;
  }

  if (_pendingRevealRenderTimer) {
    if (!extend) return;
    clearTimeout(_pendingRevealRenderTimer);
    _pendingRevealRenderTimer = null;
  }

  _pendingRevealRenderTimer = window.setTimeout(() => {
    _pendingRevealRenderTimer = null;
    flushDeferredSnapshotRender();
  }, delay);
}

function markRevealAnimationSuppressed(cardIndex) {
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;
  _suppressRevealAnimByIndexUntil.set(idx, Date.now() + LOCAL_REVEAL_ANIM_SUPPRESS_MS);
}

function consumeRevealAnimationSuppressed(cardIndex) {
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return false;
  const until = Number(_suppressRevealAnimByIndexUntil.get(idx) || 0);
  if (!until) return false;
  _suppressRevealAnimByIndexUntil.delete(idx);
  return until > Date.now();
}

function clearRevealAnimationSuppressions() {
  _suppressRevealAnimByIndexUntil.clear();
}

function collectNewlyRevealedCardIndices(prevCards, nextCards) {
  if (!Array.isArray(prevCards) || !Array.isArray(nextCards)) return [];
  if (prevCards.length !== nextCards.length) return [];
  const out = [];
  for (let i = 0; i < nextCards.length; i++) {
    const wasRevealed = !!prevCards[i]?.revealed;
    const isRevealed = !!nextCards[i]?.revealed;
    if (!wasRevealed && isRevealed) out.push(i);
  }
  return out;
}

function animateNewlyRevealedCards(cardIndices = []) {
  // OG/Cozy use the local confirm replay path before render. This function is
  // kept for non-OG styles that still use reveal keyframe classes.
  if (isOgLikeStyleActive()) return;
  if (!Array.isArray(cardIndices) || !cardIndices.length) return;
  const seen = new Set();
  cardIndices.forEach((rawIdx) => {
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0 || seen.has(idx)) return;
    seen.add(idx);

    const cardEl = document.querySelector(`.game-card[data-index="${idx}"]`);
    if (!cardEl || !cardEl.classList.contains('revealed')) return;

    const cardTypeRaw = String(currentGame?.cards?.[idx]?.type || '').toLowerCase();
    const revealType = normalizeConfirmBackType(cardTypeRaw);
    if (revealType) cardEl.classList.add(`card-${revealType}`);
    // Restart animation classes in case snapshots arrive quickly.
    cardEl.classList.remove('guess-animate', 'revealing', 'flip-glow');
    void cardEl.offsetWidth;
    cardEl.classList.add('guess-animate');
    cardEl.classList.add('revealing');
    pulseCardAnimationOverlay();

    window.setTimeout(() => {
      if (!cardEl.isConnected) return;
      cardEl.classList.remove('guess-animate', 'revealing', 'flip-glow');
    }, CARD_CONFIRM_ANIM_MS);
  });
}

function replayConfirmAnimationOnCurrentBoard(cardIndices = [], cards = []) {
  if (!isOgLikeStyleActive()) return false;
  if (!Array.isArray(cardIndices) || !cardIndices.length) return false;
  let animatedAny = false;
  const seen = new Set();
  cardIndices.forEach((rawIdx) => {
    const idx = Number(rawIdx);
    if (!Number.isInteger(idx) || idx < 0 || seen.has(idx)) return;
    seen.add(idx);
    const cardEl = document.querySelector(`.game-card[data-index="${idx}"]`);
    if (!cardEl) return;
    const cardTypeRaw = String(cards?.[idx]?.type || '').toLowerCase();
    const confirmBackType = normalizeConfirmBackType(cardTypeRaw);
    const replay = cardEl.classList.contains('revealed');
    applyConfirmAnimationClasses(cardEl, confirmBackType, { replay });
    animatedAny = true;
  });
  return animatedAny;
}

// Best-effort local resume: remember the last active game so a page refresh can jump straight back in.
// NOTE: This is purely device-local (localStorage) and does not write anything to Firestore.
window.restoreLastGameFromStorage = function restoreLastGameFromStorage() {
  try {
    const gameId = (typeof safeLSGet === 'function' ? safeLSGet(LS_ACTIVE_GAME_ID) : (localStorage.getItem(LS_ACTIVE_GAME_ID) || ''));
    const spectator = (typeof safeLSGet === 'function' ? safeLSGet(LS_ACTIVE_GAME_SPECTATOR) : (localStorage.getItem(LS_ACTIVE_GAME_SPECTATOR) || ''));
    const gid = String(gameId || '').trim();
    if (!gid) return;
    const isSpec = String(spectator || '') === '1';
    startGameListener(gid, { spectator: isSpec });
  } catch (e) {
    console.warn('restoreLastGameFromStorage failed (best-effort)', e);
  }
};

/* =========================
   Player Stats (Wins/Losses)
   - Stored on players/<userId>: gamesPlayed, wins, losses
   - Applied once per game via games/<gameId>.statsApplied
========================= */
async function applyGameResultToPlayerStatsIfNeeded(game) {
  try {
    if (!game || !game.id) return;
    if (game.statsApplied) return;
    if (game.winner !== 'red' && game.winner !== 'blue') return;
    // Avoid counting quickplay lobby placeholder etc.
    const gameRef = db.collection('games').doc(game.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists) return;
      const g = { id: snap.id, ...snap.data() };
      if (g.statsApplied) return;
      if (g.winner !== 'red' && g.winner !== 'blue') return;

      const redPlayers = Array.isArray(g.redPlayers) ? g.redPlayers : [];
      const bluePlayers = Array.isArray(g.bluePlayers) ? g.bluePlayers : [];

      const redIds = new Set(redPlayers.filter(p => !p.isAI).map(p => String(p?.odId || '').trim()).filter(Boolean));
      const blueIds = new Set(bluePlayers.filter(p => !p.isAI).map(p => String(p?.odId || '').trim()).filter(Boolean));
      const all = new Set([...redIds, ...blueIds]);
      if (all.size === 0) {
        tx.update(gameRef, { statsApplied: true, statsAppliedAt: firebase.firestore.FieldValue.serverTimestamp() });
        return;
      }

      for (const uid of all) {
        const isWin = (g.winner === 'red' && redIds.has(uid)) || (g.winner === 'blue' && blueIds.has(uid));
        const isLoss = !isWin;
        const ref = db.collection('players').doc(uid);
        tx.set(ref, {
          gamesPlayed: firebase.firestore.FieldValue.increment(1),
          wins: firebase.firestore.FieldValue.increment(isWin ? 1 : 0),
          losses: firebase.firestore.FieldValue.increment(isLoss ? 1 : 0),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      tx.update(gameRef, { statsApplied: true, statsAppliedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  } catch (e) {
    console.warn('Failed to apply game stats (best-effort):', e);
  }
}

let gameUnsub = null;
let currentListenerEphemeral = false;
let challengesUnsub = null;
let quickGamesUnsub = null;
let spectatorMode = false;
let spectatingGameId = null;
let selectedQuickTeam = null; // 'red' | 'spectator' | 'blue'
let selectedQuickSeatRole = 'operative'; // 'operative' | 'spymaster' (Quick Play lobby)
let latestQuickGame = null; // last observed Quick Play game doc for UI decisions
let currentPlayMode = 'select'; // 'select', 'quick', 'tournament'

// Quick Play is a single shared lobby/game.
const QUICKPLAY_DOC_ID = 'quickplay';

// Expose the Quick Play doc id so other modules can reference it without
// duplicating constants.
window.QUICKPLAY_DOC_ID = QUICKPLAY_DOC_ID;

// Quick Play readiness gate
// Used by app.js to keep the loading screen up until the first usable state
// is rendered (e.g., your name appears in the lobby or the game board renders).
function _makeDeferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve, resolved: false };
}
let _quickPlayReady = _makeDeferred();
function _signalQuickPlayReady() {
  if (_quickPlayReady.resolved) return;
  _quickPlayReady.resolved = true;
  try { _quickPlayReady.resolve(true); } catch (_) {}
}
window.resetQuickPlayReady = function resetQuickPlayReady() {
  _quickPlayReady = _makeDeferred();
};
window.waitForQuickPlayReady = function waitForQuickPlayReady(opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(0, opts.timeoutMs) : 15000;
  // Resolve on timeout as a safety so the UI never gets stuck.
  const t = new Promise((r) => setTimeout(() => r(false), timeoutMs));
  return Promise.race([_quickPlayReady.promise, t]);
};
let quickLobbyUnsub = null;
let quickLobbyGame = null;
let quickAutoJoinedSpectator = false;
let quickLobbyListenerStarting = null;
let quickLobbyListenerWanted = false;
let quickPlayEnsurePromise = null;

// Practice is fully local-only (no Firestore reads/writes).
const LOCAL_PRACTICE_ID_PREFIX = 'practice_local_';
const LS_LOCAL_PRACTICE_GAMES = 'ct_localPracticeGames_v1';
const localPracticeGames = new Map();
let localPracticeAiTimer = null;
let localPracticeAiBusy = false;
let localPracticeAiGameId = null;
const LOCAL_PRACTICE_CHAT_LIMIT = 80;

function cloneLocalValue(value) {
  if (typeof structuredClone === 'function') {
    try { return structuredClone(value); } catch (_) {}
  }
  try { return JSON.parse(JSON.stringify(value)); } catch (_) {}
  return value;
}

function isLocalPracticeGameId(gameId) {
  return String(gameId || '').trim().startsWith(LOCAL_PRACTICE_ID_PREFIX);
}

function isCurrentLocalPracticeGame() {
  return !!(currentGame?.type === 'practice' && isLocalPracticeGameId(currentGame?.id));
}

function createLocalPracticeId() {
  return `${LOCAL_PRACTICE_ID_PREFIX}${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function getLocalPracticeGame(gameId) {
  const key = String(gameId || '').trim();
  if (!key) return null;
  const raw = localPracticeGames.get(key);
  return raw ? cloneLocalValue(raw) : null;
}

function loadLocalPracticeGamesFromStorage() {
  try {
    const raw = localStorage.getItem(LS_LOCAL_PRACTICE_GAMES);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    const entries = Object.entries(parsed);
    for (const [key, value] of entries) {
      if (!isLocalPracticeGameId(key)) continue;
      if (!value || typeof value !== 'object') continue;
      localPracticeGames.set(key, cloneLocalValue(value));
    }
  } catch (_) {}
}

function persistLocalPracticeGamesToStorage() {
  try {
    const payload = {};
    for (const [key, value] of localPracticeGames.entries()) {
      if (!isLocalPracticeGameId(key) || !value) continue;
      payload[key] = cloneLocalValue(value);
    }
    localStorage.setItem(LS_LOCAL_PRACTICE_GAMES, JSON.stringify(payload));
  } catch (_) {}
}

loadLocalPracticeGamesFromStorage();

function setLocalPracticeGame(gameId, gameData, opts = {}) {
  const key = String(gameId || '').trim();
  if (!key || !isLocalPracticeGameId(key) || !gameData) return null;

  const prevLiveGame = (currentGame?.id === key) ? cloneLocalValue(currentGame) : null;
  const next = cloneLocalValue(gameData) || {};
  next.id = key;
  next.updatedAtMs = Date.now();
  localPracticeGames.set(key, next);
  persistLocalPracticeGamesToStorage();

  if (!opts.skipRender && currentGame?.id === key) {
    const prevCards = Array.isArray(prevLiveGame?.cards) ? prevLiveGame.cards : null;

    let boardChanged = false;
    try {
      const sig = (Array.isArray(next?.cards) && next.cards.length)
        ? next.cards.map(c => `${String(c?.word || '')}::${String(c?.type || '')}`).join('|')
        : null;
      if (sig && _prevBoardSignature && sig !== _prevBoardSignature) {
        boardChanged = true;
        cardTags = {};
        pendingCardSelection = null;
        _pendingSelectionContextKey = null;
        revealedPeekCardIndex = null;
        void syncTeamConsidering(null);
        renderCardTags();
        saveTagsToLocal();
        setActiveTagMode(null);
        clearRevealAnimationSuppressions();
      }
      _prevBoardSignature = sig || _prevBoardSignature;
    } catch (_) {}

    const newClueWord = next.currentClue?.word || null;
    const newClueNumber = next.currentClue?.number ?? null;
    const clueChanged = !!(newClueWord && newClueWord !== _prevClue);
    let newlyRevealedIndices = [];
    if (!opts.skipAnimation && prevCards && !boardChanged) {
      newlyRevealedIndices = collectNewlyRevealedCardIndices(prevCards, next.cards)
        .filter((idx) => !consumeRevealAnimationSuppressed(idx));
    } else {
      clearRevealAnimationSuppressions();
    }

    const replayedPreRenderConfirm = (!opts.skipAnimation)
      ? replayConfirmAnimationOnCurrentBoard(newlyRevealedIndices, next.cards)
      : false;

    const finishLocalRender = () => {
      currentGame = cloneLocalValue(next);
      if (currentGame?.type === 'practice') startPracticeInactivityWatcher();
      else stopPracticeInactivityWatcher();
      try { renderGame(); } catch (_) {}
      if (!opts.skipAnimation && newlyRevealedIndices.length && !replayedPreRenderConfirm) {
        animateNewlyRevealedCards(newlyRevealedIndices);
      }
      if (clueChanged && newClueWord) {
        showClueAnimation(newClueWord, newClueNumber, currentGame.currentTeam);
      }
      _prevClue = newClueWord;
      try { window.bumpPresence?.(); } catch (_) {}
    };

    if (opts.skipAnimation) {
      finishLocalRender();
    } else if (replayedPreRenderConfirm) {
      scheduleSnapshotRender(finishLocalRender, CARD_CONFIRM_ANIM_MS, { extend: true });
    } else {
      const holdForLocalConfirmMs = Math.max(0, _localConfirmAnimUntil - Date.now());
      if (holdForLocalConfirmMs > 0) {
        scheduleSnapshotRender(finishLocalRender, holdForLocalConfirmMs, { extend: true });
      } else {
        scheduleSnapshotRender(finishLocalRender, 0);
      }
    }
  }

  return cloneLocalValue(next);
}

function mutateLocalPracticeGame(gameId, mutator, opts = {}) {
  const base = getLocalPracticeGame(gameId);
  if (!base) return null;
  if (typeof mutator === 'function') {
    try { mutator(base); } catch (_) {}
  }
  return setLocalPracticeGame(gameId, base, opts);
}

function deleteLocalPracticeGame(gameId) {
  const key = String(gameId || '').trim();
  if (!key) return;
  localPracticeGames.delete(key);
  persistLocalPracticeGamesToStorage();
  try {
    const active = String(localStorage.getItem(LS_ACTIVE_GAME_ID) || '').trim();
    if (active && active === key) {
      localStorage.removeItem(LS_ACTIVE_GAME_ID);
      localStorage.removeItem(LS_ACTIVE_GAME_SPECTATOR);
    }
  } catch (_) {}
}

function appendGuessToClueHistoryLocal(game, team, clueWord, clueNumber, guess) {
  if (!game || !team || !clueWord) return;
  const history = Array.isArray(game.clueHistory) ? [...game.clueHistory] : [];
  let idx = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const c = history[i];
    if (!c) continue;
    if (
      String(c.team) === String(team) &&
      String(c.word) === String(clueWord) &&
      Number(c.number) === Number(clueNumber)
    ) {
      idx = i;
      break;
    }
  }
  if (idx < 0) {
    game.clueHistory = history;
    return;
  }
  const entry = { ...history[idx] };
  const results = Array.isArray(entry.results) ? [...entry.results] : [];
  const guessWord = String(guess?.word || '').toUpperCase();
  if (guessWord && results.some(r => String(r?.word || '').toUpperCase() === guessWord)) {
    game.clueHistory = history;
    return;
  }
  results.push(guess);
  entry.results = results;
  history[idx] = entry;
  game.clueHistory = history;
}

function applyLocalPracticeGuessState(game, idx, actorName) {
  if (!game || !Array.isArray(game.cards)) return null;
  if (!Number.isInteger(idx) || idx < 0 || idx >= game.cards.length) return null;
  const card = game.cards[idx];
  if (!card || card.revealed) return null;

  const updatedCards = [...game.cards];
  updatedCards[idx] = { ...card, revealed: true };

  const team = game.currentTeam === 'blue' ? 'blue' : 'red';
  const teamName = team === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  const guessByName = String(actorName || 'Someone');
  const clueWordAtGuess = game.currentClue?.word || null;
  const clueNumberAtGuess = (game.currentClue && typeof game.currentClue.number !== 'undefined') ? game.currentClue.number : null;

  game.cards = updatedCards;
  game.updatedAtMs = Date.now();
  game.lastMoveAtMs = Date.now();

  const redCardsLeftNow = getCardsLeft(game, 'red');
  const blueCardsLeftNow = getCardsLeft(game, 'blue');

  let logEntry = `${guessByName} (${teamName}) guessed "${card.word}" - `;
  let winner = null;
  let endTurn = false;

  if (card.type === 'assassin') {
    winner = team === 'red' ? 'blue' : 'red';
    logEntry += 'ASSASSIN! Game over.';
  } else if (card.type === team) {
    logEntry += 'Correct!';
    if (team === 'red') {
      game.redCardsLeft = Math.max(0, redCardsLeftNow - 1);
      if (game.redCardsLeft === 0) winner = 'red';
    } else {
      game.blueCardsLeft = Math.max(0, blueCardsLeftNow - 1);
      if (game.blueCardsLeft === 0) winner = 'blue';
    }
  } else if (card.type === 'neutral') {
    logEntry += 'Neutral. Turn ends.';
    endTurn = true;
  } else {
    const ownerTeamName = card.type === 'red'
      ? (game.redTeamName || 'Red Team')
      : (game.blueTeamName || 'Blue Team');
    logEntry += `Wrong! (${ownerTeamName}'s card)`;
    if (card.type === 'red') {
      game.redCardsLeft = Math.max(0, redCardsLeftNow - 1);
      if (game.redCardsLeft === 0) winner = 'red';
    } else {
      game.blueCardsLeft = Math.max(0, blueCardsLeftNow - 1);
      if (game.blueCardsLeft === 0) winner = 'blue';
    }
    endTurn = true;
  }

  const currentGuesses = Number.isFinite(+game.guessesRemaining) ? +game.guessesRemaining : 0;
  const nextGuesses = Math.max(0, currentGuesses - 1);
  if (game.currentClue) {
    game.guessesRemaining = nextGuesses;
    if (!winner && !endTurn && card.type === team && nextGuesses <= 0) {
      endTurn = true;
    }
    if (winner || endTurn) game.guessesRemaining = 0;
  }

  game.log = Array.isArray(game.log) ? [...game.log] : [];
  game.log.push(logEntry);

  const guessResult = {
    word: card.word,
    result: (card.type === 'assassin')
      ? 'assassin'
      : (card.type === team ? 'correct' : (card.type === 'neutral' ? 'neutral' : 'wrong')),
    type: card.type,
    by: guessByName,
    timestamp: new Date().toISOString()
  };

  if (winner) {
    game.winner = winner;
    game.currentPhase = 'ended';
    game.pendingClue = null;
    game.liveClueDraft = null;
    const winnerName = truncateTeamNameGame(winner === 'red' ? game.redTeamName : game.blueTeamName);
    game.log.push(`${winnerName} wins!`);
  } else if (endTurn) {
    game.currentTeam = team === 'red' ? 'blue' : 'red';
    game.currentPhase = 'spymaster';
    game.currentClue = null;
    game.pendingClue = null;
    game.liveClueDraft = null;
    game.guessesRemaining = 0;
  }

  if (clueWordAtGuess && clueNumberAtGuess !== null && clueNumberAtGuess !== undefined) {
    appendGuessToClueHistoryLocal(game, team, clueWordAtGuess, clueNumberAtGuess, guessResult);
  }
  return { winner, endTurn, guessResult };
}

function pickLocalPracticeClueWord(game) {
  const boardWords = new Set((game?.cards || []).map(c => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
  const usedClues = new Set((game?.clueHistory || []).map(c => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
  const pool = ['NEXUS', 'VECTOR', 'SPARK', 'ORBIT', 'SHADOW', 'PULSE', 'ECHO', 'ANCHOR', 'BEACON', 'FOCUS', 'RHYTHM', 'SIGNAL', 'GLINT', 'AXIS'];
  _shuffleInPlace(pool);
  for (const word of pool) {
    if (!boardWords.has(word) && !usedClues.has(word)) return word;
  }
  for (const word of pool) {
    if (!boardWords.has(word)) return word;
  }
  return `CLUE${Math.floor(Math.random() * 90) + 10}`;
}

function clampLocalPracticeClueNumber(value, fallback = 1) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return Math.max(0, Math.min(9, parseInt(fallback, 10) || 1));
  return Math.max(0, Math.min(9, n));
}

function sanitizeLocalPracticeClueWord(raw, boardWordsSet) {
  let word = String(raw || '').trim().toUpperCase();
  if (!word) return '';
  if (word.includes(' ') || word.includes('-')) return '';
  if (!/^[A-Z0-9]+$/.test(word)) return '';
  if (word.length < 2 || word.length > 14) return '';
  if (boardWordsSet?.has(word)) return '';
  return word;
}

async function generateLocalPracticeAICluePlan(game, team, aiSpy = null) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  const boardWords = cards.map((c) => String(c?.word || '').trim().toUpperCase()).filter(Boolean);
  const boardWordSet = new Set(boardWords);
  const hidden = cards.filter((c) => c && !c.revealed);
  const ownWords = hidden
    .filter((c) => String(c.type || '') === team)
    .map((c) => String(c.word || '').trim().toUpperCase())
    .filter(Boolean);
  const oppTeam = team === 'red' ? 'blue' : 'red';
  const oppWords = hidden
    .filter((c) => String(c.type || '') === oppTeam)
    .map((c) => String(c.word || '').trim().toUpperCase())
    .filter(Boolean);
  const neutralWords = hidden
    .filter((c) => String(c.type || '') === 'neutral')
    .map((c) => String(c.word || '').trim().toUpperCase())
    .filter(Boolean);
  const assassinWords = hidden
    .filter((c) => String(c.type || '') === 'assassin')
    .map((c) => String(c.word || '').trim().toUpperCase())
    .filter(Boolean);

  const fallbackNumber = Math.max(1, Math.min(3, ownWords.length >= 5 ? 3 : (ownWords.length >= 3 ? 2 : 1)));
  const fallbackWord = pickLocalPracticeClueWord(game);
  if (!ownWords.length) return { word: fallbackWord, number: fallbackNumber };

  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') return { word: fallbackWord, number: fallbackNumber };

  const teamLabel = team === 'red' ? 'RED' : 'BLUE';
  const systemPrompt = [
    `You are a Codenames spymaster for team ${teamLabel}.`,
    `Choose ONE safe clue for the current board.`,
    `Return JSON only: {"clue":"ONEWORD","number":N}`,
    `Rules:`,
    `- clue must be one word (A-Z or digits only, no spaces, no hyphens)`,
    `- clue must NOT be any board word`,
    `- prefer clues that connect 2-4 own words when safe; otherwise lower number`,
    `- avoid clues that pull toward opponent, neutral, or assassin words`,
    `- number must be an integer 0-9`,
  ].join('\n');

  const userPrompt = [
    `TEAM WORDS LEFT (${ownWords.length}): ${ownWords.join(', ')}`,
    `OPPONENT WORDS LEFT (${oppWords.length}): ${oppWords.join(', ') || 'NONE'}`,
    `NEUTRAL WORDS LEFT (${neutralWords.length}): ${neutralWords.join(', ') || 'NONE'}`,
    `ASSASSIN WORDS LEFT (${assassinWords.length}): ${assassinWords.join(', ') || 'NONE'}`,
    `BOARD WORDS (cannot use as clue): ${boardWords.join(', ')}`,
  ].join('\n');

  try {
    const raw = await chatFn(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        temperature: Number.isFinite(+aiSpy?.aiTemperature)
          ? +aiSpy.aiTemperature
          : (Number.isFinite(+aiSpy?.temperature) ? +aiSpy.temperature : 0.72),
        max_tokens: 220,
        response_format: { type: 'json_object' },
      }
    );

    const parsed = safeJsonParse(raw);
    const clueWord = sanitizeLocalPracticeClueWord(parsed?.clue, boardWordSet);
    const clueNumber = clampLocalPracticeClueNumber(parsed?.number, fallbackNumber);
    if (clueWord) return { word: clueWord, number: clueNumber };
  } catch (err) {
    console.warn('Local practice AI clue generation failed, using fallback:', err);
  }
  return { word: fallbackWord, number: fallbackNumber };
}

function getLocalPracticeSeqField(team, role) {
  const t = team === 'blue' ? 'blue' : 'red';
  const r = role === 'spy' ? 'spy' : 'op';
  return `aiSeq_${t}_${r}`;
}

function pickLocalPracticeRotatingAI(game, team, role, aiList) {
  const list = Array.isArray(aiList) ? aiList.filter(Boolean) : [];
  if (!list.length) return null;
  const seqField = getLocalPracticeSeqField(team, role);
  const seq = Number.isFinite(+game?.[seqField]) ? +game[seqField] : 0;
  return list[seq % list.length] || list[0] || null;
}

function bumpLocalPracticeAISeq(game, team, role) {
  if (!game || !team) return;
  const seqField = getLocalPracticeSeqField(team, role);
  const cur = Number.isFinite(+game?.[seqField]) ? +game[seqField] : 0;
  game[seqField] = cur + 1;
}

function toLocalPracticeRuntimeAI(player, team) {
  if (!player?.isAI) return null;
  const seatRole = String(player.role || '').trim() === 'spymaster' ? 'spymaster' : 'operative';
  const id = String(player.aiId || player.odId || '').trim() || `practice_ai_${team}_${seatRole}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    id,
    odId: String(player.odId || id).trim(),
    name: String(player.name || 'AI').trim() || 'AI',
    team: team === 'blue' ? 'blue' : 'red',
    seatRole,
    mode: 'autonomous',
    isAI: true,
    temperature: Number.isFinite(+player.aiTemperature) ? +player.aiTemperature : undefined,
    personality: (player.aiPersonality && typeof player.aiPersonality === 'object') ? player.aiPersonality : undefined,
  };
}

function getLocalPracticeRuntimeAIs(game, team, seatRole) {
  const roster = team === 'blue' ? (game?.bluePlayers || []) : (game?.redPlayers || []);
  const targetRole = seatRole === 'spymaster' ? 'spymaster' : 'operative';
  return roster
    .map((p) => toLocalPracticeRuntimeAI(p, team))
    .filter((ai) => ai && ai.seatRole === targetRole);
}

function getLocalPracticeChatField(team) {
  return team === 'blue' ? 'blueChat' : 'redChat';
}

function getLocalPracticeTeamChatDocs(game, team, limit = 16) {
  const chatField = getLocalPracticeChatField(team);
  const msgs = Array.isArray(game?.[chatField]) ? game[chatField] : [];
  return msgs.slice(-Math.max(1, limit)).map((m) => ({
    senderId: String(m?.senderId || '').trim(),
    senderName: String(m?.senderName || '').trim(),
    text: String(m?.text || '').trim(),
    createdAtMs: Number(m?.createdAtMs || 0),
  })).filter((m) => m.text);
}

function sanitizeLocalPracticeChatText(raw, maxLen = 180) {
  const text = String(raw || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.slice(0, Math.max(1, Number(maxLen) || 180));
}

function appendLocalPracticeTeamChat(gameId, team, ai, rawText) {
  const aiRole = String(ai?.seatRole || ai?.role || '').trim().toLowerCase();
  if (aiRole === 'spymaster') return false;
  const text = sanitizeLocalPracticeChatText(rawText, 180);
  if (!text) return false;
  const senderNameBase = String(ai?.name || 'AI').trim() || 'AI';
  const senderId = String(ai?.odId || ai?.id || `ai_local_${senderNameBase}`).trim();
  const nowMs = Date.now();
  const chatField = getLocalPracticeChatField(team);
  mutateLocalPracticeGame(gameId, (draft) => {
    const list = Array.isArray(draft?.[chatField]) ? [...draft[chatField]] : [];
    list.push({
      id: `local_chat_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
      senderId,
      senderName: `AI ${senderNameBase}`,
      text,
      createdAtMs: nowMs,
    });
    draft[chatField] = list.length > LOCAL_PRACTICE_CHAT_LIMIT
      ? list.slice(-LOCAL_PRACTICE_CHAT_LIMIT)
      : list;
    draft.updatedAtMs = nowMs;
    draft.lastMoveAtMs = nowMs;
  }, { skipAnimation: true });
  return true;
}

function applyLocalPracticeSpymasterClueState(game, team, clueWord, clueNumber) {
  if (!game) return;
  const actingTeam = team === 'blue' ? 'blue' : 'red';
  const teamName = actingTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  game.currentClue = { word: clueWord, number: clueNumber };
  game.guessesRemaining = (clueNumber === 0 ? 0 : clueNumber + 1);
  game.currentPhase = 'operatives';
  game.timerEnd = buildPhaseTimerEndValue(game, 'operatives');
  game.log = Array.isArray(game.log) ? [...game.log] : [];
  game.log.push(`${teamName} Spymaster: "${clueWord}" for ${clueNumber}`);
  game.clueHistory = Array.isArray(game.clueHistory) ? [...game.clueHistory] : [];
  game.clueHistory.push({
    team: actingTeam,
    word: clueWord,
    number: clueNumber,
    targets: [],
    targetWords: [],
    results: [],
    timestamp: new Date().toISOString()
  });
  game.updatedAtMs = Date.now();
  game.lastMoveAtMs = Date.now();
}

function applyLocalPracticeOperativeEndTurnState(game, actorName) {
  if (!game) return;
  const actingTeam = game.currentTeam === 'blue' ? 'blue' : 'red';
  const teamName = actingTeam === 'red' ? (game.redTeamName || 'Red Team') : (game.blueTeamName || 'Blue Team');
  game.currentTeam = actingTeam === 'red' ? 'blue' : 'red';
  game.currentPhase = 'spymaster';
  game.currentClue = null;
  game.pendingClue = null;
  game.liveClueDraft = null;
  game.guessesRemaining = 0;
  game.timerEnd = buildPhaseTimerEndValue(game, 'spymaster');
  game.log = Array.isArray(game.log) ? [...game.log] : [];
  game.log.push(`${actorName} (${teamName}) ended their turn.`);
  game.updatedAtMs = Date.now();
  game.lastMoveAtMs = Date.now();
}

const LOCAL_PRACTICE_COUNCIL_PACE = {
  betweenSpeakersMs: 180,
  beforeDecisionMs: 260,
};

function localPracticePause(ms) {
  const delay = Math.max(0, Number(ms) || 0);
  if (!delay) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function submitLocalPracticeClueWithReview(gameId, team, clueWord, clueNumber, aiSpy = null) {
  const live = getLocalPracticeGame(gameId);
  if (!live || live.winner || live.currentPhase !== 'spymaster' || live.currentTeam !== team) return false;

  const byId = String(aiSpy?.odId || aiSpy?.id || aiSpy?.aiId || '').trim();
  const byName = String(aiSpy?.name || 'AI').trim() || 'AI';
  const seqField = getLocalPracticeSeqField(team, 'spy');
  const submitWithReview = window.submitClueForReviewFlow;

  if (typeof submitWithReview === 'function') {
    const result = await submitWithReview({
      game: live,
      word: clueWord,
      number: clueNumber,
      targets: [],
      targetWords: [],
      byId,
      byName,
      seqField,
    });
    if (result?.accepted && window.playSound) window.playSound('clueGiven');
    return !!(result?.accepted || result?.pending);
  }

  mutateLocalPracticeGame(gameId, (draft) => {
    if (!draft || draft.winner || draft.currentPhase !== 'spymaster' || draft.currentTeam !== team) return;
    applyLocalPracticeSpymasterClueState(draft, team, clueWord, clueNumber);
    bumpLocalPracticeAISeq(draft, team, 'spy');
  });
  if (window.playSound) window.playSound('clueGiven');
  return true;
}

function _sanitizeOneWordTyping(raw) {
  const w = String(raw || '').trim().toUpperCase();
  if (!w) return '';
  if (w.includes(' ') || w.includes('-')) return '';
  return w.replace(/[^A-Z0-9]/g, '').slice(0, 40);
}

function _dedupeTypingCandidates(items, finalWord) {
  const out = [];
  const seen = new Set();
  const list = Array.isArray(items) ? items : [];
  for (const it of list) {
    const clue = _sanitizeOneWordTyping(it?.clue ?? it?.word ?? it);
    if (!clue) continue;
    if (finalWord && clue === finalWord) continue;
    const n = Number.isFinite(+it?.number) ? Math.max(0, Math.min(9, parseInt(it.number, 10) || 0)) : null;
    const key = `${clue}|${n === null ? '' : n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ clue, number: n });
    if (out.length >= 4) break;
  }
  return out;
}

async function simulateLocalPracticeAISpymasterTyping(gameId, game, team, ai, finalClue, finalNumber, consideredRaw = []) {
  // For local practice (singleplayer), use the *exact* same live typing
  // simulation as multiplayer. The multiplayer implementation lives in
  // ai-player.js as simulateAISpymasterThinking().
  const gid = String(gameId || '').trim();
  if (!gid || !isLocalPracticeGameId(gid)) return;

  const fn = window.simulateAISpymasterThinking;
  if (typeof fn === 'function') {
    try {
      // Pass the considered candidates through so the animation mirrors the
      // multiplayer flow (type drafts → delete → final).
      const considered = Array.isArray(consideredRaw)
        ? consideredRaw.map((c) => ({ clue: c?.clue ?? c?.word ?? c, number: c?.number }))
        : [];
      await fn(ai, game || getLocalPracticeGame(gid), finalClue, finalNumber, { considered });
      return;
    } catch (_) {
      // Fall back to a minimal local animation if something goes wrong.
    }
  }

  // Fallback: keep a basic animation if simulateAISpymasterThinking isn't available.
  const finalWord = _sanitizeOneWordTyping(finalClue);
  if (!finalWord) return;
  const finalNum = Number.isFinite(+finalNumber) ? Math.max(0, Math.min(9, parseInt(finalNumber, 10) || 0)) : 1;
  const typeSpeed = () => 65 + Math.floor(Math.random() * 60);
  const deleteSpeed = () => 45 + Math.floor(Math.random() * 50);
  const setDraft = (word, number) => {
    const w = word ? String(word).toUpperCase().slice(0, 40) : '';
    const payload = w ? {
      team: team === 'blue' ? 'blue' : 'red',
      word: w,
      wordLen: w.length,
      number: (number === null || number === undefined) ? '' : String(number),
      byId: String(ai?.odId || ai?.id || '').trim(),
      byName: String(ai?.name || 'AI').trim(),
      updatedAtMs: Date.now(),
    } : null;
    mutateLocalPracticeGame(gid, (draft) => {
      if (!draft) return;
      if (draft.winner || draft.currentPhase !== 'spymaster' || String(draft.currentTeam || '') !== String(team || '')) return;
      draft.liveClueDraft = payload;
    }, { skipAnimation: true });
    try { if (typeof renderClueArea === 'function') renderClueArea(); } catch (_) {}
  };
  for (let i = 1; i <= finalWord.length; i++) {
    setDraft(finalWord.slice(0, i), (i === finalWord.length) ? finalNum : null);
    await localPracticePause(typeSpeed());
  }
  await localPracticePause(350);
  setDraft('', null);
}

async function runLocalPracticeSpymasterTurn(gameId, game, team) {
  const aiSpies = getLocalPracticeRuntimeAIs(game, team, 'spymaster');
  if (!aiSpies.length) return false;

  const proposeClue = window.aiSpymasterPropose;
  const followupClue = window.aiSpymasterFollowup;
  const chooseClue = window.chooseSpymasterClue;
  const summarizeCouncil = window.aiSpymasterCouncilSummary;
  const useRealCouncil = (typeof proposeClue === 'function' && typeof chooseClue === 'function');

  // Fallback if AI council helpers are unavailable.
  if (!useRealCouncil) {
    const fallbackPlan = await generateLocalPracticeAICluePlan(game, team, aiSpies[0]);
    const boardWordSet = new Set((game?.cards || []).map(c => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
    const clueWord = sanitizeLocalPracticeClueWord(fallbackPlan?.word, boardWordSet) || pickLocalPracticeClueWord(game);
    const clueNumber = clampLocalPracticeClueNumber(fallbackPlan?.number, 1);
    await simulateLocalPracticeAISpymasterTyping(gameId, game, team, aiSpies[0], clueWord, clueNumber, []);
    await submitLocalPracticeClueWithReview(gameId, team, clueWord, clueNumber, aiSpies[0]);
    return true;
  }

  const proposalsByAi = new Map();
  for (const ai of aiSpies) {
    const live = getLocalPracticeGame(gameId);
    if (!live || live.winner || live.currentPhase !== 'spymaster' || live.currentTeam !== team) return false;
    const chatDocs = getLocalPracticeTeamChatDocs(live, team, 14);
    let proposal = null;
    try {
      proposal = await proposeClue(ai, live, { chatDocs });
    } catch (_) {
      proposal = null;
    }
    if (!proposal) continue;
    proposalsByAi.set(ai.id, proposal);
    if (proposal.chat && appendLocalPracticeTeamChat(gameId, team, ai, proposal.chat)) {
      await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs);
    }
  }

  if (aiSpies.length >= 2 && typeof followupClue === 'function' && proposalsByAi.size) {
    let rounds = 0;
    while (rounds < 2) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of aiSpies) {
        const live = getLocalPracticeGame(gameId);
        if (!live || live.winner || live.currentPhase !== 'spymaster' || live.currentTeam !== team) return false;
        const chatDocs = getLocalPracticeTeamChatDocs(live, team, 16);
        let follow = null;
        try {
          follow = await followupClue(ai, live, proposalsByAi, { chatDocs });
        } catch (_) {
          follow = null;
        }
        if (!follow) continue;
        if (follow.clue) {
          const prev = proposalsByAi.get(ai.id) || { ai };
          proposalsByAi.set(ai.id, { ...prev, ...follow });
        }
        if (follow.chat && appendLocalPracticeTeamChat(gameId, team, ai, follow.chat)) {
          anySpoke = true;
          await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs);
        }
      }
      if (!anySpoke) break;
    }
  }

  if (!proposalsByAi.size) {
    const fallbackPlan = await generateLocalPracticeAICluePlan(game, team, aiSpies[0]);
    const boardWordSet = new Set((game?.cards || []).map(c => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
    const clueWord = sanitizeLocalPracticeClueWord(fallbackPlan?.word, boardWordSet) || pickLocalPracticeClueWord(game);
    const clueNumber = clampLocalPracticeClueNumber(fallbackPlan?.number, 1);
    await simulateLocalPracticeAISpymasterTyping(gameId, game, team, aiSpies[0], clueWord, clueNumber, []);
    await submitLocalPracticeClueWithReview(gameId, team, clueWord, clueNumber, aiSpies[0]);
    return true;
  }

  await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.beforeDecisionMs);
  const finalState = getLocalPracticeGame(gameId) || game;
  if (finalState.winner || finalState.currentPhase !== 'spymaster' || finalState.currentTeam !== team) return false;

  const proposals = Array.from(proposalsByAi.values()).filter(Boolean);
  let chosen = null;
  try {
    chosen = chooseClue(proposals);
  } catch (_) {
    chosen = null;
  }

  const boardWordSet = new Set((finalState?.cards || []).map(c => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
  let clueWord = sanitizeLocalPracticeClueWord(chosen?.clue, boardWordSet);
  let clueNumber = clampLocalPracticeClueNumber(chosen?.number, 1);
  if (!clueWord) {
    const fallbackPlan = await generateLocalPracticeAICluePlan(finalState, team, aiSpies[0]);
    clueWord = sanitizeLocalPracticeClueWord(fallbackPlan?.word, boardWordSet) || pickLocalPracticeClueWord(finalState);
    clueNumber = clampLocalPracticeClueNumber(fallbackPlan?.number, clueNumber);
  }

  const executor = pickLocalPracticeRotatingAI(finalState, team, 'spy', aiSpies) || aiSpies[0];
  if (executor && proposals.length >= 2 && typeof summarizeCouncil === 'function') {
    try {
      const chatDocs = getLocalPracticeTeamChatDocs(finalState, team, 10);
      const wrapUp = await summarizeCouncil(executor, finalState, proposals, { clue: clueWord, number: clueNumber }, { chatDocs });
      if (wrapUp) {
        appendLocalPracticeTeamChat(gameId, team, executor, wrapUp);
        await localPracticePause(Math.min(240, LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs));
      }
    } catch (_) {}
  }
  const considered = Array.from(proposalsByAi.values()).map(p => ({ clue: p?.clue ?? p?.word, number: p?.number }));
  await simulateLocalPracticeAISpymasterTyping(gameId, finalState, team, executor || aiSpies[0], clueWord, clueNumber, considered);
  await submitLocalPracticeClueWithReview(gameId, team, clueWord, clueNumber, executor || aiSpies[0]);
  return true;
}

function canLocalPracticeAIActAsOperatives(game, team) {
  return true;
}

function localPracticeNeedsAIAction(game) {
  if (!game || game.winner || game.currentPhase === 'ended') return false;
  const pending = normalizePendingClueEntry(game.pendingClue, game);
  if (pending?.state === 'reviewing') return true;
  if (pending?.state === 'awaiting') {
    const opposingTeam = pending.team === 'red' ? 'blue' : 'red';
    const opposingSpy = getTeamSpymasterPlayer(opposingTeam, game);
    if (opposingSpy?.isAI) return true;
  }

  const team = game.currentTeam === 'blue' ? 'blue' : 'red';
  const roster = team === 'red' ? (game.redPlayers || []) : (game.bluePlayers || []);
  if (game.currentPhase === 'spymaster') {
    return roster.some(p => p?.isAI && isSpymasterPlayerForTeam(p, team, game));
  }
  if (game.currentPhase === 'operatives') {
    const hasAIOps = roster.some(p => p?.isAI && !isSpymasterPlayerForTeam(p, team, game));
    if (!hasAIOps) return false;
    return canLocalPracticeAIActAsOperatives(game, team);
  }
  return false;
}

function pickLocalPracticeAIGuessIndex(game, team) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  const hidden = cards.map((c, i) => ({ c, i })).filter((x) => x?.c && !x.c.revealed);
  if (!hidden.length) return null;

  const own = hidden.filter((x) => x.c.type === team);
  if (own.length) return own[Math.floor(Math.random() * own.length)].i;
  return hidden[Math.floor(Math.random() * hidden.length)].i;
}

async function runLocalPracticeOperativesTurn(gameId, game, team) {
  const aiOps = getLocalPracticeRuntimeAIs(game, team, 'operative');
  if (!aiOps.length) return false;
  if (!canLocalPracticeAIActAsOperatives(game, team)) return false;

  const proposeAction = window.aiOperativePropose;
  const followupAction = window.aiOperativeFollowup;
  const chooseAction = window.chooseOperativeAction;
  const summarizeCouncil = window.aiOperativeCouncilSummary;
  const useRealCouncil = (typeof proposeAction === 'function' && typeof chooseAction === 'function');

  const firstActor = pickLocalPracticeRotatingAI(game, team, 'op', aiOps) || aiOps[0];
  const firstActorName = `AI ${String(firstActor?.name || 'Player')}`.trim();

  if (!game.currentClue || !Number.isFinite(+game.guessesRemaining) || +game.guessesRemaining <= 0) {
    mutateLocalPracticeGame(gameId, (draft) => {
      if (!draft || draft.winner || draft.currentPhase !== 'operatives' || draft.currentTeam !== team) return;
      applyLocalPracticeOperativeEndTurnState(draft, firstActorName);
      bumpLocalPracticeAISeq(draft, team, 'op');
    });
    return true;
  }

  // Fallback if council helpers are unavailable.
  if (!useRealCouncil) {
    const idx = pickLocalPracticeAIGuessIndex(game, team);
    mutateLocalPracticeGame(gameId, (draft) => {
      if (!draft || draft.winner || draft.currentPhase !== 'operatives' || draft.currentTeam !== team) return;
      if (Number.isInteger(idx) && idx >= 0) {
        const applied = applyLocalPracticeGuessState(draft, idx, firstActorName);
        if (!applied) applyLocalPracticeOperativeEndTurnState(draft, firstActorName);
      } else {
        applyLocalPracticeOperativeEndTurnState(draft, firstActorName);
      }
      bumpLocalPracticeAISeq(draft, team, 'op');
    });
    return true;
  }

  const proposalsByAi = new Map();
  for (const ai of aiOps) {
    const live = getLocalPracticeGame(gameId);
    if (!live || live.winner || live.currentPhase !== 'operatives' || live.currentTeam !== team) return false;
    const chatDocs = getLocalPracticeTeamChatDocs(live, team, 14);
    let proposal = null;
    try {
      proposal = await proposeAction(ai, live, {
        requireMarks: aiOps.length >= 2,
        councilSize: aiOps.length,
        chatDocs
      });
    } catch (_) {
      proposal = null;
    }
    if (!proposal) continue;
    proposalsByAi.set(ai.id, proposal);
    if (proposal.chat && appendLocalPracticeTeamChat(gameId, team, ai, proposal.chat)) {
      await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs);
    }
  }

  if (aiOps.length >= 2 && typeof followupAction === 'function' && proposalsByAi.size) {
    let rounds = 0;
    while (rounds < 2) {
      rounds += 1;
      let anySpoke = false;
      for (const ai of aiOps) {
        const live = getLocalPracticeGame(gameId);
        if (!live || live.winner || live.currentPhase !== 'operatives' || live.currentTeam !== team) return false;
        const chatDocs = getLocalPracticeTeamChatDocs(live, team, 16);
        let follow = null;
        try {
          follow = await followupAction(ai, live, proposalsByAi, { chatDocs });
        } catch (_) {
          follow = null;
        }
        if (!follow) continue;
        if (follow.action === 'guess' || follow.action === 'end_turn') {
          const prev = proposalsByAi.get(ai.id) || { ai };
          proposalsByAi.set(ai.id, { ...prev, ...follow });
        }
        if (follow.chat && appendLocalPracticeTeamChat(gameId, team, ai, follow.chat)) {
          anySpoke = true;
          await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs);
        }
      }
      if (!anySpoke) break;
    }
  }

  if (!proposalsByAi.size) {
    mutateLocalPracticeGame(gameId, (draft) => {
      if (!draft || draft.winner || draft.currentPhase !== 'operatives' || draft.currentTeam !== team) return;
      applyLocalPracticeOperativeEndTurnState(draft, firstActorName);
      bumpLocalPracticeAISeq(draft, team, 'op');
    });
    return true;
  }

  await localPracticePause(LOCAL_PRACTICE_COUNCIL_PACE.beforeDecisionMs);
  const finalState = getLocalPracticeGame(gameId) || game;
  if (finalState.winner || finalState.currentPhase !== 'operatives' || finalState.currentTeam !== team) return false;

  const proposals = Array.from(proposalsByAi.values()).filter(Boolean);
  let decision = null;
  if (aiOps.length === 1) {
    const only = proposals[0] || {};
    if (only.action === 'guess' && Number.isInteger(+only.index)) decision = { action: 'guess', index: Number(only.index) };
    else decision = { action: 'end_turn', index: null };
  } else {
    try {
      decision = chooseAction(proposals, finalState, aiOps.length);
    } catch (_) {
      decision = null;
    }
  }
  if (!decision || (decision.action !== 'guess' && decision.action !== 'end_turn')) {
    decision = { action: 'end_turn', index: null };
  }

  const executor = pickLocalPracticeRotatingAI(finalState, team, 'op', aiOps) || firstActor;
  const actorName = `AI ${String(executor?.name || 'Player')}`.trim();

  if (executor && proposals.length >= 2 && typeof summarizeCouncil === 'function') {
    try {
      const chatDocs = getLocalPracticeTeamChatDocs(finalState, team, 10);
      const wrapUp = await summarizeCouncil(executor, finalState, proposals, decision, { chatDocs });
      if (wrapUp) {
        appendLocalPracticeTeamChat(gameId, team, executor, wrapUp);
        await localPracticePause(Math.min(240, LOCAL_PRACTICE_COUNCIL_PACE.betweenSpeakersMs));
      }
    } catch (_) {}
  }

  mutateLocalPracticeGame(gameId, (draft) => {
    if (!draft || draft.winner || draft.currentPhase !== 'operatives' || draft.currentTeam !== team) return;
    bumpLocalPracticeAISeq(draft, team, 'op');
    if (decision.action === 'guess' && Number.isInteger(+decision.index)) {
      const idx = Number(decision.index);
      const applied = applyLocalPracticeGuessState(draft, idx, actorName);
      if (!applied) applyLocalPracticeOperativeEndTurnState(draft, actorName);
    } else {
      applyLocalPracticeOperativeEndTurnState(draft, actorName);
    }
  });
  return true;
}

function stopLocalPracticeAI() {
  if (localPracticeAiTimer) clearTimeout(localPracticeAiTimer);
  localPracticeAiTimer = null;
  localPracticeAiBusy = false;
  localPracticeAiGameId = null;
}

function scheduleLocalPracticeAI(delayMs = 0) {
  if (!isCurrentLocalPracticeGame()) {
    stopLocalPracticeAI();
    return;
  }
  const gid = String(currentGame.id || '').trim();
  if (!gid) return;
  localPracticeAiGameId = gid;
  if (localPracticeAiTimer) clearTimeout(localPracticeAiTimer);
  localPracticeAiTimer = setTimeout(() => {
    localPracticeAiTimer = null;
    if (!isCurrentLocalPracticeGame()) return;
    if (String(currentGame?.id || '').trim() !== gid) return;
    void runLocalPracticeAIOnce();
  }, Math.max(0, Number(delayMs) || 0));
}

async function runLocalPracticeAIOnce() {
  if (localPracticeAiBusy) return;
  if (!isCurrentLocalPracticeGame()) {
    stopLocalPracticeAI();
    return;
  }

  const gid = String(currentGame?.id || '').trim();
  if (!gid) return;

  localPracticeAiBusy = true;
  try {
    const game = getLocalPracticeGame(gid);
    if (!game) {
      stopLocalPracticeAI();
      return;
    }
    if (game.winner || game.currentPhase === 'ended') {
      stopLocalPracticeAI();
      return;
    }

    const pending = normalizePendingClueEntry(game.pendingClue, game);
    if (pending?.state === 'awaiting') {
      const handled = await maybeResolveLocalPracticePendingClue(gid, game);
      if (handled) return;
    } else if (pending?.state === 'reviewing') {
      void runCouncilReviewForPendingClue(gid, pending.id);
      return;
    }

    const team = game.currentTeam === 'blue' ? 'blue' : 'red';
    if (game.currentPhase === 'spymaster') {
      await runLocalPracticeSpymasterTurn(gid, game, team);
      return;
    }

    if (game.currentPhase === 'operatives') {
      await runLocalPracticeOperativesTurn(gid, game, team);
      return;
    }
  } finally {
    localPracticeAiBusy = false;
    if (!isCurrentLocalPracticeGame()) return;
    const live = getLocalPracticeGame(currentGame?.id);
    if (!live || !localPracticeNeedsAIAction(live)) {
      stopLocalPracticeAI();
      return;
    }
    const minDelay = isOgLikeStyleActive() ? (CARD_CONFIRM_ANIM_MS + 40) : 480;
    const jitter = isOgLikeStyleActive() ? 180 : 240;
    scheduleLocalPracticeAI(minDelay + Math.floor(Math.random() * jitter));
  }
}

function maybeStartLocalPracticeAI() {
  if (!isCurrentLocalPracticeGame()) {
    stopLocalPracticeAI();
    return;
  }
  const g = getLocalPracticeGame(currentGame.id);
  if (!g || !localPracticeNeedsAIAction(g)) {
    stopLocalPracticeAI();
    return;
  }
  scheduleLocalPracticeAI(180 + Math.floor(Math.random() * 120));
}

window.isLocalPracticeGameId = isLocalPracticeGameId;
window.mutateLocalPracticeGame = mutateLocalPracticeGame;
window.hasLocalPracticeGame = function hasLocalPracticeGame(gameId) {
  const key = String(gameId || '').trim();
  if (!isLocalPracticeGameId(key)) return false;
  return localPracticeGames.has(key);
};
window.isPracticeGameActive = () => !!(currentGame && currentGame.type === 'practice');

// Quick Play settings / negotiation
function readQuickSettingsFromUI() {
  const blackCards = parseInt(document.getElementById('qp-black-cards')?.value || '1', 10);
  const clueTimerSeconds = parseInt(document.getElementById('qp-clue-timer')?.value || '0', 10);
  const guessTimerSeconds = parseInt(document.getElementById('qp-guess-timer')?.value || '0', 10);
  const stackingToggle = document.getElementById('qp-stacking-toggle');
  const stackingEnabled = stackingToggle ? !!stackingToggle.checked : true;
  const vibe = String(document.getElementById('qp-vibe')?.value || '').trim();
  return {
    blackCards: Number.isFinite(blackCards) ? blackCards : 1,
    clueTimerSeconds: Number.isFinite(clueTimerSeconds) ? clueTimerSeconds : 0,
    guessTimerSeconds: Number.isFinite(guessTimerSeconds) ? guessTimerSeconds : 0,
    stackingEnabled,
    deckId: "standard",// AI-driven words; fallback uses standard bank,
    vibe: vibe || '',
  };
}

function getQuickSettings(game) {
  const base = game?.quickSettings || null;
  if (base && typeof base === 'object') {
    return {
      blackCards: Number.isFinite(+base.blackCards) ? +base.blackCards : 1,
      clueTimerSeconds: Number.isFinite(+base.clueTimerSeconds) ? +base.clueTimerSeconds : 0,
      guessTimerSeconds: Number.isFinite(+base.guessTimerSeconds) ? +base.guessTimerSeconds : 0,
      stackingEnabled: base.stackingEnabled !== false,
      deckId: normalizeDeckId(base.deckId || 'standard'),
      vibe: String(base.vibe || ''),
    };
  }
  if (String(game?.type || '') === 'practice') {
    const practice = (game?.practice && typeof game.practice === 'object') ? game.practice : {};
    return {
      blackCards: Number.isFinite(+practice.blackCards) ? +practice.blackCards : 1,
      clueTimerSeconds: Number.isFinite(+practice.clueTimerSeconds) ? +practice.clueTimerSeconds : 0,
      guessTimerSeconds: Number.isFinite(+practice.guessTimerSeconds) ? +practice.guessTimerSeconds : 0,
      stackingEnabled: practice.stackingEnabled !== false,
      deckId: normalizeDeckId(game?.deckId || practice.deckId || 'standard'),
      vibe: String(game?.vibe || practice.vibe || ''),
    };
  }
  return {
    blackCards: 1,
    clueTimerSeconds: 0,
    guessTimerSeconds: 0,
    stackingEnabled: true,
    deckId: 'standard',
    vibe: '',
  };
}

function getPhaseTimerSeconds(game, phase) {
  const s = getQuickSettings(game);
  if (phase === 'spymaster') {
    const secs = Number(s?.clueTimerSeconds);
    return Number.isFinite(secs) ? Math.max(0, secs) : 0;
  }
  if (phase === 'operatives') {
    const secs = Number(s?.guessTimerSeconds);
    return Number.isFinite(secs) ? Math.max(0, secs) : 0;
  }
  return 0;
}

function buildPhaseTimerEndValue(game, phase) {
  const secs = getPhaseTimerSeconds(game, phase);
  if (!secs) return null;
  const ms = Date.now() + (secs * 1000);
  try {
    return firebase.firestore.Timestamp.fromDate(new Date(ms));
  } catch (_) {
    return new Date(ms);
  }
}

function formatSeconds(sec) {
  const s = parseInt(sec || 0, 10);
  if (!s) return '∞';
  if (s % 60 === 0) {
    const m = s / 60;
    return `${m}m`;
  }
  return `${s}s`;
}

function formatQuickRules(settings) {
  const s = settings || { blackCards: 1, clueTimerSeconds: 0, guessTimerSeconds: 0, stackingEnabled: true, vibe: '' };
  const vibeStr = s.vibe ? ` · Vibe: ${s.vibe}` : '';
  const stackStr = s.stackingEnabled === false ? 'Off' : 'On';
  return `Assassin: ${s.blackCards} · Clue: ${formatSeconds(s.clueTimerSeconds)} · Guess: ${formatSeconds(s.guessTimerSeconds)} · Stacking: ${stackStr}${vibeStr}`;
}



// Check if a team is fully ready (all players ready)
function teamIsFullyReady(game, team) {
  const players = Array.isArray(game?.[team + 'Players']) ? game[team + 'Players'] : [];
  if (players.length === 0) return false;
  return players.every(p => !!p.ready);
}

// Load words on init
document.addEventListener('DOMContentLoaded', async () => {
  await loadWords();
  initGameUI();
  listenToChallenges();
  listenToQuickPlayDoc();
});

/* =========================
   Word Bank
========================= */
async function loadWords() {
  try {
    const res = await fetch('words.json');
    const data = await res.json();
    wordsDecks = (data && typeof data === 'object') ? data : {};
    wordsBank = (wordsDecks.standard && Array.isArray(wordsDecks.standard)) ? wordsDecks.standard : (data.standard || []);
    initQuickDeckPicker();
  } catch (e) {
    console.error('Failed to load words:', e);
    wordsDecks = {};
    wordsBank = generateFallbackWords();
  }
}

function generateFallbackWords() {
  // Basic fallback if words.json fails to load
  const words = [];
  for (let i = 1; i <= 400; i++) {
    words.push(`WORD${i}`);
  }
  return words;
}

function getRandomWords(count, deckId) {
  const bank = deckId ? getWordsForDeck(deckId) : wordsBank;
  const source = Array.isArray(bank) && bank.length >= count ? bank : wordsBank;
  const shuffled = [...source].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

function _normVibeToken(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function _splitVibeWordTokens(input) {
  return String(input || '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/g)
    .map(s => s.trim())
    .filter(Boolean);
}

function _shuffleInPlace(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = list[i];
    list[i] = list[j];
    list[j] = t;
  }
  return list;
}

// Local fallback hints used when AI vibe generation is unavailable.
// This keeps "vibe" useful in Practice/Quick Play without requiring network AI.
const LOCAL_VIBE_HINTS = {
  COUNTRY: ['EGYPT', 'GERMANY', 'GREECE', 'CHINA', 'INDIA', 'ENGLAND', 'FRANCE', 'RUSSIA', 'MEXICO', 'BRAZIL'],
  COUNTRIES: ['EGYPT', 'GERMANY', 'GREECE', 'CHINA', 'INDIA', 'ENGLAND', 'FRANCE', 'RUSSIA', 'MEXICO', 'BRAZIL'],
  NATION: ['EGYPT', 'GERMANY', 'GREECE', 'CHINA', 'INDIA', 'ENGLAND', 'FRANCE', 'RUSSIA', 'MEXICO', 'BRAZIL'],
  NATIONS: ['EGYPT', 'GERMANY', 'GREECE', 'CHINA', 'INDIA', 'ENGLAND', 'FRANCE', 'RUSSIA', 'MEXICO', 'BRAZIL'],
  SPORT: ['CRICKET', 'BAT', 'NET', 'GOAL', 'COURT', 'PITCH', 'RACKET', 'MATCH', 'SKATE', 'RACE'],
  SPORTS: ['CRICKET', 'BAT', 'NET', 'GOAL', 'COURT', 'PITCH', 'RACKET', 'MATCH', 'SKATE', 'RACE'],
  ANIMAL: ['SHARK', 'SEAL', 'BUG', 'SPIDER', 'BAT', 'MOUSE', 'HORSE', 'BEAR', 'FOX', 'WHALE'],
  ANIMALS: ['SHARK', 'SEAL', 'BUG', 'SPIDER', 'BAT', 'MOUSE', 'HORSE', 'BEAR', 'FOX', 'WHALE'],
  MUSIC: ['PIANO', 'FLUTE', 'NOTE', 'BAND', 'DRUM', 'SONG', 'OPERA', 'CONCERT', 'JAZZ', 'ROCK'],
  SONG: ['PIANO', 'FLUTE', 'NOTE', 'BAND', 'DRUM', 'OPERA', 'CONCERT', 'JAZZ', 'ROCK'],
  FOOD: ['APPLE', 'ORANGE', 'CHOCOLATE', 'BREAD', 'CHEESE', 'SALT', 'SUGAR', 'HONEY'],
  SPACE: ['STAR', 'MOON', 'SATURN', 'MARS', 'COMET', 'ORBIT', 'ROCKET', 'PLANET'],
  SCIENCE: ['LAB', 'ATOM', 'MODEL', 'ENERGY', 'GRAVITY', 'CELL', 'DNA', 'LASER'],
  TECH: ['MODEL', 'SCREEN', 'KEY', 'MOUSE', 'CHIP', 'NET', 'SERVER', 'CODE'],
  TECHNOLOGY: ['MODEL', 'SCREEN', 'KEY', 'MOUSE', 'CHIP', 'NET', 'SERVER', 'CODE'],
  WAR: ['BOND', 'TANK', 'BATTLE', 'ARMY', 'MISSILE', 'SPY', 'GENERAL'],
  MILITARY: ['BOND', 'TANK', 'BATTLE', 'ARMY', 'MISSILE', 'SPY', 'GENERAL'],
  OCEAN: ['SHARK', 'SEAL', 'WHALE', 'FISH', 'WATER', 'SHIP', 'SUB', 'HARBOR'],
  WATER: ['SHARK', 'SEAL', 'WHALE', 'FISH', 'SHIP', 'SUB', 'RIVER', 'LAKE'],
};

const LOCAL_VIBE_HINT_SETS = Object.fromEntries(
  Object.entries(LOCAL_VIBE_HINTS).map(([k, arr]) => [
    _normVibeToken(k),
    new Set((arr || []).map(_normVibeToken).filter(Boolean))
  ])
);

function scoreWordAgainstVibeLocally(word, vibeTokens) {
  const raw = String(word || '').trim();
  const norm = _normVibeToken(raw);
  if (!norm) return 0;
  const parts = _splitVibeWordTokens(raw).map(_normVibeToken).filter(Boolean);

  let score = 0;
  for (const token of vibeTokens) {
    if (!token) continue;

    if (norm === token) score += 26;
    if (norm.includes(token) || token.includes(norm)) score += 13;

    for (const p of parts) {
      if (p === token) score += 19;
      else if (p.startsWith(token) || token.startsWith(p)) score += 9;
    }

    const hintSet = LOCAL_VIBE_HINT_SETS[token];
    if (hintSet) {
      if (hintSet.has(norm)) score += 17;
      else if (parts.some(p => hintSet.has(p))) score += 12;
    }
  }

  return score;
}

function getLocalVibeWords(vibe, deckId, count = BOARD_SIZE) {
  const terms = parseVibeTerms(vibe);
  const pool = Array.isArray(getWordsForDeck(deckId)) ? getWordsForDeck(deckId) : wordsBank;
  if (!terms.length || !Array.isArray(pool) || pool.length < count) {
    return getRandomWords(count, deckId);
  }

  const vibeTokens = new Set();
  for (const term of terms) {
    const main = _normVibeToken(term);
    if (main) vibeTokens.add(main);
    for (const t of _splitVibeWordTokens(term)) {
      const n = _normVibeToken(t);
      if (!n) continue;
      vibeTokens.add(n);
      if (n.endsWith('S') && n.length > 3) vibeTokens.add(n.slice(0, -1));
      if (!n.endsWith('S') && n.length > 3) vibeTokens.add(`${n}S`);
    }
  }

  const seen = new Set();
  const scored = [];
  for (const w of pool) {
    const key = String(w || '').trim().toUpperCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    scored.push({ word: w, score: scoreWordAgainstVibeLocally(w, vibeTokens) });
  }

  const strong = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const remainder = scored.filter(x => x.score <= 0);
  _shuffleInPlace(remainder);

  let picked = [];
  if (strong.length) {
    const topWindow = strong.slice(0, Math.min(strong.length, count * 3));
    _shuffleInPlace(topWindow);
    picked = topWindow.slice(0, count).map(x => x.word);
  }

  if (picked.length < count) {
    const existing = new Set(picked.map(w => String(w || '').trim().toUpperCase()));
    for (const row of remainder) {
      const key = String(row.word || '').trim().toUpperCase();
      if (!key || existing.has(key)) continue;
      picked.push(row.word);
      existing.add(key);
      if (picked.length >= count) break;
    }
  }

  if (picked.length < count) {
    const backup = getRandomWords(count, deckId);
    const existing = new Set(picked.map(w => String(w || '').trim().toUpperCase()));
    for (const w of backup) {
      const key = String(w || '').trim().toUpperCase();
      if (!key || existing.has(key)) continue;
      picked.push(w);
      existing.add(key);
      if (picked.length >= count) break;
    }
  }

  return _shuffleInPlace(picked).slice(0, count);
}

/* =========================
   AI Word Generation
========================= */
function parseVibeTerms(vibeStr) {
  const s = String(vibeStr || '').trim();
  return s
    ? s
        .split(/[;,]/g)
        .map(t => t.trim())
        .filter(Boolean)
        .slice(0, 10)
    : [];
}

function safeJsonParse(result) {
  try {
    return JSON.parse(result);
  } catch {
    const match = String(result || '').match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error('Could not parse AI JSON');
  }
}

function normalizeWordList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map(w => String(w).trim().toUpperCase())
    .filter(w => w.length >= 2);
}

// Strictly validate that each word is meaningfully related to the vibe terms.
// Uses an LLM judge (fast, low-temp) rather than relying on anchors alone.
async function validateVibeBoard(vibeTerms, words) {
  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') throw new Error('AI not available');

  const terms = Array.isArray(vibeTerms) ? vibeTerms.filter(Boolean).slice(0, 10) : [];
  if (!terms.length) return { badWords: [], details: null };

  const systemPrompt = `You are a strict content validator for a Codenames board.

Task:
- Given VIBE TERMS and a list of 25 BOARD WORDS, decide whether EACH board word is clearly and directly related to AT LEAST ONE vibe term.
- "Related" means: synonym, closely associated concept, part-of, famous instance, key person/place/object/practice, or highly typical cultural reference.
- If a word is only weakly related, ambiguous, generic filler, or unrelated, mark it NOT_RELATED.

Safety:
- Be respectful about religions/cultures. Do not introduce slurs or insults.

Output JSON ONLY:
{
  "verdicts":[{"word":"WORD","related":true|false,"vibe":"<best matching term>","why":"1-4 words"}],
  "summary":{"relatedCount":N,"notRelatedCount":M}
}

Rules:
- Keep "why" extremely short.
- Do not add extra commentary.`;

  const userPrompt = `VIBE TERMS: ${terms.map(t => `"${t}"`).join(', ')}\nBOARD WORDS: ${words.map(w => `"${w}"`).join(', ')}`;

  const result = await chatFn(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.15,
      max_tokens: 420,
      response_format: { type: 'json_object' },
    }
  );

  const parsed = safeJsonParse(result);
  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  const bad = new Set();
  for (const v of verdicts) {
    const w = String(v?.word || '').trim().toUpperCase();
    const related = Boolean(v?.related);
    if (w && !related) bad.add(w);
  }

  // If the validator returned fewer verdicts, treat missing ones as bad.
  if (verdicts.length < words.length) {
    for (const w of words) bad.add(String(w).trim().toUpperCase());
  }

  return { badWords: [...bad], details: parsed };
}

// Replace only the words the validator flagged as not related.
async function generateVibeReplacements(vibeTerms, badWords, keepWords) {
  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') throw new Error('AI not available');

  const terms = Array.isArray(vibeTerms) ? vibeTerms.filter(Boolean).slice(0, 10) : [];
  const bad = Array.isArray(badWords) ? badWords.filter(Boolean).slice(0, 25) : [];
  const keep = Array.isArray(keepWords) ? keepWords.filter(Boolean).slice(0, 25) : [];
  if (!terms.length || !bad.length) return [];

  const systemPrompt = `You are a Codenames board fixer.

Goal: Replace ONLY the flagged BAD WORDS with new words that are strongly related to the VIBE TERMS.

Constraints for each replacement:
- SINGLE word, ENGLISH, UPPERCASE
- 3-12 characters
- No spaces, hyphens, or punctuation
- Must be clearly related to at least one vibe term
- Must NOT duplicate any KEEP WORDS or other replacements

Return JSON ONLY:
{"replacements":[{"from":"BAD","to":"NEW"}, ...]}`;

  const userPrompt = `VIBE TERMS: ${terms.map(t => `"${t}"`).join(', ')}\nKEEP WORDS: ${keep.map(w => `"${w}"`).join(', ')}\nBAD WORDS: ${bad.map(w => `"${w}"`).join(', ')}`;

  const result = await chatFn(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    {
      temperature: 0.7,
      max_tokens: 320,
      response_format: { type: 'json_object' },
    }
  );

  const parsed = safeJsonParse(result);
  const repl = Array.isArray(parsed.replacements) ? parsed.replacements : [];
  return repl
    .map(r => ({
      from: String(r?.from || '').trim().toUpperCase(),
      to: String(r?.to || '').trim().toUpperCase(),
    }))
    .filter(r => r.from && r.to);
}

async function generateAIWordsOnce(vibeTerms) {
  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') throw new Error('AI not available');

  const vibeInstruction = vibeTerms.length
    ? [
        `VIBE WORDS (use ONLY these as your thematic anchors): ${vibeTerms.map(t => `"${t}"`).join(', ')}`,
        `Every generated board word MUST be clearly and directly related to AT LEAST ONE vibe word above (synonym, close associate, part-of, famous instance, etc.).`,
        `If the vibe is a religion/culture (e.g., Islam), choose respectful, accurate words related to beliefs, practices, history, places, artifacts, holidays, and culture.`,
        `Avoid generic filler words that do not strongly connect back to the vibe words.`,
        `For each generated word, also output which vibe word it is anchored to.`
      ].join('\n')
    : `Generate a diverse mix of words suitable for a Codenames board game. Include a variety of nouns covering different categories (animals, places, objects, professions, food, nature, science, history, etc.). Make them interesting for word-association gameplay.`;

  const systemPrompt = `You are a Codenames board generator. Generate exactly 25 unique single words for a Codenames game board.

RULES:
- Each word must be a SINGLE word (no spaces, no hyphens, no compound words)
- All 25 words must be UNIQUE (no duplicates)
- Words should be common enough that players know them
- Words should be interesting and varied enough to create word associations between them
- Words must be in ENGLISH and UPPERCASE
- Each word should be 3-12 characters long

${vibeInstruction}

Respond with valid JSON.
- If vibe words are provided, use this schema:
  {"words":["WORD1",..."WORD25"],"anchors":[{"word":"WORD1","vibe":"<one of the vibe words>"}, ...]}
- If no vibe words are provided, you may omit "anchors".
JSON only. No markdown.`;

  const result = await chatFn(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Generate the 25 words now as JSON.' },
    ],
    {
      temperature: 0.9,
      max_tokens: 450,
      response_format: { type: 'json_object' },
    }
  );

  const parsed = safeJsonParse(result);
  const raw = parsed.words;
  const normalized = normalizeWordList(raw);

  if (normalized.length < 25) {
    throw new Error(`AI returned ${normalized.length} words, need 25`);
  }

  const unique = [...new Set(normalized)];
  if (unique.length < 25) throw new Error('AI returned too many duplicates');

  // Anchor sanity check (still useful, but not sufficient).
  if (vibeTerms.length) {
    const anchors = Array.isArray(parsed.anchors) ? parsed.anchors : [];
    const allowed = new Set(vibeTerms.map(t => t.toLowerCase()));
    const byWord = new Map(
      anchors
        .map(a => ({
          w: String(a?.word || '').trim().toUpperCase(),
          v: String(a?.vibe || '').trim().toLowerCase(),
        }))
        .filter(a => a.w && a.v)
        .map(a => [a.w, a.v])
    );
    let okCount = 0;
    for (const w of unique.slice(0, 25)) {
      const v = byWord.get(w);
      if (v && allowed.has(v)) okCount++;
    }
    if (okCount < 22) throw new Error('AI board was not anchored to the provided vibe words.');
  }

  return unique.slice(0, 25);
}

async function generateAIWords(vibe) {
  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') throw new Error('AI not available');

  const vibeStr = String(vibe || '').trim();

  // Treat a non-empty vibe string as a list of "vibe words" (comma/semicolon separated).
  // This lets players input: "ocean, beach, ship" and get a board that stays strictly on-theme.
  const vibeTerms = parseVibeTerms(vibeStr);

  // Performance / responsiveness: keep the number of LLM calls bounded.
  const MAX_ATTEMPTS = 3;

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      let words = await generateAIWordsOnce(vibeTerms);

      // Strict semantic validation. For a single-term vibe like "islam" we aim for 25/25 related.
      const { badWords } = await validateVibeBoard(vibeTerms, words);
      if (badWords.length === 0) return words;

      // Try a fast patch pass: replace only the flagged words.
      const keep = words.filter(w => !badWords.includes(w));
      const repl = await generateVibeReplacements(vibeTerms, badWords, keep);
      if (repl.length) {
        const used = new Set(words);
        const map = new Map(repl.map(r => [r.from, r.to]));
        words = words.map(w => {
          const to = map.get(w);
          if (!to) return w;
          if (used.has(to)) return w;
          used.delete(w);
          used.add(to);
          return to;
        });
      }

      const v2 = await validateVibeBoard(vibeTerms, words);
      if (v2.badWords.length === 0) return words;

      throw new Error(`Vibe validation failed (${v2.badWords.length} not-related words)`);
    } catch (err) {
      lastErr = err;
      // Try again (bounded). If repeated failures, caller will fall back to deck.
      console.warn(`AI vibe board attempt ${attempt} failed:`, err);
    }
  }

  throw lastErr || new Error('AI vibe board generation failed');
}

// Build a Quick Play board (cards) from settings.
// IMPORTANT: This is async because it may call the LLM to generate vibe-based words.
async function buildQuickPlayCardsFromSettings(settings) {
  const s = settings || { blackCards: 1, clueTimerSeconds: 0, guessTimerSeconds: 0, deckId: 'standard', vibe: '' };
  const firstTeam = 'red';

  let words;
  const vibe = String(s.vibe || '').trim();
  if (vibe) {
    if (typeof window.aiChatCompletion === 'function') {
      try {
        words = await generateAIWords(vibe);
      } catch (err) {
        console.warn('AI vibe word generation failed, using local vibe fallback:', err);
        words = getLocalVibeWords(vibe, s.deckId, BOARD_SIZE);
      }
    } else {
      words = getLocalVibeWords(vibe, s.deckId, BOARD_SIZE);
    }
  } else {
    // If no vibe was provided, use the selected deck bank.
    words = getRandomWords(BOARD_SIZE, s.deckId);
  }

  const keyCard = generateKeyCard(firstTeam, s.blackCards);
  return words.map((word, i) => ({ word, type: keyCard[i], revealed: false }));
}

/* =========================
   Practice (AI scrim)
========================= */

function _practiceAIPool() {
  return ['Nova','Atlas','Pixel','Echo','Moss','Sage','Koi','Luna','Orion','Byte','Vega','Sol','Ivy','Nix','Roam','Pico','Rune','Fable','Zephyr','Quill'];
}

function _makePracticeAI(team, role, usedNames) {
  const pool = _practiceAIPool().filter(n => !usedNames.has(n));
  const base = pool.length ? pool[Math.floor(Math.random() * pool.length)] : `Bot${Math.floor(Math.random()*999)}`;
  usedNames.add(base);
  const odId = `ai_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  return {
    odId,
    name: base,
    role,
    team,
    isAI: true,
    ready: true,
    aiId: odId,
    aiMode: 'autonomous',
    aiTemperature: 0.6 + Math.random() * 0.6,
  };
}

/**
 * Creates a brand-new practice game with AI teammates/opponents.
 * Does NOT touch LS_ACTIVE_GAME_ID.
 */
window.createPracticeGame = async function createPracticeGame(opts = {}) {
  const u = auth.currentUser;
  if (!u) throw new Error('Sign in first.');
  const userName = (getUserName() || u.displayName || 'Player').trim();
  if (!userName) throw new Error('Set a name first.');

  const size = Math.max(2, Math.min(5, parseInt(opts.size, 10) || 2)); // 2, 3, 4, or 5
  const yourRole = String(opts.role || 'operative'); // 'operative' | 'spymaster'
  const vibe = String(opts.vibe || '').trim();
  const deckId = normalizeDeckId(opts.deckId || 'standard');
  const blackCardsRaw = parseInt(opts.blackCards, 10);
  const blackCards = (blackCardsRaw === 2 || blackCardsRaw === 3) ? blackCardsRaw : 1;
  const clueTimerRaw = parseInt(opts.clueTimerSeconds, 10);
  const clueTimerSeconds = Number.isFinite(clueTimerRaw) ? Math.max(0, clueTimerRaw) : 0;
  const guessTimerRaw = parseInt(opts.guessTimerSeconds, 10);
  const guessTimerSeconds = Number.isFinite(guessTimerRaw) ? Math.max(0, guessTimerRaw) : 0;
  const stackingEnabled = opts?.stackingEnabled !== false;
  const quickSettings = {
    blackCards,
    clueTimerSeconds,
    guessTimerSeconds,
    stackingEnabled,
    deckId,
    vibe,
  };

  const usedNames = new Set([userName]);
  const uid = getUserId();

  // Build board cards (reuse Quick Play generator so "vibe" works consistently).
  const cardSettings = {
    vibe,
    deckId,
    blackCards
  };
  const cards = await buildQuickPlayCardsFromSettings(cardSettings);

  // Teams
  const redPlayers = [];
  const bluePlayers = [];

  const human = {
    odId: uid,
    name: userName,
    role: yourRole === 'spymaster' ? 'spymaster' : 'operative',
    team: 'red',
    ready: true,
    isAI: false,
  };

  const needOps = Math.max(1, size - 1);

  if (human.role === 'spymaster') {
    // You are red spymaster
    redPlayers.push(human);
    for (let i = 0; i < needOps; i++) redPlayers.push(_makePracticeAI('red', 'operative', usedNames));
  } else {
    // You are red operative
    redPlayers.push(_makePracticeAI('red', 'spymaster', usedNames));
    redPlayers.push(human);
    for (let i = 1; i < needOps; i++) redPlayers.push(_makePracticeAI('red', 'operative', usedNames));
  }

  // Blue team all AI
  bluePlayers.push(_makePracticeAI('blue', 'spymaster', usedNames));
  for (let i = 0; i < needOps; i++) bluePlayers.push(_makePracticeAI('blue', 'operative', usedNames));

  // Ensure spymaster fields
  const redSpy = redPlayers.find(p => p.role === 'spymaster') || null;
  const blueSpy = bluePlayers.find(p => p.role === 'spymaster') || null;

  const gameData = {
    id: createLocalPracticeId(),
    type: 'practice',
    redTeamName: 'Red Team',
    blueTeamName: 'Blue Team',
    createdAt: new Date().toISOString(),
    createdAtMs: Date.now(),
    createdBy: uid,
    createdByName: userName,
    vibe,
    deckId,
    cards,
    redMarkers: {},
    blueMarkers: {},
    redConsidering: {},
    blueConsidering: {},
    // game state
    currentPhase: 'spymaster',
    currentTeam: 'red',
    currentClue: null,
    pendingClue: null,
    liveClueDraft: null,
    guessesRemaining: 0,
    timerEnd: null,
    redCardsLeft: FIRST_TEAM_CARDS,
    blueCardsLeft: SECOND_TEAM_CARDS,
    winner: null,
    redPlayers,
    bluePlayers,
    spectators: [],
    redSpymaster: redSpy ? String(redSpy.name || '').trim() : null,
    blueSpymaster: blueSpy ? String(blueSpy.name || '').trim() : null,
    log: ['Practice game started.'],
    redChat: [],
    blueChat: [],
    clueHistory: [],
    quickSettings: { ...quickSettings },
    // practice knobs
    practice: {
      size,
      yourRole: human.role,
      blackCards,
      clueTimerSeconds,
      guessTimerSeconds,
      stackingEnabled,
      deckId,
      vibe,
      openedAtMs: Date.now(),
    },
    // tracking for inactivity logic
    lastMoveAtMs: Date.now(),
    updatedAtMs: Date.now(),
  };
  gameData.timerEnd = buildPhaseTimerEndValue(gameData, 'spymaster');

  setLocalPracticeGame(gameData.id, gameData, { skipRender: true });
  return gameData.id;
};


/* =========================
   Key Card Generation
========================= */
function generateKeyCard(firstTeam, assassinCards = 1) {
  // firstTeam gets 9 cards, other team gets 8
  // Neutral cards fill the remainder, plus N assassins
  const types = [];

  const first = firstTeam === 'red' ? 'red' : 'blue';
  const second = firstTeam === 'red' ? 'blue' : 'red';

  for (let i = 0; i < FIRST_TEAM_CARDS; i++) types.push(first);
  for (let i = 0; i < SECOND_TEAM_CARDS; i++) types.push(second);
  const neutralCards = BOARD_SIZE - FIRST_TEAM_CARDS - SECOND_TEAM_CARDS - Math.max(1, assassinCards);
  for (let i = 0; i < neutralCards; i++) types.push('neutral');
  for (let i = 0; i < Math.max(1, assassinCards); i++) types.push('assassin');

  // Shuffle
  return types.sort(() => Math.random() - 0.5);
}

/* =========================
   Game UI Initialization
========================= */
function initGameUI() {
  // Mode selection buttons
  document.getElementById('select-quick-play')?.addEventListener('click', () => {
    // If there's a live game already in progress (typically tournament), gate quick play
    // with a chooser overlay (rejoin/spectate/back to homepage).
    try {
      if (typeof window.maybeGateQuickPlayWithLiveGame === 'function') {
        window.maybeGateQuickPlayWithLiveGame({ onProceed: () => showQuickPlayLobby(), showLoading: true, loadingLabel: 'Loading', minDelayMs: 250 });
        return;
      }
    } catch (_) {}
    showQuickPlayLobby();
  });
  document.getElementById('select-tournament')?.addEventListener('click', () => showTournamentLobby());

  // Back buttons
  // Quick Play should always return to the initial mode chooser (launch screen).
  document.getElementById('quick-back-btn')?.addEventListener('click', () => {
    if (typeof window.returnToLaunchScreen === 'function') {
      window.returnToLaunchScreen();
    } else {
      showModeSelect();
    }
  });

  // Tournament: back returns to Tournament Home tab.
  document.getElementById('tournament-back-btn')?.addEventListener('click', () => {
    if (document.body.classList.contains('tournament') && typeof window.switchToPanel === 'function') {
      window.switchToPanel('panel-home');
      return;
    }
    // Fallback for non-tournament contexts
    showModeSelect();
  });

  // Quick Play role selector (Red ↔ Spectator ↔ Blue)
  // Click on a column selects that role. Arrow keys still cycle.
  const roleBox = document.getElementById('quick-seat-switcher');
  roleBox?.addEventListener('click', (e) => {
    const t = e?.target;
    if (t && (t.closest?.('button') || t.closest?.('a') || t.closest?.('input') || t.closest?.('select') || t.closest?.('textarea'))) {
      return;
    }
    selectQuickRole('spectator');
  }, { capture: true });
  roleBox?.addEventListener('pointerup', (e) => {
    const t = e?.target;
    if (t && (t.closest?.('button') || t.closest?.('a') || t.closest?.('input') || t.closest?.('select') || t.closest?.('textarea'))) {
      return;
    }
    selectQuickRole('spectator');
  }, { capture: true });
  roleBox?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectQuickRole('spectator');
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepQuickRole(-1);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepQuickRole(1);
    }
  });

  const redCol = document.getElementById('quick-red-col');
  const blueCol = document.getElementById('quick-blue-col');
  redCol?.addEventListener('click', () => selectQuickRole('red'));
  blueCol?.addEventListener('click', () => selectQuickRole('blue'));
  redCol?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectQuickRole('red'); }
  });
  blueCol?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectQuickRole('blue'); }
  });

  // Choose Operative vs Spymaster inside team boxes
  const redSeatOp = document.getElementById('quick-red-seat-operative');
  const redSeatSpy = document.getElementById('quick-red-seat-spymaster');
  const blueSeatOp = document.getElementById('quick-blue-seat-operative');
  const blueSeatSpy = document.getElementById('quick-blue-seat-spymaster');

  const bindSeat = (el, team, seatRole) => {
    if (!el) return;
    const go = (e) => {
      if (e?.type === 'keydown' && !(e.key === 'Enter' || e.key === ' ')) return;
      e?.preventDefault?.();
      e?.stopPropagation?.();

      // Requested UX:
      // - If you're already on Red/Blue, clicking the header "box" toggles between
      //   Operative <-> Spymaster (regardless of which header you clicked).
      // - If you're not on this team yet, clicking picks that specific role.
      if (selectedQuickTeam === team && (team === 'red' || team === 'blue')) {
        const next = (selectedQuickSeatRole === 'spymaster') ? 'operative' : 'spymaster';
        selectQuickSeat(team, next);
        return;
      }

      selectQuickSeat(team, seatRole);
    };
    el.addEventListener('click', go);
    el.addEventListener('keydown', go);
  };
  bindSeat(redSeatOp, 'red', 'operative');
  bindSeat(redSeatSpy, 'red', 'spymaster');
  bindSeat(blueSeatOp, 'blue', 'operative');
  bindSeat(blueSeatSpy, 'blue', 'spymaster');

  // Arrow keys anywhere in the lobby
  document.addEventListener('keydown', (e) => {
    if (currentPlayMode !== 'quick') return;
    const lobby = document.getElementById('quick-play-lobby');
    if (!lobby || lobby.style.display === 'none') return;
    const t = e?.target;
    if (t && (t.closest?.('button') || t.closest?.('a') || t.closest?.('input') || t.closest?.('select') || t.closest?.('textarea'))) {
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      stepQuickRole(-1);
    }
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      stepQuickRole(1);
    }

    // Up/Down (or W/S): switch between Spymaster and Operative
    if (e.key === 'ArrowUp' || e.key === 'w' || e.key === 'W') {
      e.preventDefault();
      stepQuickSeatRole('spymaster');
    }
    if (e.key === 'ArrowDown' || e.key === 's' || e.key === 'S') {
      e.preventDefault();
      stepQuickSeatRole('operative');
    }
  });


  // Quick Play game actions
  // Quick Play is a single lobby; no "create game" button.
  document.getElementById('quick-ready-btn')?.addEventListener('click', quickReadyOrJoin);
  document.getElementById('quick-leave-btn')?.addEventListener('click', leaveQuickLobby);

  // Quick Play settings
  document.getElementById('quick-settings-btn')?.addEventListener('click', openQuickSettingsModal);
  document.getElementById('quick-settings-close')?.addEventListener('click', closeQuickSettingsModal);
  document.getElementById('quick-settings-backdrop')?.addEventListener('click', closeQuickSettingsModal);
  document.getElementById('quick-settings-offer')?.addEventListener('click', offerQuickRulesFromModal);

  // Role selection
  document.getElementById('role-spymaster')?.addEventListener('click', () => selectRole('spymaster'));
  document.getElementById('role-operative')?.addEventListener('click', () => selectRole('operative'));

  // Clue form
  document.getElementById('clue-form')?.addEventListener('submit', handleClueSubmit);
  document.getElementById('clue-input')?.addEventListener('input', () => queueLiveClueDraftSync());
  document.getElementById('clue-input')?.addEventListener('blur', () => queueLiveClueDraftSync({ force: true }));
  document.getElementById('clue-stack-clear-btn')?.addEventListener('click', () => {
    clearClueTargetSelection({ refreshGame: true });
  });
  document.getElementById('clue-review-allow-btn')?.addEventListener('click', handleAllowPendingClue);
  document.getElementById('clue-review-challenge-btn')?.addEventListener('click', handleChallengePendingClue);
  document.getElementById('clue-review-modal-allow-btn')?.addEventListener('click', handleAllowPendingClue);
  document.getElementById('clue-review-modal-challenge-btn')?.addEventListener('click', handleChallengePendingClue);

  // End turn button
  document.getElementById('end-turn-btn')?.addEventListener('click', handleEndTurn);

  // OG Mode: Number minus button
  document.getElementById('og-num-minus')?.addEventListener('click', () => {
    const numInput = document.getElementById('clue-num-input');
    if (numInput) {
      const val = parseInt(numInput.value, 10) || 0;
      numInput.value = Math.max(0, val - 1);
      queueLiveClueDraftSync();
    }
  });
  document.getElementById('og-num-plus')?.addEventListener('click', () => {
    const numInput = document.getElementById('clue-num-input');
    if (numInput) {
      const val = parseInt(numInput.value, 10) || 0;
      numInput.value = Math.min(9, val + 1);
      queueLiveClueDraftSync();
    }
  });
  document.getElementById('clue-num-input')?.addEventListener('input', (e) => {
    const el = e.target;
    if (!el) return;
    const raw = String(el.value || '').replace(/[^\d]/g, '');
    if (!raw) {
      el.value = '';
      return;
    }
    const n = Math.max(0, Math.min(9, parseInt(raw, 10) || 0));
    el.value = String(n);
    queueLiveClueDraftSync();
  });

  // OG Mode: Settings button opens settings modal
  document.getElementById('og-settings-btn')?.addEventListener('click', () => {
    const modal = document.getElementById('settings-modal');
    if (modal) modal.classList.add('active');
  });

  // Leave game
  document.getElementById('leave-game-btn')?.addEventListener('click', handleLeaveGame);

  // End game (manual)
  document.getElementById('end-game-btn')?.addEventListener('click', handleEndGame);

  // Popover toggles
  setupGamePopovers();
  bindGameLogTabControls();

  if (!_stackingSettingsBindingReady) {
    _stackingSettingsBindingReady = true;
    window.addEventListener('codenames:stacking-setting-changed', () => {
      clueTargetSelection = [];
      try { renderGame(); } catch (_) {}
    });
  }

  // Rejoin game
  document.getElementById('rejoin-game-btn')?.addEventListener('click', rejoinCurrentGame);

  // Initial render - defer to current app mode
  if (document.body.classList.contains('tournament')) {
    showTournamentLobby();
  } else if (document.body.classList.contains('quickplay')) {
    showQuickPlayLobby();
  } else {
    showModeSelect();
  }
}

/* =========================
   Game Popovers (Log & Menu)
========================= */
function normalizeGameLogTab(tab) {
  return String(tab || '').trim().toLowerCase() === 'clues-left' ? 'clues-left' : 'history';
}

function applyGameLogTabState() {
  const activeTab = normalizeGameLogTab(gameLogActiveTab);
  const historyVisible = activeTab === 'history';
  const cluesVisible = activeTab === 'clues-left';

  const setDisplay = (el, show) => {
    if (!el) return;
    el.style.display = show ? '' : 'none';
  };

  setDisplay(document.getElementById('game-log-entries-sidebar'), historyVisible);
  setDisplay(document.getElementById('game-log-clues-left-sidebar'), cluesVisible);
  setDisplay(document.getElementById('og-gamelog-slidedown-entries'), historyVisible);
  setDisplay(document.getElementById('og-gamelog-slidedown-clues-left'), cluesVisible);

  const tabRoots = [
    document.getElementById('gamelog-tabs-sidebar'),
    document.getElementById('gamelog-tabs-slidedown'),
  ];
  tabRoots.forEach((root) => {
    if (!root) return;
    root.setAttribute('data-active-tab', activeTab);
    root.querySelectorAll('.gamelog-tab-btn[data-gamelog-tab]').forEach((btn) => {
      const tab = normalizeGameLogTab(btn.getAttribute('data-gamelog-tab'));
      const isActive = tab === activeTab;
      btn.classList.toggle('active', isActive);
      btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
    });
  });
}

function setGameLogTab(tab) {
  gameLogActiveTab = normalizeGameLogTab(tab);
  applyGameLogTabState();
}

function bindGameLogTabControls() {
  if (_gameLogTabBindingsReady) return;
  _gameLogTabBindingsReady = true;
  const selector = '.gamelog-tab-btn[data-gamelog-tab]';
  const activateTabFromEvent = (e) => {
    const btn = resolveBtn(e.target);
    if (!btn) return false;
    e.preventDefault();
    e.stopPropagation();
    setGameLogTab(btn.getAttribute('data-gamelog-tab'));
    return true;
  };
  const resolveBtn = (evtTarget) => {
    if (!evtTarget) return null;
    const base = (typeof evtTarget.closest === 'function')
      ? evtTarget
      : (evtTarget.parentElement || null);
    if (!base || typeof base.closest !== 'function') return null;
    return base.closest(selector);
  };

  // Direct binding for reliability on desktop/mobile (text-node targets, touch).
  const wireButtons = () => {
    document.querySelectorAll(selector).forEach((btn) => {
      if (!btn || btn.dataset.gamelogTabBound === '1') return;
      btn.dataset.gamelogTabBound = '1';
      btn.addEventListener('click', (e) => {
        activateTabFromEvent(e);
      });
      btn.addEventListener('pointerdown', (e) => {
        e.stopPropagation();
      });
      btn.addEventListener('touchend', (e) => {
        activateTabFromEvent(e);
      }, { passive: false });
    });
  };
  wireButtons();

  // Delegated fallback in case tab nodes are re-rendered.
  document.addEventListener('click', (e) => {
    activateTabFromEvent(e);
  });
  document.addEventListener('touchend', (e) => {
    activateTabFromEvent(e);
  }, { passive: false });
  document.addEventListener('pointerup', (e) => {
    activateTabFromEvent(e);
  });
}

function setupGamePopovers() {
  const logToggle = document.getElementById('game-log-toggle');
  const logPopover = document.getElementById('game-log');
  const logClose = document.getElementById('game-log-close');
  const menuToggle = document.getElementById('game-menu-toggle');
  const menuPopover = document.getElementById('game-menu');
  const backdrop = document.getElementById('popover-backdrop');

  function closeAllPopovers() {
    if (logPopover) logPopover.style.display = 'none';
    if (menuPopover) menuPopover.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  }

  logToggle?.addEventListener('click', () => {
    const isOpen = logPopover?.style.display === 'flex';
    closeAllPopovers();
    if (!isOpen && logPopover) {
      logPopover.style.display = 'flex';
      backdrop.style.display = 'block';
    }
  });

  logClose?.addEventListener('click', closeAllPopovers);

  menuToggle?.addEventListener('click', () => {
    const isOpen = menuPopover?.style.display === 'flex';
    closeAllPopovers();
    if (!isOpen && menuPopover) {
      menuPopover.style.display = 'flex';
      backdrop.style.display = 'block';
    }
  });

  backdrop?.addEventListener('click', closeAllPopovers);

  // Close popovers when clicking menu items
  document.getElementById('leave-game-btn')?.addEventListener('click', closeAllPopovers);
  document.getElementById('end-game-btn')?.addEventListener('click', closeAllPopovers);

  // OG Mode: Slide-down game log toggle
  setupOgGamelogSlidedown();
}

function setupOgGamelogSlidedown() {
  const toggleBtn = document.getElementById('og-gamelog-toggle-btn');
  const slidedown = document.getElementById('og-gamelog-slidedown');
  const closeBtn = document.getElementById('og-gamelog-close-btn');
  const panel = slidedown?.querySelector('.og-gamelog-slidedown-inner');
  const entryScrollAreas = slidedown ? Array.from(slidedown.querySelectorAll('.gamelog-entries')) : [];
  const chatToggleBtn = document.getElementById('og-chat-toggle-btn');
  const chatSlidedown = document.getElementById('og-chat-slidedown');
  const chatCloseBtn = document.getElementById('og-chat-close-btn');
  const chatPanel = chatSlidedown?.querySelector('.og-chat-slidedown-inner');
  const chatBody = document.getElementById('og-chat-slidedown-body');
  if (!toggleBtn || !slidedown) return;
  if (slidedown.dataset.bound === '1') return;
  slidedown.dataset.bound = '1';

  function openLog() {
    closeChat();
    slidedown.classList.add('open');
    toggleBtn.classList.add('og-gamelog-active');
    try { renderGameLog(); } catch (_) {}
    applyGameLogTabState();
  }

  function closeLog() {
    slidedown.classList.remove('open');
    toggleBtn.classList.remove('og-gamelog-active');
  }
  function openChat() {
    if (!chatSlidedown) return;
    closeLog();
    chatSlidedown.classList.add('open');
    chatToggleBtn?.classList.add('og-gamelog-active');
    markOgChatSeen();
    try { dockChatIntoOgPanels(document.body.classList.contains('cozy-mode') || document.body.classList.contains('og-mode')); } catch (_) {}
    // Scroll chat to bottom when opening
    requestAnimationFrame(() => {
      const chatContainer = document.getElementById('operative-chat-messages');
      if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
    });
  }
  function closeChat() {
    if (!chatSlidedown) return;
    chatSlidedown.classList.remove('open');
    chatToggleBtn?.classList.remove('og-gamelog-active');
    updateOgChatUnreadBadge();
    try { dockChatIntoOgPanels(document.body.classList.contains('cozy-mode') || document.body.classList.contains('og-mode')); } catch (_) {}
  }
  const isOpen = () => slidedown.classList.contains('open');
  const isChatOpen = () => !!chatSlidedown?.classList.contains('open');

  toggleBtn.addEventListener('click', () => {
    if (isOpen()) {
      closeLog();
    } else {
      openLog();
    }
  });
  chatToggleBtn?.addEventListener('click', () => {
    if (isChatOpen()) {
      closeChat();
    } else {
      openChat();
    }
  });

  closeBtn?.addEventListener('click', closeLog);
  chatCloseBtn?.addEventListener('click', closeChat);

  // Close when clicking outside the slidedown panel
  slidedown.addEventListener('click', (e) => {
    if (e.target === slidedown) closeLog();
  });
  chatSlidedown?.addEventListener('click', (e) => {
    if (e.target === chatSlidedown) closeChat();
  });

  document.addEventListener('pointerdown', (e) => {
    const target = e.target;
    if (!target) return;
    if (isOpen()) {
      if (!toggleBtn.contains(target) && !(panel && panel.contains(target))) {
        closeLog();
      }
    }
    if (isChatOpen()) {
      const clickedChatToggle = !!chatToggleBtn?.contains?.(target);
      if (!clickedChatToggle && !(chatPanel && chatPanel.contains(target))) {
        closeChat();
      }
    }
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (isOpen()) closeLog();
    if (isChatOpen()) closeChat();
  });

  // Keep scroll gestures inside slidedown scrollers while open.
  const isAtTop = (el) => el.scrollTop <= 0;
  const isAtBottom = (el) => (el.scrollHeight - el.clientHeight - el.scrollTop) <= 1;

  const bindScrollBoundaryLock = (el, isPanelOpen) => {
    if (!el) return;
    let touchStartY = 0;
    el.addEventListener('wheel', (e) => {
      if (!isPanelOpen()) return;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 0) {
        e.preventDefault();
        return;
      }
      if ((e.deltaY < 0 && isAtTop(el)) || (e.deltaY > 0 && isAtBottom(el))) {
        e.preventDefault();
      }
    }, { passive: false });

    el.addEventListener('touchstart', (e) => {
      touchStartY = e.touches?.[0]?.clientY ?? 0;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!isPanelOpen()) return;
      const y = e.touches?.[0]?.clientY;
      if (!Number.isFinite(y)) return;
      const dy = touchStartY - y;
      const maxScroll = el.scrollHeight - el.clientHeight;
      if (maxScroll <= 0) {
        e.preventDefault();
        return;
      }
      if ((dy < 0 && isAtTop(el)) || (dy > 0 && isAtBottom(el))) {
        e.preventDefault();
      }
    }, { passive: false });
  };

  entryScrollAreas.forEach((el) => bindScrollBoundaryLock(el, isOpen));
  const chatMessages = document.getElementById('operative-chat-messages');
  bindScrollBoundaryLock(chatMessages || chatBody, isChatOpen);
}

/* =========================
   Mode Navigation
========================= */
function showModeSelect() {
  // Safety: in Tournament mode, the Play tab should never show the mode chooser.
  if (document.body.classList.contains('tournament')) {
    showTournamentLobby();
    return;
  }
  // In Quick Play mode, the mode chooser is handled by the launch screen.
  if (document.body.classList.contains('quickplay')) {
    showQuickPlayLobby();
    return;
  }
  currentPlayMode = 'select';
  document.getElementById('play-mode-select').style.display = 'block';
  document.getElementById('quick-play-lobby').style.display = 'none';
  document.getElementById('tournament-lobby').style.display = 'none';
  document.getElementById('game-board-container').style.display = 'none';
  document.getElementById('panel-game').classList.remove('game-active');
  renderSpectateGames();
}

function showQuickPlayLobby() {
  currentPlayMode = 'quick';
  document.getElementById('play-mode-select').style.display = 'none';
  document.getElementById('quick-play-lobby').style.display = 'block';
  document.getElementById('tournament-lobby').style.display = 'none';
  document.getElementById('game-board-container').style.display = 'none';
  document.getElementById('panel-game').classList.remove('game-active');

  // Check if user has a name
  const userName = getUserName();
  const nameCheck = document.getElementById('quick-name-check');
  const setup = document.getElementById('quick-setup');

  if (!userName) {
    if (nameCheck) nameCheck.style.display = 'block';
    if (setup) setup.style.display = 'none';
    stopQuickLobbyListener();
  } else {
    if (nameCheck) nameCheck.style.display = 'none';
    if (setup) setup.style.display = 'block';
    startQuickLobbyListener();
  }
}

function showTournamentLobby() {
  currentPlayMode = 'tournament';
  document.getElementById('play-mode-select').style.display = 'none';
  document.getElementById('quick-play-lobby').style.display = 'none';
  document.getElementById('tournament-lobby').style.display = 'block';
  document.getElementById('game-board-container').style.display = 'none';
  document.getElementById('panel-game').classList.remove('game-active');
  renderTournamentLobby();
}

// Explicitly export mode navigation helpers for app.js.
// (Some hosting setups load scripts as modules or otherwise avoid attaching
// top-level declarations to window, which can make Quick Play entry look
// "broken" by leaving users on the generic mode chooser.)
window.showModeSelect = showModeSelect;
window.showQuickPlayLobby = showQuickPlayLobby;
window.showTournamentLobby = showTournamentLobby;

/* =========================
   Quick Play Role Selection
========================= */
const QUICK_ROLES = ['red', 'spectator', 'blue'];

function selectQuickRole(role) {
  selectedQuickTeam = role;

  const hint = document.getElementById('team-select-hint');

  applyQuickRoleHighlight(role);

  if (hint) {
    hint.textContent = role === 'spectator'
      ? 'Spectating — switch to Red or Blue to play.'
      : (role === 'red' ? 'You will play as Red Team' : 'You will play as Blue Team');
    hint.style.color = role === 'red' ? 'var(--game-red)' : role === 'blue' ? 'var(--game-blue)' : '';
  }

  // Highlight seat selection only when on a team.
  clearQuickSeatHighlights();
  if (role === 'red' || role === 'blue') {
    applyQuickSeatHighlight(role, selectedQuickSeatRole);
  }

  // In an active game with Active Join enabled, selecting a team should not auto-join.
  // Let the player confirm by pressing the Join button.
  const g = latestQuickGame;
  const youRole = g ? getQuickPlayerRole(g, getUserId()) : null;
  const inProgress = !!(g && g.currentPhase && g.currentPhase !== 'waiting' && g.winner == null);
  if (inProgress && isActiveJoinOn(g) && (youRole !== 'red' && youRole !== 'blue')) {
    if (hint && role !== 'spectator') hint.textContent += ' — click Join to enter.';
    return;
  }

  // Join the lobby for the selected role.
  joinQuickLobby(role, selectedQuickSeatRole);
}

function applyQuickRoleHighlight(role) {
  const redCol = document.getElementById('quick-red-col');
  const blueCol = document.getElementById('quick-blue-col');
  const specCol = document.getElementById('quick-seat-switcher');
  redCol?.classList.toggle('selected', role === 'red');
  blueCol?.classList.toggle('selected', role === 'blue');
  specCol?.classList.toggle('selected', role === 'spectator');
}

function stepQuickRole(delta) {
  const current = selectedQuickTeam || 'spectator';
  let idx = QUICK_ROLES.indexOf(current);
  if (idx === -1) idx = 1;
  idx = (idx + delta + QUICK_ROLES.length) % QUICK_ROLES.length;
  selectQuickRole(QUICK_ROLES[idx]);
}

function applyQuickSeatHighlight(team, seatRole) {
  const ids = {
    red: { operative: 'quick-red-seat-operative', spymaster: 'quick-red-seat-spymaster' },
    blue: { operative: 'quick-blue-seat-operative', spymaster: 'quick-blue-seat-spymaster' },
  };
  const t = ids[team];
  if (!t) return;
  const op = document.getElementById(t.operative);
  const sp = document.getElementById(t.spymaster);
  op?.classList.toggle('selected', team === selectedQuickTeam && seatRole === 'operative');
  sp?.classList.toggle('selected', team === selectedQuickTeam && seatRole === 'spymaster');
}

function clearQuickSeatHighlights() {
  const all = [
    'quick-red-seat-operative', 'quick-red-seat-spymaster',
    'quick-blue-seat-operative', 'quick-blue-seat-spymaster',
  ];
  for (const id of all) {
    document.getElementById(id)?.classList.remove('selected');
  }
}

function getQuickPlayerSeatRole(game, odId) {
  const team = getQuickPlayerRole(game, odId);
  if (team !== 'red' && team !== 'blue') return null;
  const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
  const players = Array.isArray(game?.[key]) ? game[key] : [];
  const me = players.find(p => p?.odId === odId);
  const r = String(me?.role || 'operative');
  return (r === 'spymaster') ? 'spymaster' : 'operative';
}

function stepQuickSeatRole(targetRole) {
  // Only applies when you're on Red/Blue in Quick Play.
  if (selectedQuickTeam !== 'red' && selectedQuickTeam !== 'blue') return;
  const next = (targetRole === 'spymaster') ? 'spymaster' : 'operative';
  selectQuickSeat(selectedQuickTeam, next);
}

function selectQuickSeat(team, seatRole) {
  const nextTeam = (team === 'red' || team === 'blue') ? team : 'spectator';
  const nextSeat = (seatRole === 'spymaster') ? 'spymaster' : 'operative';
  selectedQuickSeatRole = nextSeat;

  // If you're already on that team, update the seat without resetting readiness.
  if (selectedQuickTeam === nextTeam && (nextTeam === 'red' || nextTeam === 'blue')) {
    setQuickSeatRole(nextSeat);
    return;
  }

  // Otherwise, join the team and apply the seat.
  selectedQuickTeam = nextTeam;
  applyQuickRoleHighlight(nextTeam);
  clearQuickSeatHighlights();
  applyQuickSeatHighlight(nextTeam, nextSeat);
  joinQuickLobby(nextTeam, nextSeat);
}


function setQuickDeckSelectionUI(deckId) {
  const id = normalizeDeckId(deckId);
  const hidden = document.getElementById('qp-deck');
  if (hidden) hidden.value = id;

  // New compact UI (dropdown)
  const sel = document.getElementById('qp-deck-select');
  if (sel) sel.value = id;

  const picker = document.getElementById('qp-deck-picker');
  if (!picker) return;
  const cards = [...picker.querySelectorAll('.qp-deck-card')];
  cards.forEach(btn => {
    const match = btn.getAttribute('data-deck') === id;
    btn.classList.toggle('selected', match);
    btn.setAttribute('aria-checked', match ? 'true' : 'false');
  });
}

function initQuickDeckPicker() {
  // Preferred compact UI: dropdown
  const sel = document.getElementById('qp-deck-select');
  if (sel) {
    // Disable any decks that aren't present in words.json
    [...sel.querySelectorAll('option')].forEach((opt) => {
      const id = opt.value;
      const ok = (id === 'standard') || (wordsDecks && wordsDecks[id] && Array.isArray(wordsDecks[id]) && wordsDecks[id].length >= 25);
      opt.disabled = !ok;
    });

    sel.addEventListener('change', () => {
      setQuickDeckSelectionUI(sel.value || 'standard');
      if (quickLobbyGame) updateQuickRulesUI(quickLobbyGame);
    });

    // default
    setQuickDeckSelectionUI(document.getElementById('qp-deck')?.value || sel.value || 'standard');
    return;
  }

  // Backward-compatible UI: card picker
  const picker = document.getElementById('qp-deck-picker');
  if (!picker) return;
  const cards = [...picker.querySelectorAll('.qp-deck-card')];
  if (!cards.length) return;

  // Disable any decks that aren't present in words.json
  cards.forEach(btn => {
    const id = btn.getAttribute('data-deck');
    const ok = (id === 'standard') || (wordsDecks && wordsDecks[id] && Array.isArray(wordsDecks[id]) && wordsDecks[id].length >= 25);
    btn.disabled = !ok;
    btn.classList.toggle('disabled', !ok);
  });

  cards.forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.disabled) return;
      const id = btn.getAttribute('data-deck') || 'standard';
      setQuickDeckSelectionUI(id);
      // Update any previews immediately
      if (quickLobbyGame) updateQuickRulesUI(quickLobbyGame);
    });
  });

  // default
  setQuickDeckSelectionUI(document.getElementById('qp-deck')?.value || 'standard');
}

function setModalVisible(id, visible) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.display = visible ? 'block' : 'none';
  el.setAttribute('aria-hidden', visible ? 'false' : 'true');
}

function openQuickSettingsModal() {
  const modal = document.getElementById('quick-settings-modal');
  if (!modal) {
    console.error('Quick settings modal not found');
    return;
  }

  modal.style.display = 'flex';
  void modal.offsetWidth; // Trigger reflow for animation
  modal.classList.add('modal-open');
  modal.setAttribute('aria-hidden', 'false');

  // Fill current values from the live lobby if we have it.
  const g = quickLobbyGame;
  const s = getQuickSettings(g);

  const blackCardsEl = document.getElementById('qp-black-cards');
  const clueTimerEl = document.getElementById('qp-clue-timer');
  const guessTimerEl = document.getElementById('qp-guess-timer');
  const stackingToggleEl = document.getElementById('qp-stacking-toggle');

  if (blackCardsEl) blackCardsEl.value = String(s.blackCards ?? 1);
  if (clueTimerEl) clueTimerEl.value = String(s.clueTimerSeconds ?? 0);
  if (guessTimerEl) guessTimerEl.value = String(s.guessTimerSeconds ?? 0);
  if (stackingToggleEl) stackingToggleEl.checked = s.stackingEnabled !== false;
  setQuickDeckSelectionUI(s.deckId || 'standard');

  const vibeEl = document.getElementById('qp-vibe');
  if (vibeEl) vibeEl.value = s.vibe || '';

  updateQuickRulesUI(g);
}

function closeQuickSettingsModal() {
  const modal = document.getElementById('quick-settings-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
  modal.setAttribute('aria-hidden', 'true');
}

function updateQuickRulesUI(game) {
  const summaryEl = document.getElementById('quick-rules-summary');
  const summaryTextEl = document.getElementById('quick-rules-text');
  const summaryBadgeEl = document.getElementById('quick-rules-badge');
  const hintEl = document.getElementById('quick-lobby-hint');

  const modalStatus = document.getElementById('quick-settings-status');
  const applyBtn = document.getElementById('quick-settings-offer');

  const odId = getUserId();
  const myRole = game ? getQuickPlayerRole(game, odId) : null;
  const myTeam = (myRole === 'red' || myRole === 'blue') ? myRole : null;

  const rulesText = `Rules: ${formatQuickRules(getQuickSettings(game))}`;
  if (summaryTextEl) summaryTextEl.textContent = rulesText;
  else if (summaryEl) summaryEl.textContent = rulesText;

  if (summaryBadgeEl) {
    summaryBadgeEl.dataset.state = 'live';
    summaryBadgeEl.textContent = 'Rules';
  }

  if (hintEl) hintEl.textContent = '';

  // Settings modal
  if (applyBtn) {
    applyBtn.disabled = !myTeam;
    // Keep button visible but disabled until the player is on a team.
    applyBtn.textContent = 'Apply';
  }
  if (modalStatus) {
    modalStatus.textContent = myTeam ? 'Changes apply immediately (no agreement step).' : '';
  }
}

async function offerQuickRulesFromModal() {
  // (Legacy name kept) Apply Quick Play settings immediately.
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  const odId = getUserId();
  const settings = readQuickSettingsFromUI();
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Lobby not found');
      const game = snap.data();
      if (game.currentPhase && game.currentPhase !== 'waiting') throw new Error('Game already started.');
      const role = getQuickPlayerRole(game, odId);
      if (role !== 'red' && role !== 'blue') throw new Error('Only team members can change settings.');

      // Any settings change resets readiness so the lobby restarts clean.
      const nextRed = (game.redPlayers || []).map(p => ({ ...p, ready: false }));
      const nextBlue = (game.bluePlayers || []).map(p => ({ ...p, ready: false }));

      const updates = {
        quickSettings: { ...settings },
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        log: firebase.firestore.FieldValue.arrayUnion(`${role.toUpperCase()} updated rules: ${formatQuickRules(settings)}`)
      };

      // Clean up any legacy negotiation fields if they exist.
      updates.settingsPending = firebase.firestore.FieldValue.delete();
      updates.settingsAccepted = firebase.firestore.FieldValue.delete();

      tx.update(ref, updates);
    });
    closeQuickSettingsModal();
  } catch (e) {
    console.error('Apply rules failed:', e);
    alert(e.message || 'Failed to apply rules.');
  }
}



/* =========================
   Quick Play Game Management
========================= */
function listenToQuickPlayDoc() {
  // Pre-warm the Quick Play singleton doc so the lobby is ready.
  ensureQuickPlayGameExists().catch((e) => console.warn('Quick Play prewarm failed', e));
}

function stopQuickLobbyListener() {
  quickLobbyListenerWanted = false;
  if (quickLobbyUnsub) quickLobbyUnsub();
  quickLobbyUnsub = null;
  quickLobbyGame = null;
  renderQuickLobby(null);
}

async function startQuickLobbyListener() {
  quickLobbyListenerWanted = true;
  if (quickLobbyUnsub) return;
  if (quickLobbyListenerStarting) return quickLobbyListenerStarting;

  quickLobbyListenerStarting = (async () => {
    await ensureQuickPlayGameExists();
    if (!quickLobbyListenerWanted || quickLobbyUnsub) return;

    const unsub = db.collection('games').doc(QUICKPLAY_DOC_ID).onSnapshot((snap) => {
      if (!snap.exists) {
        quickLobbyGame = null;
        renderQuickLobby(null);
        return;
      }
      quickLobbyGame = { id: snap.id, ...snap.data() };

      // Check for game inactivity (30+ minutes) - end the game
      checkAndEndInactiveGame(quickLobbyGame);

      // Check for inactive players in lobby and remove them
      checkAndRemoveInactiveLobbyPlayers(quickLobbyGame);

      // If the game has zero players, end/reset it.
      checkAndEndEmptyQuickPlayGame(quickLobbyGame);

      // If a Quick Play game is in-progress, jump into it if you're in the lobby
      // (including spectators).
      if (quickLobbyGame.currentPhase && quickLobbyGame.currentPhase !== 'waiting' && quickLobbyGame.winner == null) {
        const odId = getUserId();
        const inRed = (quickLobbyGame.redPlayers || []).some(p => p.odId === odId);
        const inBlue = (quickLobbyGame.bluePlayers || []).some(p => p.odId === odId);
        const inSpec = (quickLobbyGame.spectators || []).some(p => p.odId === odId);
        if (inRed || inBlue || inSpec) {
          const targetSpectatorMode = !!inSpec && !(inRed || inBlue);
          const alreadyListeningToSameGame =
            !!gameUnsub &&
            String(currentGame?.id || '') === String(quickLobbyGame.id || '') &&
            spectatorMode === targetSpectatorMode;
          if (!alreadyListeningToSameGame) {
            spectatorMode = targetSpectatorMode;
            spectatingGameId = targetSpectatorMode ? quickLobbyGame.id : null;
            startGameListener(quickLobbyGame.id, { spectator: targetSpectatorMode });
          }
          return;
        }
      }

      if (currentPlayMode === 'quick') {
        // Keep a shared, doc-derived list of AI players so all clients can render them
        // and (optionally) act as the AI controller.
        if (window.syncAIPlayersFromGame) window.syncAIPlayersFromGame(quickLobbyGame);

        renderQuickLobby(quickLobbyGame);
        maybeAutoStartQuickPlay(quickLobbyGame);
      }
    }, (err) => console.error('Quick Play lobby listener error:', err));

    quickLobbyUnsub = () => {
      try { unsub(); } catch (_) {}
    };
  })()
    .catch((e) => {
      console.error('Quick Play lobby listener startup failed:', e);
    })
    .finally(() => {
      quickLobbyListenerStarting = null;
    });

  return quickLobbyListenerStarting;
}

// Game inactivity timeout: end games that have been inactive for 30+ minutes
const GAME_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
let lastInactiveGameCheck = 0;

// Practice inactivity timeout: auto-close practice tab after 10 minutes of no activity
const PRACTICE_INACTIVITY_MS = 10 * 60 * 1000; // 10 minutes
let practiceInactivityTimer = null;
let practiceActivityBound = false;
let practiceLastActivityAt = 0;
let practiceAutoClosed = false;

function isPracticeActive() {
  return !!(currentGame && currentGame.type === 'practice');
}

function markPracticeActivity() {
  if (!isPracticeActive()) return;
  const now = Date.now();
  if (now - practiceLastActivityAt < 1000) return;
  practiceLastActivityAt = now;
  resetPracticeInactivityTimer();
}

function resetPracticeInactivityTimer() {
  if (practiceInactivityTimer) clearTimeout(practiceInactivityTimer);
  practiceInactivityTimer = setTimeout(() => {
    if (!isPracticeActive()) return;
    const now = Date.now();
    if (now - practiceLastActivityAt >= PRACTICE_INACTIVITY_MS) {
      autoClosePracticeGame();
      return;
    }
    resetPracticeInactivityTimer();
  }, PRACTICE_INACTIVITY_MS + 250);
}

function startPracticeInactivityWatcher() {
  if (!isPracticeActive()) return;
  if (!practiceActivityBound) {
    const handler = markPracticeActivity;
    window.addEventListener('pointerdown', handler, { passive: true });
    window.addEventListener('keydown', handler, { passive: true });
    window.addEventListener('mousemove', handler, { passive: true });
    window.addEventListener('wheel', handler, { passive: true });
    window.addEventListener('touchstart', handler, { passive: true });
    window.addEventListener('scroll', handler, { passive: true });
    window.addEventListener('focus', handler, { passive: true });
    practiceActivityBound = true;
  }
  practiceAutoClosed = false;
  if (!practiceLastActivityAt) practiceLastActivityAt = Date.now();
  resetPracticeInactivityTimer();
}

function stopPracticeInactivityWatcher() {
  if (practiceInactivityTimer) clearTimeout(practiceInactivityTimer);
  practiceInactivityTimer = null;
  practiceLastActivityAt = 0;
  practiceAutoClosed = false;
  if (practiceActivityBound) {
    const handler = markPracticeActivity;
    window.removeEventListener('pointerdown', handler);
    window.removeEventListener('keydown', handler);
    window.removeEventListener('mousemove', handler);
    window.removeEventListener('wheel', handler);
    window.removeEventListener('touchstart', handler);
    window.removeEventListener('scroll', handler);
    window.removeEventListener('focus', handler);
    practiceActivityBound = false;
  }
}

function autoClosePracticeGame() {
  if (!isPracticeActive() || practiceAutoClosed) return;
  practiceAutoClosed = true;
  try { handleLeaveGame({ skipConfirm: true, closePracticeWindow: true }); } catch (_) {}
}

async function checkAndEndInactiveGame(game) {
  if (!game) return;

  // Only check in-progress games
  if (!game.currentPhase || game.currentPhase === 'waiting' || game.winner != null) return;

  // Throttle checks to once per minute
  const now = Date.now();
  if (now - lastInactiveGameCheck < 60000) return;
  lastInactiveGameCheck = now;

  // Check last update time
  const updatedAt = game.updatedAt;
  if (!updatedAt) return;

  const lastMs = typeof updatedAt.toMillis === 'function'
    ? updatedAt.toMillis()
    : (updatedAt.seconds ? updatedAt.seconds * 1000 : 0);

  if (!lastMs) return;

  const diff = now - lastMs;
  if (diff < GAME_INACTIVITY_MS) return;

  // Game has been inactive for 30+ minutes, end it
  console.log('Game inactive for 30+ minutes, ending...');
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);

  try {
    // Generate game data outside transaction (may involve async LLM call)
    const uiSettings = readQuickSettingsFromUI();
    const newGameData = await buildQuickPlayGameData(uiSettings);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const g = snap.data();
      // Double-check the game is still inactive
      if (g.winner != null || g.currentPhase === 'waiting') return;

      const gUpdatedAt = g.updatedAt;
      const gLastMs = typeof gUpdatedAt?.toMillis === 'function'
        ? gUpdatedAt.toMillis()
        : (gUpdatedAt?.seconds ? gUpdatedAt.seconds * 1000 : 0);

      if (Date.now() - gLastMs < GAME_INACTIVITY_MS) return;

      tx.set(ref, {
        ...newGameData,
        log: ['Previous game ended due to inactivity (30+ minutes).']
      });
    });
  } catch (e) {
    console.warn('Failed to end inactive game:', e);
  }
}

// Remove inactive players from lobby
const LOBBY_INACTIVE_MS = 5 * 60 * 1000; // 5 minutes (same as presence inactive threshold)
let lastInactivePlayerCheck = 0;

async function checkAndRemoveInactiveLobbyPlayers(game) {
  if (!game) return;

  // Only check lobby (waiting state)
  if (game.currentPhase !== 'waiting') return;

  // Throttle checks to once per 30 seconds
  const now = Date.now();
  if (now - lastInactivePlayerCheck < 30000) return;
  lastInactivePlayerCheck = now;

  // Get presence data from app.js
  const presenceData = window.presenceCache || [];
  if (!presenceData.length) return;

  // Create a map of odId to presence status
  const presenceMap = new Map();
  for (const p of presenceData) {
    const status = window.getPresenceStatus ? window.getPresenceStatus(p) : 'online';
    presenceMap.set(p.odId || p.id, status);
  }

  // Check all players in the lobby
  const redPlayers = game.redPlayers || [];
  const bluePlayers = game.bluePlayers || [];
  const spectators = game.spectators || [];

  // Find inactive/offline players
  const inactivePlayers = [];

  for (const p of [...redPlayers, ...bluePlayers, ...spectators]) {
    // Never remove AI players
    if (p.isAI) continue;
    const status = presenceMap.get(p.odId);
    // Remove players who are inactive or offline (or not in presence at all)
    if (!status || status === 'idle' || status === 'offline') {
      inactivePlayers.push(p.odId);
    }
  }

  if (inactivePlayers.length === 0) return;

  // Remove inactive players from the lobby
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;

      const g = snap.data();
      if (g.currentPhase !== 'waiting') return;

      const nextRed = (g.redPlayers || []).filter(p => !inactivePlayers.includes(p.odId));
      const nextBlue = (g.bluePlayers || []).filter(p => !inactivePlayers.includes(p.odId));
      const nextSpec = (g.spectators || []).filter(p => !inactivePlayers.includes(p.odId));

      // Only update if something changed
      const beforeCount = (g.redPlayers?.length || 0) + (g.bluePlayers?.length || 0) + (g.spectators?.length || 0);
      const afterCount = nextRed.length + nextBlue.length + nextSpec.length;

      if (beforeCount === afterCount) return;

      tx.update(ref, {
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        spectators: nextSpec,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      console.log(`Removed ${beforeCount - afterCount} inactive player(s) from lobby. Rules reset.`);
    });
  } catch (e) {
    console.warn('Failed to remove inactive players:', e);
  }
}



// If everyone leaves Quick Play, end/reset the game so the next person gets a fresh lobby.
const EMPTY_QUICK_GAME_THROTTLE_MS = 15000;
let lastEmptyQuickGameCheck = 0;

async function checkAndEndEmptyQuickPlayGame(game) {
  if (!game) return;
  if (game.id && game.id !== QUICKPLAY_DOC_ID) return;

  const totalPlayers = (game.redPlayers?.length || 0) + (game.bluePlayers?.length || 0) + (game.spectators?.length || 0);
  if (totalPlayers !== 0) return;

  // An empty lobby is already "ended" (waiting). Only reset if a game was in progress.
  if (!game.currentPhase || game.currentPhase === 'waiting') return;

  const now = Date.now();
  if (now - lastEmptyQuickGameCheck < EMPTY_QUICK_GAME_THROTTLE_MS) return;
  lastEmptyQuickGameCheck = now;

  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    // Generate game data outside transaction (may involve async LLM call)
    const uiSettings = readQuickSettingsFromUI();
    const newGameData = await buildQuickPlayGameData(uiSettings);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();

      const total = (g.redPlayers?.length || 0) + (g.bluePlayers?.length || 0) + (g.spectators?.length || 0);
      if (total !== 0) return;
      if (!g.currentPhase || g.currentPhase === 'waiting') return;

      tx.set(ref, {
        ...newGameData,
        log: ['Previous game ended because all players left.']
      });
    });
  } catch (e) {
    console.warn('Failed to end empty Quick Play game:', e);
  }
}

async function buildQuickPlayGameData(settings = { blackCards: 1, clueTimerSeconds: 0, guessTimerSeconds: 0 }) {
  const firstTeam = 'red';
  const cards = await buildQuickPlayCardsFromSettings(settings);

  return {
    type: 'quick',
    activeJoinOn: true,
    roomCode: null,
    redTeamId: null,
    redTeamName: 'Red Team',
    blueTeamId: null,
    blueTeamName: 'Blue Team',
    redPlayers: [],
    bluePlayers: [],
    spectators: [],
    cards,
    // Team-visible markers (reset each game)
    redMarkers: {},
    blueMarkers: {},
    // Team-visible "currently considering" chips
    redConsidering: {},
    blueConsidering: {},
    currentTeam: firstTeam,
    currentPhase: 'waiting',
    redSpymaster: null,
    blueSpymaster: null,
    redCardsLeft: FIRST_TEAM_CARDS,
    blueCardsLeft: SECOND_TEAM_CARDS,
    currentClue: null,
    pendingClue: null,
    liveClueDraft: null,
    guessesRemaining: 0,
    timerEnd: null,
    quickSettings: {
      blackCards: settings.blackCards,
      clueTimerSeconds: settings.clueTimerSeconds,
      guessTimerSeconds: settings.guessTimerSeconds,
      stackingEnabled: settings.stackingEnabled !== false,
      deckId: normalizeDeckId(settings.deckId || 'standard'),
      vibe: settings.vibe || '',
    },
    log: [],
    winner: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

async function ensureQuickPlayGameExists() {
  if (quickPlayEnsurePromise) return quickPlayEnsurePromise;

  quickPlayEnsurePromise = (async () => {
    const uiSettings = readQuickSettingsFromUI();
    const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
    const snap = await ref.get();

    if (!snap.exists) {
      await ref.set(await buildQuickPlayGameData(uiSettings));
      return;
    }

    const g = snap.data();
    const shouldReset = !!g.winner || g.currentPhase === 'ended' || !Array.isArray(g.cards) || g.cards.length !== BOARD_SIZE;
    if (shouldReset) {
      await ref.set(await buildQuickPlayGameData(uiSettings));
      return;
    }

    // Backfill settings fields if this doc predates the settings system.
    const updates = {};
    if (!g.quickSettings) {
      updates.quickSettings = {
        blackCards: 1,
        clueTimerSeconds: 0,
        guessTimerSeconds: 0,
        stackingEnabled: true,
        deckId: 'standard',
        vibe: '',
      };
    } else if (typeof g.quickSettings.stackingEnabled === 'undefined') {
      updates.quickSettings = {
        ...g.quickSettings,
        stackingEnabled: true
      };
    }
    // Remove legacy negotiation fields if present.
    if (typeof g.settingsAccepted !== 'undefined') updates.settingsAccepted = firebase.firestore.FieldValue.delete();
    if (typeof g.settingsPending !== 'undefined') updates.settingsPending = firebase.firestore.FieldValue.delete();
    if (typeof g.activeJoinOn === 'undefined') updates.activeJoinOn = true;
    if (Object.keys(updates).length) {
      await ref.update({ ...updates, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    }
  })().finally(() => {
    quickPlayEnsurePromise = null;
  });

  return quickPlayEnsurePromise;
}

function getQuickPlayerRole(game, odId) {
  const inRed = (game.redPlayers || []).some(p => p.odId === odId);
  const inBlue = (game.bluePlayers || []).some(p => p.odId === odId);
  const inSpec = (game.spectators || []).some(p => p.odId === odId);
  if (inRed) return 'red';
  if (inBlue) return 'blue';
  if (inSpec) return 'spectator';
  return null;
}

function isActiveJoinOn(game) {
  return !!(game && (
    game.activeJoinOn === true ||
    (game.quickSettings && game.quickSettings.activeJoinOn === true) ||
    (game.settings && game.settings.activeJoinOn === true)
  ));
}

async function joinQuickLobby(role, seatRole) {
  const userName = getUserName();
  const odId = getUserId();
  if (!userName) return;

  await ensureQuickPlayGameExists();

  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Quick Play lobby not found');

      const game = snap.data();

      const activeJoinOn = isActiveJoinOn(game);

      const inProgress = !!(game.currentPhase && game.currentPhase !== 'waiting' && game.winner == null);
      const currentRole = getQuickPlayerRole(game, odId);
      const joiningTeam = (role === 'red' || role === 'blue');
      const alreadyOnTeam = (currentRole === 'red' || currentRole === 'blue');

      // Allow late spectator joins and allow existing team players to switch seats/teams.
      // Block only brand-new team joins while Active Join is off.
      if (inProgress && !activeJoinOn && joiningTeam && !alreadyOnTeam) {
        throw new Error('Quick Play is in progress. Late team join is off right now.');
      }

      const redPlayers = Array.isArray(game.redPlayers) ? [...game.redPlayers] : [];
      const bluePlayers = Array.isArray(game.bluePlayers) ? [...game.bluePlayers] : [];
      const spectators = Array.isArray(game.spectators) ? [...game.spectators] : [];

      // Remove from all seats (team-switching / rejoin).
      const nextRed = redPlayers.filter(p => p.odId !== odId);
      const nextBlue = bluePlayers.filter(p => p.odId !== odId);
      const nextSpec = spectators.filter(p => p.odId !== odId);

      const seat = (seatRole === 'spymaster') ? 'spymaster' : 'operative';
      const player = { odId, name: userName, ready: false, role: seat };
      if (role === 'red') nextRed.push(player);
      else if (role === 'blue') nextBlue.push(player);
      else nextSpec.push(player);

      const updates = {
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        spectators: nextSpec,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      // If the lobby is fresh, seed the lobby's quickSettings from the joiner's UI.
      const prevCount = redPlayers.length + bluePlayers.length + spectators.length;
      if (prevCount === 0) {
        const ui = readQuickSettingsFromUI();
        updates.quickSettings = { ...ui };
      }

      // Clean up any legacy negotiation fields if they exist.
      updates.settingsAccepted = firebase.firestore.FieldValue.delete();
      updates.settingsPending = firebase.firestore.FieldValue.delete();

      tx.update(ref, updates);
    });

    selectedQuickTeam = role;
    if (role === 'red' || role === 'blue') {
      selectedQuickSeatRole = (seatRole === 'spymaster') ? 'spymaster' : 'operative';
    }
    quickAutoJoinedSpectator = true;
    // Play join sound
    if (window.playSound) window.playSound('join');
  } catch (e) {
    console.error('Failed to join Quick Play lobby:', e);
    alert(e.message || 'Failed to join lobby.');
  }
}

async function setQuickSeatRole(seatRole) {
  const odId = getUserId();
  const userName = getUserName();
  if (!userName) return;

  const nextSeat = (seatRole === 'spymaster') ? 'spymaster' : 'operative';
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Lobby not found');
      const game = snap.data();
      if (game.currentPhase && game.currentPhase !== 'waiting' && game.winner == null) {
        throw new Error('Game is in progress. You can switch roles next game.');
      }

      const team = getQuickPlayerRole(game, odId);
      if (team !== 'red' && team !== 'blue') throw new Error('Join a team first.');
      const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
      const players = Array.isArray(game[key]) ? [...game[key]] : [];
      const idx = players.findIndex(p => p.odId === odId);
      if (idx === -1) throw new Error('Join a team first.');

      // Preserve readiness, just switch seat.
      players[idx] = { ...players[idx], role: nextSeat };
      tx.update(ref, {
        [key]: players,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    selectedQuickSeatRole = nextSeat;
    clearQuickSeatHighlights();
    if (selectedQuickTeam === 'red' || selectedQuickTeam === 'blue') {
      applyQuickSeatHighlight(selectedQuickTeam, nextSeat);
    }
  } catch (e) {
    console.error('Failed to set Quick Play seat role:', e);
    alert(e.message || 'Failed to switch role.');
  }
}

// Back-compat for any older UI that still calls joinQuickGame(gameId, team).
// Quick Play is a single lobby/game, so we ignore gameId.
function joinQuickGame(_gameId, preferredTeam = null) {
  const team = preferredTeam || selectedQuickTeam;
  if (!team) {
    alert('Please select a team first.');
    return;
  }
  joinQuickLobby(team, selectedQuickSeatRole);
}

async function leaveQuickLobby() {
  const odId = getUserId();
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data();

      // If game is in progress, use normal leave-game flow.
      if (game.currentPhase && game.currentPhase !== 'waiting' && game.winner == null) {
        return;
      }

      const nextRed = (game.redPlayers || []).filter(p => p.odId !== odId);
      const nextBlue = (game.bluePlayers || []).filter(p => p.odId !== odId);
      const nextSpec = (game.spectators || []).filter(p => p.odId !== odId);
      tx.update(ref, {
        redPlayers: nextRed,
        bluePlayers: nextBlue,
        spectators: nextSpec,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } finally {
    selectedQuickTeam = null;
    quickAutoJoinedSpectator = false;
    // Update role UI back to spectator highlight
    applyQuickRoleHighlight('spectator');

    // Play leave sound
    if (window.playSound) window.playSound('leave');

    // Return to the initial Choose Mode screen.
    currentPlayMode = 'select';
    try {
      document.getElementById('quick-play-lobby')?.style && (document.getElementById('quick-play-lobby').style.display = 'none');
    } catch (_) {}
    try { window.returnToLaunchScreen?.(); } catch (_) {}
  }
}

async function toggleQuickReady() {
  const odId = getUserId();
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Lobby not found');
      const game = snap.data();
      if (game.currentPhase && game.currentPhase !== 'waiting') return;

      const role = getQuickPlayerRole(game, odId);
      if (!role || role === 'spectator') throw new Error('Switch to Red or Blue to ready up.');

      const key = role === 'red' ? 'redPlayers' : 'bluePlayers';
      const players = Array.isArray(game[key]) ? [...game[key]] : [];
      const idx = players.findIndex(p => p.odId === odId);
      if (idx === -1) throw new Error('Join a team first.');

      const current = players[idx];
      players[idx] = { ...current, ready: !current.ready };

      tx.update(ref, {
        [key]: players,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    // Play ready sound
    if (window.playSound) window.playSound('ready');
  } catch (e) {
    console.error('Failed to toggle ready:', e);
    alert(e.message || 'Failed to ready up.');
  }
}

async function quickReadyOrJoin() {
  const g = latestQuickGame;
  const odId = getUserId();
  const youRole = g ? getQuickPlayerRole(g, odId) : null;
  const inProgress = !!(g && g.currentPhase && g.currentPhase !== 'waiting' && g.winner == null);

  // Join as spectator during active game
  if (inProgress && (selectedQuickTeam === 'spectator' || youRole === 'spectator' || (!youRole && !selectedQuickTeam))) {
    await joinQuickLobby('spectator');
    return;
  }

  if (inProgress && isActiveJoinOn(g) && (youRole !== 'red' && youRole !== 'blue')) {
    const role = selectedQuickTeam || 'spectator';
    if (role !== 'red' && role !== 'blue') {
      alert('Switch to Red or Blue to join.');
      return;
    }
    const seatRole = selectedQuickSeatRole || 'operative';
    await joinQuickLobby(role, seatRole);
    return;
  }

  await toggleQuickReady();
}

function teamHasRequiredRoles(players) {
  const list = Array.isArray(players) ? players : [];
  const hasSpymaster = list.some(p => String(p?.role || 'operative') === 'spymaster');
  const hasOperative = list.some(p => String(p?.role || 'operative') === 'operative');
  return hasSpymaster && hasOperative;
}

function bothTeamsFullyReady(game) {
  const red = Array.isArray(game.redPlayers) ? game.redPlayers : [];
  const blue = Array.isArray(game.bluePlayers) ? game.bluePlayers : [];
  if (red.length === 0 || blue.length === 0) return false;
  if (!teamHasRequiredRoles(red) || !teamHasRequiredRoles(blue)) return false;
  return red.every(p => p.ready) && blue.every(p => p.ready);
}

async function maybeAutoStartQuickPlay(game) {
  if (!game || game.currentPhase !== 'waiting' || game.winner != null) return;
  if (!bothTeamsFullyReady(game)) return;

  // Generate the board OUTSIDE the transaction (may involve an async LLM call for vibe).
  // We guard against races by checking a settings signature inside the transaction.
  const s0 = getQuickSettings(game);
  const settingsSig0 = JSON.stringify({
    blackCards: Number(s0.blackCards || 1),
    stackingEnabled: s0.stackingEnabled !== false,
    deckId: String(s0.deckId || 'standard'),
    vibe: String(s0.vibe || '').trim(),
  });

  let cards0 = null;
  try {
    cards0 = await buildQuickPlayCardsFromSettings(s0);
  } catch (e) {
    console.warn('Failed to build Quick Play cards (best-effort), falling back to deck:', e);
    const fallback = { ...s0, vibe: '' };
    cards0 = await buildQuickPlayCardsFromSettings(fallback);
  }

  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();
      if (g.currentPhase !== 'waiting' || g.winner != null) return;
      if (!bothTeamsFullyReady(g)) return;

      const s = getQuickSettings(g);
      const settingsSig1 = JSON.stringify({
        blackCards: Number(s.blackCards || 1),
        stackingEnabled: s.stackingEnabled !== false,
        deckId: String(s.deckId || 'standard'),
        vibe: String(s.vibe || '').trim(),
      });

      // If settings changed while we were generating the board, abort.
      if (settingsSig1 !== settingsSig0) return;

      const firstTeam = 'red';
      const cards = Array.isArray(cards0) && cards0.length === BOARD_SIZE ? cards0 : (g.cards || []);

      // If players pre-selected Spymaster in the lobby, pre-assign them.
      const redPlayers = Array.isArray(g.redPlayers) ? g.redPlayers : [];
      const bluePlayers = Array.isArray(g.bluePlayers) ? g.bluePlayers : [];
      const redSpy = redPlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const blueSpy = bluePlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const startPhase = (redSpy && blueSpy) ? 'spymaster' : 'role-selection';
      const startTimerEnd = (startPhase === 'spymaster') ? buildPhaseTimerEndValue(g, 'spymaster') : null;

      tx.update(ref, {
        cards,
        redMarkers: {},
        blueMarkers: {},
        redConsidering: {},
        blueConsidering: {},
        currentTeam: firstTeam,
        currentPhase: startPhase,
        redSpymaster: redSpy,
        blueSpymaster: blueSpy,
        redCardsLeft: FIRST_TEAM_CARDS,
        blueCardsLeft: SECOND_TEAM_CARDS,
        currentClue: null,
        pendingClue: null,
        liveClueDraft: null,
        guessesRemaining: 0,
        timerEnd: startTimerEnd,
        winner: null,
        log: firebase.firestore.FieldValue.arrayUnion('All players ready. Starting game…'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    // Clear operative chats from previous game
    clearOperativeChats(QUICKPLAY_DOC_ID);
    // Play game start sound
    if (window.playSound) window.playSound('gameStart');
  } catch (e) {
    console.error('Auto-start Quick Play failed:', e);
  }
}

// Manual start button for Quick Play waiting screen.
// (Some lobbies may prefer to click Start instead of relying on auto-start timing.)
window.startQuickGame = async function startQuickGame(gameId) {
  const gid = String(gameId || '').trim();
  if (!gid || gid !== QUICKPLAY_DOC_ID) return;

  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  let snap;
  try { snap = await ref.get(); } catch (_) { return; }
  if (!snap || !snap.exists) return;

  const g0 = { id: snap.id, ...snap.data() };
  if (g0.currentPhase && g0.currentPhase !== 'waiting') return;
  const redCount = (g0.redPlayers || []).length;
  const blueCount = (g0.bluePlayers || []).length;
  if (!(redCount > 0 && blueCount > 0)) return;

  const s0 = getQuickSettings(g0);
  const settingsSig0 = JSON.stringify({
    blackCards: Number(s0.blackCards || 1),
    stackingEnabled: s0.stackingEnabled !== false,
    deckId: String(s0.deckId || 'standard'),
    vibe: String(s0.vibe || '').trim(),
  });

  let cards0 = null;
  try {
    cards0 = await buildQuickPlayCardsFromSettings(s0);
  } catch (e) {
    console.warn('Manual Quick Play start: failed to build cards (best-effort).', e);
    const fallback = { ...s0, vibe: '' };
    cards0 = await buildQuickPlayCardsFromSettings(fallback);
  }

  try {
    await db.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists) return;
      const g = s.data();
      if (g.currentPhase !== 'waiting' || g.winner != null) return;
      const r = (g.redPlayers || []).length;
      const b = (g.bluePlayers || []).length;
      if (!(r > 0 && b > 0)) return;

      const qs = getQuickSettings(g);
      const settingsSig1 = JSON.stringify({
        blackCards: Number(qs.blackCards || 1),
        stackingEnabled: qs.stackingEnabled !== false,
        deckId: String(qs.deckId || 'standard'),
        vibe: String(qs.vibe || '').trim(),
      });
      if (settingsSig1 !== settingsSig0) return;

      const firstTeam = 'red';
      const cards = Array.isArray(cards0) && cards0.length === BOARD_SIZE ? cards0 : (g.cards || []);

      const redPlayers = Array.isArray(g.redPlayers) ? g.redPlayers : [];
      const bluePlayers = Array.isArray(g.bluePlayers) ? g.bluePlayers : [];
      const redSpy = redPlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const blueSpy = bluePlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const startPhase = (redSpy && blueSpy) ? 'spymaster' : 'role-selection';
      const startTimerEnd = (startPhase === 'spymaster') ? buildPhaseTimerEndValue(g, 'spymaster') : null;

      tx.update(ref, {
        cards,
        redMarkers: {},
        blueMarkers: {},
        redConsidering: {},
        blueConsidering: {},
        currentTeam: firstTeam,
        currentPhase: startPhase,
        redSpymaster: redSpy,
        blueSpymaster: blueSpy,
        redCardsLeft: FIRST_TEAM_CARDS,
        blueCardsLeft: SECOND_TEAM_CARDS,
        currentClue: null,
        pendingClue: null,
        liveClueDraft: null,
        guessesRemaining: 0,
        timerEnd: startTimerEnd,
        winner: null,
        log: firebase.firestore.FieldValue.arrayUnion('Game started.'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    clearOperativeChats(QUICKPLAY_DOC_ID);
    if (window.playSound) window.playSound('gameStart');
  } catch (e) {
    console.warn('Manual Quick Play start failed (best-effort):', e);
  }
};

async function clearOperativeChats(gameId) {
  try {
    const gameRef = db.collection('games').doc(gameId);
    for (const chatName of ['redChat', 'blueChat']) {
      const snap = await gameRef.collection(chatName).get();
      const batch = db.batch();
      snap.docs.forEach(doc => batch.delete(doc.ref));
      if (snap.docs.length > 0) await batch.commit();
    }
  } catch (e) {
    console.error('Failed to clear operative chats:', e);
  }
}

function renderQuickLobby(game) {
  latestQuickGame = game || null;
  const redSpyList = document.getElementById('quick-red-spymaster-list');
  const redOpList = document.getElementById('quick-red-operative-list');
  const blueSpyList = document.getElementById('quick-blue-spymaster-list');
  const blueOpList = document.getElementById('quick-blue-operative-list');
  const specList = document.getElementById('quick-spec-list');
  const redCount = document.getElementById('quick-red-count');
  const blueCount = document.getElementById('quick-blue-count');
  const specCount = document.getElementById('quick-spec-count');
  const status = document.getElementById('quick-lobby-status');
  const readyBtn = document.getElementById('quick-ready-btn');
  const leaveBtn = document.getElementById('quick-leave-btn');

  if (!redSpyList || !redOpList || !blueSpyList || !blueOpList || !specList || !redCount || !blueCount || !specCount || !status || !readyBtn || !leaveBtn) return;

  if (!game) {
    redSpyList.innerHTML = '';
    redOpList.innerHTML = '';
    blueSpyList.innerHTML = '';
    blueOpList.innerHTML = '';
    specList.innerHTML = '';
    redCount.textContent = '0';
    blueCount.textContent = '0';
    specCount.textContent = '0';
    status.textContent = 'Loading lobby…';
    readyBtn.disabled = true;
    leaveBtn.disabled = true;
    return;
  }

  const odId = getUserId();
  const userName = getUserName();
  const role = getQuickPlayerRole(game, odId);

  // If we're in Quick Play and the server state contains us, consider the lobby ready.
  if (userName && role) {
    try { _signalQuickPlayReady(); } catch (_) {}
  }

  // Auto-join as spectator when opening Quick Play (so you can see who is here).
  if (!role && userName && !quickAutoJoinedSpectator) {
    quickAutoJoinedSpectator = true;
    selectedQuickTeam = 'spectator';
    // Fire and forget; render will update from snapshot.
    joinQuickLobby('spectator');
  }

  const redAll = Array.isArray(game.redPlayers) ? game.redPlayers : [];
  const blueAll = Array.isArray(game.bluePlayers) ? game.bluePlayers : [];
  const specsAll = Array.isArray(game.spectators) ? game.spectators : [];

  // Only show active players in the lobby.
  // Presence is maintained by app.js; if presence hasn't loaded yet, fall back to showing everyone.
  const presenceData = window.presenceCache || [];
  const presenceMap = new Map();
  for (const pr of presenceData) {
    const status = window.getPresenceStatus ? window.getPresenceStatus(pr) : 'online';
    presenceMap.set(pr.odId || pr.id, status);
  }
  const aiIdsFromGame = new Set(
    [...redAll, ...blueAll].filter(p => p && p.isAI && p.odId).map(p => p.odId)
  );

  const isActive = (id) => {
    if (!presenceData.length) return true;
    // AI players are always active (they don't have presence pings)
    if (aiIdsFromGame.has(id)) return true;
    return presenceMap.get(id) === 'online';
  };

  const red = redAll.filter(p => isActive(p.odId));
  const blue = blueAll.filter(p => isActive(p.odId));
  const specs = specsAll.filter(p => isActive(p.odId));

  redCount.textContent = String(red.length);
  blueCount.textContent = String(blue.length);
  specCount.textContent = String(specs.length);

  
const renderTeamList = (players) => {
  if (!players.length) return '<div class="quick-empty">No one yet</div>';
  return players.map(p => {
    const isYou = p.odId === odId;
    const ready = !!p.ready;
    const playerId = p.odId || '';
    const isAI = !!p.isAI;

    // AI traits tooltip + click
    let nameClass = `quick-player-name ${playerId ? 'profile-link' : ''}`;
    let nameAttrs = '';
    if (isAI && playerId) {
      nameClass = 'quick-player-name ai-traits-link';
      const tRaw = p.aiTraits || {};
      const clamp = (v) => Math.max(0, Math.min(100, Math.floor(Number(v) || 0)));
      const t = {
        confidence: clamp(tRaw.confidence),
        riskiness: clamp(tRaw.riskiness),
        reasoning: clamp(tRaw.reasoning),
        strategic: clamp(tRaw.strategic),
        farFetched: clamp(tRaw.farFetched),
      };
      const title = `Confidence ${t.confidence} • Riskiness ${t.riskiness} • Reasoning ${t.reasoning} • Strategic ${t.strategic} • Far-Fetched ${t.farFetched}`;
      nameAttrs = `title="${escapeHtml(title)}" onclick="event.stopPropagation(); if(window.openAITraitsPopup) window.openAITraitsPopup('${escapeHtml(playerId)}');" style="cursor:pointer;"`;
    } else if (playerId) {
      nameClass = 'quick-player-name profile-link';
      nameAttrs = `data-profile-type="player" data-profile-id="${escapeHtml(playerId)}"`;
    }

    const removeBtn = (isAI && playerId)
      ? `<button class="quick-remove-ai" type="button" title="Remove AI" onclick="event.stopPropagation(); if(window.removeAIFromLobbyByOdId) window.removeAIFromLobbyByOdId('${escapeHtml(playerId)}');">✕</button>`
      : '';

    return `
      <div class="quick-player ${ready ? 'ready' : ''} ${isAI ? 'is-ai' : ''}">
        <span class="${nameClass}" ${nameAttrs}>${escapeHtml(displayPlayerName(p))}${isYou ? ' <span class="quick-you">(you)</span>' : ''}</span>
        <span class="quick-player-badge">${ready ? 'READY' : 'NOT READY'}</span>
        ${removeBtn}
      </div>
    `;
  }).join('');
};

const renderSpecList = (players) => {
    if (!players.length) return '<div class="quick-empty">No one yet</div>';
    return players.map(p => {
      const isYou = p.odId === odId;
      const playerId = p.odId || '';
      return `
        <div class="quick-player spectator">
          <span class="quick-player-name ${playerId ? 'profile-link' : ''}" ${playerId ? `data-profile-type="player" data-profile-id="${escapeHtml(playerId)}"` : ''}>${escapeHtml(displayPlayerName(p))}${isYou ? ' <span class="quick-you">(you)</span>' : ''}</span>
        </div>
      `;
    }).join('');
  };

  const splitBySeat = (players) => {
    const spymasters = [];
    const operatives = [];
    for (const p of (players || [])) {
      if (String(p?.role || 'operative') === 'spymaster') spymasters.push(p);
      else operatives.push(p);
    }
    return { spymasters, operatives };
  };

  const redSplit = splitBySeat(red);
  const blueSplit = splitBySeat(blue);

  redSpyList.innerHTML = renderTeamList(redSplit.spymasters);
  redOpList.innerHTML = renderTeamList(redSplit.operatives);
  blueSpyList.innerHTML = renderTeamList(blueSplit.spymasters);
  blueOpList.innerHTML = renderTeamList(blueSplit.operatives);
  specList.innerHTML = renderSpecList(specs);

  // Update role selector UI (highlight the selected column)
  const effectiveRole = role || selectedQuickTeam || 'spectator';
  applyQuickRoleHighlight(effectiveRole);

  // Update seat selector UI (Operative vs Spymaster)
  clearQuickSeatHighlights();
  if (effectiveRole === 'red' || effectiveRole === 'blue') {
    const seat = getQuickPlayerSeatRole(game, odId) || selectedQuickSeatRole;
    selectedQuickSeatRole = (seat === 'spymaster') ? 'spymaster' : 'operative';
    applyQuickSeatHighlight(effectiveRole, selectedQuickSeatRole);
  }

  // Rules UI
  updateQuickRulesUI(game);

  // Button state
  const youRoleNow = getQuickPlayerRole(game, getUserId());
  const inProgress = (game.currentPhase !== 'waiting' && game.winner == null);
  const activeJoinOn = isActiveJoinOn(game);
  const canLateJoin = inProgress && activeJoinOn && (youRoleNow !== 'red' && youRoleNow !== 'blue');

  // Find the current player object to check ready state
  const allPlayers = [...redAll, ...blueAll, ...specsAll];
  const youObj = allPlayers.find(p => p.odId === odId);

  // Button behavior:
  // - Waiting: Ready Up / Unready for team members.
  // - In progress + Active Join: latecomers can Join after selecting Red/Blue.
  // - In progress (already rostered): show In Game (no ready toggling mid-round).
  const youReady = !!youObj?.ready;

  // Enable leave button when in lobby
  leaveBtn.disabled = !youObj;
  if (inProgress && (youRoleNow === 'red' || youRoleNow === 'blue')) {
    readyBtn.textContent = 'In Game';
    readyBtn.disabled = true;
  } else if (inProgress && effectiveRole === 'spectator') {
    readyBtn.textContent = 'Join as Spectator';
    readyBtn.disabled = false;
  } else if (canLateJoin) {
    readyBtn.textContent = 'Join';
    readyBtn.disabled = !(effectiveRole === 'red' || effectiveRole === 'blue');
  } else {
    readyBtn.textContent = youReady ? 'Unready' : 'Ready Up';
    readyBtn.disabled = !(effectiveRole === 'red' || effectiveRole === 'blue');
  }

  if (game.currentPhase !== 'waiting' && game.winner == null) {
    const activeJoinOn = isActiveJoinOn(game);
    const youRoleNow = getQuickPlayerRole(game, getUserId());
    if (activeJoinOn && (youRoleNow !== 'red' && youRoleNow !== 'blue')) {
      status.textContent = 'Game in progress — late join enabled.';
    } else {
      status.textContent = 'Game in progress…';
    }
  } else if (bothTeamsFullyReady(game)) {
    status.textContent = 'Everyone is ready — starting…';
  } else if (red.length === 0 || blue.length === 0) {
    status.textContent = '';
  } else if (!teamHasRequiredRoles(red) || !teamHasRequiredRoles(blue)) {
    const missingRed = [];
    const missingBlue = [];
    if (!red.some(p => String(p?.role || 'operative') === 'spymaster')) missingRed.push('Spymaster');
    if (!red.some(p => String(p?.role || 'operative') === 'operative')) missingRed.push('Operative');
    if (!blue.some(p => String(p?.role || 'operative') === 'spymaster')) missingBlue.push('Spymaster');
    if (!blue.some(p => String(p?.role || 'operative') === 'operative')) missingBlue.push('Operative');
    const parts = [];
    if (missingRed.length) parts.push(`Red needs: ${missingRed.join(', ')}`);
    if (missingBlue.length) parts.push(`Blue needs: ${missingBlue.join(', ')}`);
    status.textContent = parts.join(' · ');
  } else {
    status.textContent = '';
  }
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Display names: show AIs as "AI <Name>" everywhere for consistency.
function displayPlayerName(p) {
  const raw = String((p && p.name) ? p.name : '').trim();
  if (!p || !p.isAI) return raw;
  // Avoid double-prefixing if the AI name was already stored with the prefix.
  if (/^ai\s+/i.test(raw)) return raw;
  return raw ? `AI ${raw}` : 'AI';
}

// Some fields store a player name as a string (e.g., redSpymaster/blueSpymaster).
// If that name corresponds to an AI player on the roster, display it with the AI prefix.
function displayNameFromRoster(name, rosterPlayers) {
  const raw = String(name || '').trim();
  if (!raw) return raw;
  if (/^ai\s+/i.test(raw)) return raw;
  const list = Array.isArray(rosterPlayers) ? rosterPlayers : [];
  const match = list.find(p => p && String(p.name || '').trim() === raw);
  if (match && match.isAI) return `AI ${raw}`;
  // Back-compat: some older docs may have stored an id in place of the name.
  const idMatch = list.find(p => p && String(p.odId || '').trim() === raw);
  if (idMatch) return displayPlayerName(idMatch);
  return raw;
}

function getTeamPlayers(team, game = currentGame) {
  if (team !== 'red' && team !== 'blue') return [];
  const key = team === 'red' ? 'redPlayers' : 'bluePlayers';
  return Array.isArray(game?.[key]) ? game[key] : [];
}

function normalizeSpyIdentity(value) {
  return String(value || '')
    .trim()
    .replace(/^ai\s+/i, '')
    .trim()
    .toLowerCase();
}

function isSpymasterPlayerForTeam(player, team, game = currentGame) {
  if (!player || (team !== 'red' && team !== 'blue')) return false;
  const role = String(player?.role || '').trim().toLowerCase();
  if (role === 'spymaster') return true;

  const key = team === 'red' ? 'redSpymaster' : 'blueSpymaster';
  const spyRaw = String(game?.[key] || '').trim();
  if (!spyRaw) return false;

  const playerNameRaw = String(player?.name || '').trim();
  const playerId = String(player?.odId || player?.id || '').trim();

  // Back-compat: some docs stored the player's id in redSpymaster/blueSpymaster.
  if (playerId && spyRaw === playerId) return true;

  // Name match with tolerance for "AI " prefix and casing differences.
  const spyNorm = normalizeSpyIdentity(spyRaw);
  const playerNorm = normalizeSpyIdentity(playerNameRaw);
  return !!spyNorm && !!playerNorm && spyNorm === playerNorm;
}

function getTeamSpymasterName(team, game = currentGame) {
  if (team !== 'red' && team !== 'blue') return '';
  const players = getTeamPlayers(team, game);
  const byRole = players.find(p => isSpymasterPlayerForTeam(p, team, game));
  if (byRole && String(byRole.name || '').trim()) return String(byRole.name || '').trim();

  const key = team === 'red' ? 'redSpymaster' : 'blueSpymaster';
  const spyRaw = String(game?.[key] || '').trim();
  if (!spyRaw) return '';

  // Back-compat: when a raw id is stored, map it back to a roster name.
  const byId = players.find(p => String(p?.odId || p?.id || '').trim() === spyRaw);
  if (byId && String(byId?.name || '').trim()) return String(byId.name || '').trim();

  // Back-compat: allow "AI Name" vs "Name" mismatches.
  const spyNorm = normalizeSpyIdentity(spyRaw);
  const byName = players.find(p => normalizeSpyIdentity(p?.name) === spyNorm);
  if (byName && String(byName?.name || '').trim()) return String(byName.name || '').trim();

  return spyRaw;
}

function truncateTeamNameGame(name, maxLen = 20) {
  const str = String(name || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function clampGameDaySeriesWins(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 2) return 2;
  return n;
}

function buildBracketSeriesByMatchup() {
  const map = new Map();
  if (typeof buildBracketModel !== 'function') return map;
  const teams = Array.isArray(teamsCache) ? teamsCache : [];
  let model = null;
  try {
    model = buildBracketModel(teams);
  } catch (_) {
    return map;
  }
  const matches = Array.isArray(model?.matches) ? model.matches : [];
  matches.forEach((match) => {
    const sides = (match?.slots || [])
      .filter(slot => slot && slot.kind === 'team' && slot.id)
      .map(slot => String(slot.id || '').trim())
      .filter(Boolean);
    if (sides.length !== 2) return;
    const leftId = sides[0];
    const rightId = sides[1];
    const leftWins = clampGameDaySeriesWins(match?.series?.aWins || 0);
    const rightWins = clampGameDaySeriesWins(match?.series?.bWins || 0);
    const key = [leftId, rightId].sort().join('|');
    map.set(key, {
      matchId: String(match?.id || '').trim(),
      label: String(match?.label || '').trim(),
      byTeamId: {
        [leftId]: leftWins,
        [rightId]: rightWins,
      }
    });
  });
  return map;
}

function getGameDaySeriesScore(game, seriesByMatchup = null) {
  if (!game || String(game?.type || '').trim() !== 'tournament') return null;
  const redTeamId = String(game?.redTeamId || '').trim();
  const blueTeamId = String(game?.blueTeamId || '').trim();
  if (!redTeamId || !blueTeamId) return null;

  const key = [redTeamId, blueTeamId].sort().join('|');
  const source = (seriesByMatchup instanceof Map)
    ? seriesByMatchup
    : buildBracketSeriesByMatchup();
  const row = source.get(key);
  if (!row || !row.byTeamId || typeof row.byTeamId !== 'object') return null;

  return {
    matchId: String(row.matchId || '').trim(),
    label: String(row.label || '').trim(),
    redWins: clampGameDaySeriesWins(row.byTeamId[redTeamId] || 0),
    blueWins: clampGameDaySeriesWins(row.byTeamId[blueTeamId] || 0),
  };
}

async function renderSpectateGames() {
  const section = document.getElementById('spectate-games-section');
  const list = document.getElementById('spectate-games-list');
  if (!section || !list) return;

  try {
    const snap = await db.collection('games')
      .where('winner', '==', null)
      .limit(25)
      .get();

    const games = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Only show games that have actually started (not in waiting phase)
    // Games in 'waiting' phase are still in lobby/setup and shouldn't be visible
    const activeGames = games
      .filter(g => g.type !== 'practice' && g.currentPhase && g.currentPhase !== 'waiting')
      .slice(0, 10);

    if (activeGames.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';
    const seriesByMatchup = buildBracketSeriesByMatchup();

    const activeHtml = activeGames.map(g => {
      const redName = escapeHtml(truncateTeamNameGame(g.redTeamName || 'Red Team'));
      const blueName = escapeHtml(truncateTeamNameGame(g.blueTeamName || 'Blue Team'));
      const status = escapeHtml(describeGameStatus(g));
      const series = getGameDaySeriesScore(g, seriesByMatchup);
      const scoreChip = series
        ? `<span class="challenge-score" title="Series score">${escapeHtml(`${series.redWins}-${series.blueWins}`)}</span>`
        : '';

      // Tournament games: only team members can join, others can only watch
      // Quick Play games: anyone in the game can rejoin
      const myTeam = getMyTeam?.() || null;
      const odId = getUserId?.() || null;

      let canJoin = false;
      if (g.type === 'tournament') {
        // Tournament: only if user's team is participating
        canJoin = !!(myTeam && (g.redTeamId === myTeam.id || g.blueTeamId === myTeam.id));
      } else if (g.type === 'quick') {
        // Quick Play: only if user is already in the game
        const inRed = (g.redPlayers || []).some(p => p.odId === odId);
        const inBlue = (g.bluePlayers || []).some(p => p.odId === odId);
        canJoin = inRed || inBlue;
      }

      const primaryLabel = canJoin ? 'Rejoin' : 'Watch';
      const primaryAction = canJoin ? `joinGame('${g.id}')` : `spectateGame('${g.id}')`;

      return `
        <div class="challenge-row">
          <div class="challenge-info">
            <span class="challenge-team-name">${redName} vs ${blueName}</span>
            <div class="challenge-meta-row">
              <span class="challenge-meta">${status}</span>
              ${scoreChip}
            </div>
          </div>
          <div class="challenge-actions">
            <button class="btn primary small" onclick="${primaryAction}">${primaryLabel}</button>
          </div>
        </div>
      `;
    }).join('');

    list.innerHTML = activeHtml;
  } catch (e) {
    console.error('Failed to render spectate games:', e);
  }
}

/* =========================
   Challenge System
========================= */
function listenToChallenges() {
  if (challengesUnsub) challengesUnsub();

  challengesUnsub = db.collection('challenges')
    .orderBy('createdAt', 'desc')
    .onSnapshot((snapshot) => {
      if (currentPlayMode === 'tournament') {
        renderTournamentLobby();
      }
      updateGameTabBadge();
    }, (err) => {
      console.error('Challenges listener error:', err);
    });
}

async function renderTournamentLobby() {
  const myTeam = getMyTeam();
  const statusEl = document.getElementById('game-team-status');
  const challengesSec = document.getElementById('challenges-section');
  const challengeTeamsSec = document.getElementById('challenge-teams-section');
  const pendingSec = document.getElementById('pending-challenges-section');
  const activeBanner = document.getElementById('game-active-banner');
  const activeGamesSec = document.getElementById('active-games-section');
  const seriesByMatchup = buildBracketSeriesByMatchup();

  if (!statusEl) return;

  // If user isn't on a team, they can spectate active games
  if (!myTeam) {
    statusEl.innerHTML = '<div class="hint">You need to be on a team to challenge another team, but you can spectate active games.</div>';
    if (challengesSec) challengesSec.style.display = 'none';
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
    if (pendingSec) pendingSec.style.display = 'none';
    if (activeBanner) activeBanner.style.display = 'none';

    // Render active games list for spectating
    if (activeGamesSec) activeGamesSec.style.display = 'none';
    await renderActiveGamesList(null, null, seriesByMatchup);
    return;
  }

  // Show team status
  statusEl.innerHTML = `
    <div class="team-info">
      <span class="team-name">${escapeHtml(truncateTeamNameGame(myTeam.teamName || 'My Team'))}</span>
    </div>
  `;

  // Check for active game where user's team is playing
  const activeGame = await getActiveGameForTeam(myTeam.id);
  if (activeGame) {
    if (activeBanner) {
      activeBanner.style.display = 'flex';
      const teamsText = document.getElementById('game-banner-teams');
      if (teamsText) {
        const score = getGameDaySeriesScore(activeGame, seriesByMatchup);
        const scoreSuffix = score ? ` (${score.redWins}-${score.blueWins})` : '';
        teamsText.textContent = `${truncateTeamNameGame(activeGame.redTeamName)} vs ${truncateTeamNameGame(activeGame.blueTeamName)}${scoreSuffix}`;
      }
    }
    if (challengesSec) challengesSec.style.display = 'none';
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
    if (pendingSec) pendingSec.style.display = 'none';

    // Still show active games list (for spectating other matches)
    await renderActiveGamesList(myTeam, activeGame.id, seriesByMatchup);
    return;
  } else {
    if (activeBanner) activeBanner.style.display = 'none';
  }

  // Get challenges
  const challenges = await getChallenges();

  // Incoming challenges (to my team)
  const incoming = challenges.filter(c => c.toTeamId === myTeam.id && c.status === 'pending');
  if (incoming.length > 0) {
    if (challengesSec) challengesSec.style.display = 'block';
    const list = document.getElementById('challenges-list');
    if (list) {
      list.innerHTML = incoming.map(c => `
        <div class="challenge-row incoming">
          <div class="challenge-info">
            <span class="challenge-team-name">${escapeHtml(truncateTeamNameGame(c.fromTeamName || 'Unknown Team'))}</span>
            <span class="challenge-meta">wants to play</span>
          </div>
          <div class="challenge-actions">
            <button class="btn success small" onclick="acceptChallenge('${c.id}')">Accept</button>
            <button class="btn danger small" onclick="declineChallenge('${c.id}')">Decline</button>
          </div>
        </div>
      `).join('');
    }
  } else {
    if (challengesSec) challengesSec.style.display = 'none';
  }

  // Pending challenges (from my team)
  const pending = challenges.filter(c => c.fromTeamId === myTeam.id && c.status === 'pending');
  if (pending.length > 0) {
    if (pendingSec) pendingSec.style.display = 'block';
    const list = document.getElementById('pending-challenges-list');
    if (list) {
      list.innerHTML = pending.map(c => `
        <div class="challenge-row">
          <div class="challenge-info">
            <span class="challenge-team-name">${escapeHtml(truncateTeamNameGame(c.toTeamName || 'Unknown Team'))}</span>
            <span class="challenge-meta">waiting for response...</span>
          </div>
          <div class="challenge-actions">
            <button class="btn danger small" onclick="cancelChallenge('${c.id}')">Cancel</button>
          </div>
        </div>
      `).join('');
    }
  } else {
    if (pendingSec) pendingSec.style.display = 'none';
  }

  // Teams to challenge
  const otherTeams = teamsCache.filter(t => {
    if (t.id === myTeam.id) return false;
    // Don't show teams we already challenged
    if (pending.some(p => p.toTeamId === t.id)) return false;
    // Don't show teams that challenged us
    if (incoming.some(i => i.fromTeamId === t.id)) return false;
    return true;
  });

  if (otherTeams.length > 0) {
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'block';
    const list = document.getElementById('challenge-teams-list');
    if (list) {
      list.innerHTML = otherTeams.map(t => `
        <div class="challenge-row">
          <div class="challenge-info">
            <span class="challenge-team-name">${escapeHtml(truncateTeamNameGame(t.teamName || 'Team'))}</span>
            <span class="challenge-meta">${getMembers(t).length} players</span>
          </div>
          <div class="challenge-actions">
            <button class="btn primary small" onclick="sendChallenge('${t.id}')">Challenge</button>
          </div>
        </div>
      `).join('');
    }
  } else {
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
  }

  // Active games list (spectate / join)
  await renderActiveGamesList(myTeam, null, seriesByMatchup);
}

async function renderActiveGamesList(myTeam, myActiveGameId, seriesByMatchup = null) {
  const activeGamesSec = document.getElementById('active-games-section');
  const list = document.getElementById('active-games-list');
  if (!activeGamesSec || !list) return;

  const games = await getActiveGames(25);
  if (!games.length) {
    activeGamesSec.style.display = 'none';
    return;
  }

  activeGamesSec.style.display = 'block';
  const matchupSeries = (seriesByMatchup instanceof Map)
    ? seriesByMatchup
    : buildBracketSeriesByMatchup();

  list.innerHTML = games.map(g => {
    const redName = escapeHtml(truncateTeamNameGame(g.redTeamName || 'Red Team'));
    const blueName = escapeHtml(truncateTeamNameGame(g.blueTeamName || 'Blue Team'));
    const status = escapeHtml(describeGameStatus(g));
    const series = getGameDaySeriesScore(g, matchupSeries);
    const scoreChip = series
      ? `<span class="challenge-score" title="Series score">${escapeHtml(`${series.redWins}-${series.blueWins}`)}</span>`
      : '';

    const isMyGame = !!(myTeam && (g.redTeamId === myTeam.id || g.blueTeamId === myTeam.id));
    const primaryLabel = isMyGame ? (myActiveGameId === g.id ? 'Rejoin' : 'Join') : 'Spectate';
    const primaryAction = isMyGame ? `joinGame('${g.id}')` : `spectateGame('${g.id}')`;

    return `
      <div class="challenge-row">
        <div class="challenge-info">
          <span class="challenge-team-name">${redName} vs ${blueName}</span>
          <div class="challenge-meta-row">
            <span class="challenge-meta">${status}</span>
            ${scoreChip}
          </div>
        </div>
        <div class="challenge-actions">
          <button class="btn primary small" onclick="${primaryAction}">${primaryLabel}</button>
        </div>
      </div>
    `;
  }).join('');
}

function describeGameStatus(game) {
  if (!game) return 'In progress';
  if (game.winner) return 'Finished';

  const teamName = (game.currentTeam === 'red')
    ? (game.redTeamName || 'Red Team')
    : (game.blueTeamName || 'Blue Team');

  if (game.currentPhase === 'role-selection') return 'Selecting roles';
  if (game.currentPhase === 'spymaster') return `${teamName} (Spymaster)`;
  if (game.currentPhase === 'operatives') return `${teamName} (Operatives)`;
  return 'In progress';
}

/* =========================
   Abandoned game cleanup
   - End a tournament game only when there are no players online OR idle.
   - Also end games that have no rostered players (e.g., teams deleted/empty).
========================= */

const ABANDONED_GAME_GRACE_MS = 2 * 60 * 1000; // Don't auto-end games created in the last 2 minutes

function buildPresenceStatusMap() {
  const presenceData = window.presenceCache || [];
  const m = new Map();
  for (const p of presenceData) {
    const id = String(p.odId || p.id || '').trim();
    if (!id) continue;
    const st = window.getPresenceStatus ? window.getPresenceStatus(p) : 'offline';
    m.set(id, st);
  }
  return m;
}

function getGameParticipantIds(game) {
  // Tournament games don't store per-game player arrays, so we infer participants from team rosters.
  const ids = new Set();
  if (!game) return ids;

  const redTeam = teamsCache?.find?.(t => t.id === game.redTeamId);
  const blueTeam = teamsCache?.find?.(t => t.id === game.blueTeamId);

  const addTeam = (team) => {
    if (!team) return;
    const members = (typeof getMembers === 'function') ? getMembers(team) : (team.members || []);
    for (const m of (members || [])) {
      const aid = (typeof entryAccountId === 'function')
        ? entryAccountId(m)
        : String(m?.userId || '').trim();
      if (aid) ids.add(aid);
    }
  };

  addTeam(redTeam);
  addTeam(blueTeam);
  return ids;
}

function isBeyondGracePeriod(game) {
  const now = Date.now();
  const createdAt = game?.createdAt;
  const createdMs = typeof createdAt?.toMillis === 'function'
    ? createdAt.toMillis()
    : (createdAt?.seconds ? createdAt.seconds * 1000 : 0);
  if (!createdMs) return true;
  return (now - createdMs) > ABANDONED_GAME_GRACE_MS;
}

function shouldEndAbandonedTournamentGame(game, presenceMap) {
  if (!game) return false;
  if (game.winner != null) return false;
  if (game.type !== 'tournament') return false;
  if (!isBeyondGracePeriod(game)) return false;

  const participants = getGameParticipantIds(game);
  if (participants.size === 0) {
    // No rostered players exist for this match.
    return true;
  }

  for (const id of participants) {
    const st = presenceMap.get(id);
    if (st === 'online' || st === 'idle') {
      return false;
    }
  }
  // Everyone is offline or missing presence.
  return true;
}

async function endAbandonedTournamentGame(gameId, reason) {
  if (!gameId) return;
  try {
    await db.collection('games').doc(gameId).update({
      winner: 'abandoned',
      currentPhase: 'ended',
      timerEnd: null,
      endedReason: reason || 'abandoned',
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      log: firebase.firestore.FieldValue.arrayUnion(`Game ended (${reason || 'abandoned'}).`)
    });
  } catch (e) {
    console.warn('Failed to end abandoned game:', e);
  }
}

async function getActiveGames(limit = 25) {
  try {
    const snap = await db.collection('games')
      .where('winner', '==', null)
      .limit(limit)
      .get();

    let games = snap.docs.map(d => ({ id: d.id, ...d.data() }));

    // Filter out games that haven't actually started (waiting phase)
    // These are Quick Play lobbies where players are not ready
    games = games.filter(g => g.type !== 'practice' && g.currentPhase && g.currentPhase !== 'waiting');

    // Auto-end abandoned tournament games (no online/idle participants).
    // This also cleans up orphaned matches with no rostered players.
    const presenceMap = buildPresenceStatusMap();
    const stillActive = [];
    for (const g of games) {
      if (shouldEndAbandonedTournamentGame(g, presenceMap)) {
        await endAbandonedTournamentGame(g.id, 'no active or idle players');
        continue;
      }
      stillActive.push(g);
    }
    games = stillActive;

    // Best-effort sort by updatedAt / createdAt (client-side so we avoid Firestore index requirements)
    games.sort((a, b) => {
      const at = (a.updatedAt?.toMillis?.() ?? a.createdAt?.toMillis?.() ?? 0);
      const bt = (b.updatedAt?.toMillis?.() ?? b.createdAt?.toMillis?.() ?? 0);
      return bt - at;
    });

    return games;
  } catch (e) {
    console.error('Failed to get active games:', e);
    return [];
  }
}

// Public helpers for inline onclick
function spectateGame(gameId) {
  spectatorMode = true;
  spectatingGameId = gameId;
  startGameListener(gameId, { spectator: true });
}

function joinGame(gameId) {
  spectatorMode = false;
  spectatingGameId = null;
  startGameListener(gameId, { spectator: false });
}

async function getChallenges() {
  try {
    const snap = await db.collection('challenges').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    console.error('Failed to get challenges:', e);
    return [];
  }
}

async function sendChallenge(toTeamId) {
  const myTeam = getMyTeam();
  if (!myTeam) return;

  const toTeam = teamsCache.find(t => t.id === toTeamId);
  if (!toTeam) return;

  try {
    await db.collection('challenges').add({
      fromTeamId: myTeam.id,
      fromTeamName: myTeam.teamName || 'Team',
      toTeamId: toTeam.id,
      toTeamName: toTeam.teamName || 'Team',
      status: 'pending',
      createdAt: firebase.firestore.FieldValue.serverTimestamp()
    });
    renderTournamentLobby();
  } catch (e) {
    console.error('Failed to send challenge:', e);
  }
}

async function cancelChallenge(challengeId) {
  try {
    await db.collection('challenges').doc(challengeId).delete();
    renderTournamentLobby();
  } catch (e) {
    console.error('Failed to cancel challenge:', e);
  }
}

async function declineChallenge(challengeId) {
  try {
    await db.collection('challenges').doc(challengeId).delete();
    renderTournamentLobby();
  } catch (e) {
    console.error('Failed to decline challenge:', e);
  }
}

async function acceptChallenge(challengeId) {
  const myTeam = getMyTeam();
  if (!myTeam) return;

  try {
    // Check if there's already an active tournament game (limit to 1 at a time)
    const activeGames = await getActiveGames(5);
    const existingTournamentGame = activeGames.find(g => g.type === 'tournament');
    if (existingTournamentGame) {
      alert('A tournament game is already in progress. Please wait for it to finish.');
      return;
    }

    const challengeDoc = await db.collection('challenges').doc(challengeId).get();
    if (!challengeDoc.exists) return;

    const challenge = { id: challengeDoc.id, ...challengeDoc.data() };

    // Create the game
    await createGame(challenge.fromTeamId, challenge.fromTeamName, myTeam.id, myTeam.teamName);

    // Delete the challenge
    await db.collection('challenges').doc(challengeId).delete();

    // Clean up any other challenges involving these teams
    const allChallenges = await getChallenges();
    for (const c of allChallenges) {
      if (c.fromTeamId === myTeam.id || c.toTeamId === myTeam.id ||
          c.fromTeamId === challenge.fromTeamId || c.toTeamId === challenge.fromTeamId) {
        await db.collection('challenges').doc(c.id).delete();
      }
    }

    renderTournamentLobby();
  } catch (e) {
    console.error('Failed to accept challenge:', e);
  }
}

/* =========================
   Game Creation
========================= */
async function createGame(team1Id, team1Name, team2Id, team2Name) {
  // Randomly assign red/blue
  const isTeam1Red = Math.random() < 0.5;
  const redTeamId = isTeam1Red ? team1Id : team2Id;
  const redTeamName = isTeam1Red ? team1Name : team2Name;
  const blueTeamId = isTeam1Red ? team2Id : team1Id;
  const blueTeamName = isTeam1Red ? team2Name : team1Name;

  // Red always goes first in Codenames
  const firstTeam = 'red';

  // Generate board
  // Tournament games currently use the standard deck.
  // (Quick Play has a deck picker; tournament can be extended similarly later.)
  const words = getRandomWords(BOARD_SIZE, 'standard');
  const keyCard = generateKeyCard(firstTeam);

  const cards = words.map((word, i) => ({
    word,
    type: keyCard[i],
    revealed: false
  }));

  const gameData = {
    type: 'tournament',
    redTeamId,
    redTeamName,
    blueTeamId,
    blueTeamName,
    cards,
    // Team-visible markers (reset each game)
    redMarkers: {},
    blueMarkers: {},
    // Team-visible "currently considering" chips
    redConsidering: {},
    blueConsidering: {},
    currentTeam: firstTeam,
    currentPhase: 'role-selection', // role-selection, spymaster, operatives, ended
    redSpymaster: null,
    blueSpymaster: null,
    redCardsLeft: FIRST_TEAM_CARDS,
    blueCardsLeft: SECOND_TEAM_CARDS,
    currentClue: null,
    pendingClue: null,
    liveClueDraft: null,
    guessesRemaining: 0,
    log: [],
    winner: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  const docRef = await db.collection('games').add(gameData);

  // Start listening to this game
  spectatorMode = false;
  spectatingGameId = null;
  startGameListener(docRef.id, { spectator: false });

  return docRef.id;
}

async function getActiveGameForTeam(teamId) {
  try {
    // Check for games where this team is red
    let snap = await db.collection('games')
      .where('redTeamId', '==', teamId)
      .where('winner', '==', null)
      .limit(1)
      .get();

    if (!snap.empty) {
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }

    // Check for games where this team is blue
    snap = await db.collection('games')
      .where('blueTeamId', '==', teamId)
      .where('winner', '==', null)
      .limit(1)
      .get();

    if (!snap.empty) {
      return { id: snap.docs[0].id, ...snap.docs[0].data() };
    }

    return null;
  } catch (e) {
    console.error('Failed to get active game:', e);
    return null;
  }
}

async function rejoinCurrentGame() {
  const myTeam = getMyTeam();
  if (!myTeam) return;

  const activeGame = await getActiveGameForTeam(myTeam.id);
  if (activeGame) {
    spectatorMode = false;
    spectatingGameId = null;
    startGameListener(activeGame.id, { spectator: false });
  }
}

/* =========================
   Game Listener
========================= */
function startGameListener(gameId, options = {}) {
  if (gameUnsub) gameUnsub();
  _lastSentClueDraftSig = '';
  const localPractice = isLocalPracticeGameId(gameId);
  currentListenerEphemeral = !!(options.ephemeral || localPractice);
  let isFirstSnapshot = true;

  spectatorMode = !!options.spectator;
  spectatingGameId = spectatorMode ? gameId : null;

  if (localPractice) {
    gameUnsub = () => {};
    clearRevealAnimationSuppressions();
    try {
      if (typeof safeLSSet === 'function') {
        safeLSSet(LS_ACTIVE_GAME_ID, String(gameId || ''));
        safeLSSet(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
      } else {
        localStorage.setItem(LS_ACTIVE_GAME_ID, String(gameId || ''));
        localStorage.setItem(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
      }
    } catch (_) {}
    const localGame = getLocalPracticeGame(gameId);
    if (!localGame) {
      currentGame = null;
      stopPracticeInactivityWatcher();
      stopLocalPracticeAI();
      showGameLobby();
      try { window.bumpPresence?.(); } catch (_) {}
      return;
    }

    currentGame = localGame;
    if (currentGame?.type === 'practice') startPracticeInactivityWatcher();
    else stopPracticeInactivityWatcher();

    try {
      const sig = (Array.isArray(currentGame?.cards) && currentGame.cards.length)
        ? currentGame.cards.map(c => `${String(c?.word || '')}::${String(c?.type || '')}`).join('|')
        : null;
      if (sig) _prevBoardSignature = sig;
    } catch (_) {}

    _prevClue = currentGame.currentClue?.word || null;
    try { renderGame(); } catch (_) {}
    maybeStartLocalPracticeAI();
    try { window.bumpPresence?.(); } catch (_) {}
    return;
  }

  // Persist last active game (device-local) for refresh resume.
  // Skip this for ephemeral listeners (Practice tabs) so they don't steal your resume slot.
  if (!currentListenerEphemeral) {
  try {
    if (typeof safeLSSet === 'function') {
      safeLSSet(LS_ACTIVE_GAME_ID, String(gameId || ''));
      safeLSSet(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
    } else {
      localStorage.setItem(LS_ACTIVE_GAME_ID, String(gameId || ''));
      localStorage.setItem(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
    }
  } catch (_) {}
  }

  gameUnsub = db.collection('games').doc(gameId).onSnapshot((snap) => {
    const prevCards = Array.isArray(currentGame?.cards)
      ? currentGame.cards.map((c) => ({ revealed: !!c?.revealed }))
      : null;
    if (!snap.exists) {
      clearRevealAnimationSuppressions();
      currentGame = null;
      stopPracticeInactivityWatcher();
      showGameLobby();
      try { window.bumpPresence?.(); } catch (_) {}
      return;
    }

    currentGame = { id: snap.id, ...snap.data() };
    if (currentGame?.type === 'practice') startPracticeInactivityWatcher();
    else stopPracticeInactivityWatcher();

    // Reset local per-card tags whenever we detect a brand-new board.
    // This matters especially for Quick Play, where the doc id stays the same across games.
    let boardSignature = null;
    let boardChanged = false;
    try {
      const sig = (Array.isArray(currentGame?.cards) && currentGame.cards.length)
        ? currentGame.cards.map(c => `${String(c?.word || '')}::${String(c?.type || '')}`).join('|')
        : null;
      boardSignature = sig;
      if (sig && _prevBoardSignature && sig !== _prevBoardSignature) {
        boardChanged = true;
        // Clear all local tags without writing anything to Firestore (markers are reset server-side).
        cardTags = {};
        pendingCardSelection = null;
        clueTargetSelection = [];
        _pendingSelectionContextKey = null;
        revealedPeekCardIndex = null;
        void syncTeamConsidering(null);
        renderCardTags();
        saveTagsToLocal();
        setActiveTagMode(null);
        clearRevealAnimationSuppressions();
      }
      _prevBoardSignature = sig || _prevBoardSignature;
    } catch (_) {}
    // Keep resume info fresh in case the game id changes due to edge cases.
    try {
      if (typeof safeLSSet === 'function') {
        safeLSSet(LS_ACTIVE_GAME_ID, String(currentGame?.id || ''));
        safeLSSet(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
      } else {
        localStorage.setItem(LS_ACTIVE_GAME_ID, String(currentGame?.id || ''));
        localStorage.setItem(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
      }
    } catch (_) {}
    try { window.bumpPresence?.(); } catch (_) {}

    // Best-effort: when a game finishes, increment player stats exactly once.
    // Stats writes are intentionally disabled client-side when using Firebase Auth +
    // locked-down Firestore rules. If you want stats, move this to a server-side
    // Cloud Function that validates winners.

    // If a game ever reaches 0 players, end it.
    if (currentGame?.type === 'quick') {
      checkAndEndEmptyQuickPlayGame(currentGame);
    }

    // Detect new clue for animation
    const newClueWord = currentGame.currentClue?.word || null;
    const newClueNumber = currentGame.currentClue?.number ?? null;
    const clueChanged = newClueWord && (newClueWord !== _prevClue);
    let newlyRevealedIndices = [];
    if (!isFirstSnapshot && !boardChanged) {
      newlyRevealedIndices = collectNewlyRevealedCardIndices(prevCards, currentGame.cards)
        .filter((idx) => !consumeRevealAnimationSuppressed(idx));
    } else {
      clearRevealAnimationSuppressions();
    }

    const replayedPreRenderConfirm = replayConfirmAnimationOnCurrentBoard(newlyRevealedIndices, currentGame.cards);
    const finishSnapshotRender = () => {
      renderGame();
      if (newlyRevealedIndices.length && !replayedPreRenderConfirm) {
        animateNewlyRevealedCards(newlyRevealedIndices);
      }

      // If the app is entering Quick Play directly into an in-progress game,
      // keep the loader up until we have rendered at least once.
      if (document.body.classList.contains('quickplay')) {
        _signalQuickPlayReady();
      }

      // Animate new clue (center screen overlay)
      if (clueChanged && newClueWord) {
        showClueAnimation(newClueWord, newClueNumber, currentGame.currentTeam);
      }

      _prevClue = newClueWord;
      isFirstSnapshot = false;
    };

    if (replayedPreRenderConfirm) {
      scheduleSnapshotRender(finishSnapshotRender, CARD_CONFIRM_ANIM_MS, { extend: true });
    } else {
      const holdForLocalConfirmMs = Math.max(0, _localConfirmAnimUntil - Date.now());
      if (holdForLocalConfirmMs > 0) {
        scheduleSnapshotRender(finishSnapshotRender, holdForLocalConfirmMs, { extend: true });
      } else {
        scheduleSnapshotRender(finishSnapshotRender, 0);
      }
    }
  }, (err) => {
    console.error('Game listener error:', err);
  });
}

// Allows app.js to show a live Quick Play game behind the 3-button chooser.
// - spectator=true: view-only background (default)
// - spectator=false: interactive rejoin (only if you're already a participant)

// Export for app.js (Practice deep-links and other navigation)
window.startGameListener = startGameListener;
window.startQuickPlayLiveBackdrop = function startQuickPlayLiveBackdrop(opts = {}) {
  const spectator = (typeof opts.spectator === 'boolean') ? opts.spectator : true;

  // Ensure the Play UI is in a state where the game board can render.
  // This hides the lobby UI and shows the board container.
  try { currentPlayMode = 'quick'; } catch (_) {}

  // Prevent any lobby flash while we wait for the first snapshot.
  try { showGameBoard(); } catch (_) {}

  // Start the live game listener for the Quick Play singleton.
  // This will render the game board (and keep it updating) in the background.
  startGameListener(QUICKPLAY_DOC_ID, { spectator });
};

function stopGameListener() {
  try { void clearLiveClueDraftOwnership({ silent: true }); } catch (_) {}
  if (gameUnsub) gameUnsub();
  gameUnsub = null;
  stopLocalPracticeAI();
  if (_clueDraftSyncTimer) {
    clearTimeout(_clueDraftSyncTimer);
    _clueDraftSyncTimer = null;
  }
  _clueDraftSyncInFlight = false;
  _lastSentClueDraftSig = '';
  _clueChallengeActionBusy = false;
  _councilReviewRunning.clear();
  _liveJudgeVerdicts = {};
  if (_pendingRevealRenderTimer) {
    clearTimeout(_pendingRevealRenderTimer);
    _pendingRevealRenderTimer = null;
  }
  _deferredSnapshotRender = null;
  _localConfirmAnimUntil = 0;
  try { syncTeamConsidering(null); } catch (_) {}
  clearRevealAnimationSuppressions();
  currentGame = null;
  stopPracticeInactivityWatcher();
  const wasEphemeral = !!currentListenerEphemeral;
  currentListenerEphemeral = false;
  _prevClue = null;
  revealedPeekCardIndex = null;
  pendingCardSelection = null;
  clueTargetSelection = [];
  _pendingSelectionContextKey = null;
  spectatorMode = false;
  spectatingGameId = null;

  // Hide in-game controls in settings once we are out of a game.
  updateSettingsInGameActions(false);
  // Clear resume info only for non-ephemeral sessions.
  if (!wasEphemeral) {

  // Clear resume info when the user intentionally leaves the game.
  try {
    localStorage.removeItem(LS_ACTIVE_GAME_ID);
    localStorage.removeItem(LS_ACTIVE_GAME_SPECTATOR);
  } catch (_) {}
  }
}

/* =========================
   Game Rendering
========================= */
function showGameLobby() {
  updateSettingsInGameActions(false);
  // Go back to mode selection
  showModeSelect();
}

function showGameBoard() {
  document.getElementById('play-mode-select').style.display = 'none';
  document.getElementById('quick-play-lobby').style.display = 'none';
  document.getElementById('tournament-lobby').style.display = 'none';
  document.getElementById('game-board-container').style.display = 'flex';
  document.getElementById('panel-game').classList.add('game-active');
}

window.showGameBoard = showGameBoard;

function deriveCardsLeftFromBoard(game, team) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  let left = 0;
  for (const c of cards) {
    if (!c) continue;
    if (String(c.type || '') === team && !c.revealed) left += 1;
  }
  return left;
}

function getCardsLeft(game, team) {
  if (team !== 'red' && team !== 'blue') return 0;
  const key = team === 'red' ? 'redCardsLeft' : 'blueCardsLeft';
  const raw = Number(game?.[key]);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);

  const derived = deriveCardsLeftFromBoard(game, team);
  if (Number.isFinite(derived) && derived >= 0) return derived;

  return team === 'red' ? FIRST_TEAM_CARDS : SECOND_TEAM_CARDS;
}

function isOnlineStyleActive() {
  return document.body.classList.contains('og-mode');
}

function isOgLikeStyleActive() {
  return document.body.classList.contains('og-mode') || document.body.classList.contains('cozy-mode');
}

function isMobileLayoutLike() {
  try {
    const mm = window.matchMedia ? window.matchMedia.bind(window) : null;
    const narrow = mm ? mm('(max-width: 1024px)').matches : (window.innerWidth <= 1024);
    const coarse = mm ? mm('(hover: none) and (pointer: coarse)').matches : false;
    const shortLandscape = mm
      ? mm('(max-height: 560px) and (orientation: landscape)').matches
      : (window.innerHeight <= 560 && window.innerWidth > window.innerHeight);
    return !!(narrow && (coarse || shortLandscape));
  } catch (_) {
    return window.innerWidth <= 768;
  }
}

function syncClueSubmitButtonAppearance() {
  const form = document.getElementById('clue-form');
  const submitBtn = form?.querySelector('button[type="submit"]');
  if (!submitBtn) return;

  const iconMode = isOgLikeStyleActive();
  if (iconMode) {
    submitBtn.classList.add('clue-submit-check');
    submitBtn.setAttribute('aria-label', 'Submit clue');
    submitBtn.setAttribute('title', 'Submit clue');
    if (submitBtn.dataset.iconMode !== '1') {
      submitBtn.textContent = '';
      const icon = document.createElement('span');
      icon.className = 'clue-submit-check-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = '✓';
      submitBtn.appendChild(icon);
      submitBtn.dataset.iconMode = '1';
    }
    return;
  }

  submitBtn.classList.remove('clue-submit-check');
  submitBtn.removeAttribute('title');
  submitBtn.removeAttribute('aria-label');
  if (submitBtn.dataset.iconMode === '1') {
    submitBtn.textContent = 'Give Clue';
    submitBtn.dataset.iconMode = '0';
  }
}

// Settings modal: show/hide in-game actions when a user is inside a game.
function updateSettingsInGameActions(isInGame) {
  const section = document.getElementById('settings-in-game-actions');
  if (!section) return;

  // Keep actions visible at all times; disable when not available.
  section.style.display = 'block';

  const leaveBtn = document.getElementById('leave-game-btn');
  const endBtn = document.getElementById('end-game-btn');
  const isPractice = !!(currentGame && currentGame.type === 'practice');

  // End Game permissions:
  // - Tournament games: only your team's spymaster can end.
  // - Quick Play: anyone (including spectators) can end, to keep the lobby moving.
  const spectator = (typeof isSpectating === 'function') ? !!isSpectating() : false;
  const isQuick = !!(currentGame && currentGame.type === 'quick');
  const canEnd = isQuick
    ? true
    : (!spectator && (typeof isCurrentUserSpymaster === 'function' ? !!isCurrentUserSpymaster() : true));

  if (leaveBtn) {
    // Label updated in renderGame (Leave vs Stop Spectating)
    if (isPractice) {
      leaveBtn.disabled = true;
      leaveBtn.title = 'Practice ends automatically when you leave the page.';
    } else {
      leaveBtn.disabled = !isInGame;
      leaveBtn.title = leaveBtn.disabled ? 'Join a game to use this' : '';
    }
  }

  if (endBtn) {
    const canUse = !isPractice && isInGame && canEnd;
    endBtn.disabled = !canUse;
    if (!isInGame) {
      endBtn.title = 'Join a game to use this';
    } else if (isPractice) {
      endBtn.title = 'Practice games are local and end when you leave.';
    } else {
      endBtn.title = canUse ? '' : (spectator ? 'Spectators cannot end tournament games' : 'Only spymasters can end tournament games');
    }
  }
}

function renderGame() {
  if (!currentGame) {
    showGameLobby();
    return;
  }

  showGameBoard();
  maybeRunCouncilReviewFromSnapshot(currentGame);

  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isSpymaster = !spectator && isCurrentUserSpymaster();

  // Leave button label
  const leaveBtn = document.getElementById('leave-game-btn');
  if (leaveBtn) leaveBtn.textContent = spectator ? 'Stop Spectating' : 'Leave Game';

  // Settings: keep in-game actions visible, but only enable when allowed.
  updateSettingsInGameActions(true);

  // Update header with team names and player counts for quick play
  const redTeamEl = document.getElementById('game-red-team');
  const blueTeamEl = document.getElementById('game-blue-team');

  if (currentGame.type === 'quick') {
    const redCount = (currentGame.redPlayers || []).length;
    const blueCount = (currentGame.bluePlayers || []).length;
    if (redTeamEl) redTeamEl.textContent = `Red (${redCount})`;
    if (blueTeamEl) blueTeamEl.textContent = `Blue (${blueCount})`;
  } else {
    if (redTeamEl) redTeamEl.textContent = truncateTeamNameGame(currentGame.redTeamName || 'Red Team');
    if (blueTeamEl) blueTeamEl.textContent = truncateTeamNameGame(currentGame.blueTeamName || 'Blue Team');
  }

  const redLeftRaw = getCardsLeft(currentGame, 'red');
  const blueLeftRaw = getCardsLeft(currentGame, 'blue');
  const redLeft = Number.isFinite(redLeftRaw) ? redLeftRaw : 0;
  const blueLeft = Number.isFinite(blueLeftRaw) ? blueLeftRaw : 0;
  document.getElementById('game-red-left').textContent = String(redLeft);
  document.getElementById('game-blue-left').textContent = String(blueLeft);
  // Update turn display (kept for mobile / a11y, hidden on desktop)
  const turnTeamEl = document.getElementById('game-turn-team');
  const turnRoleEl = document.getElementById('game-turn-role');

  if (turnTeamEl && turnRoleEl) {
    if (currentGame.currentPhase === 'waiting') {
      // Waiting for players
      turnTeamEl.textContent = 'Waiting';
      turnTeamEl.className = 'turn-team';
      turnRoleEl.textContent = '(Players joining)';
    } else if (currentGame.winner) {
      turnTeamEl.textContent = truncateTeamNameGame(currentGame.winner === 'red' ? (currentGame.redTeamName || 'Red') : (currentGame.blueTeamName || 'Blue'));
      turnTeamEl.className = `turn-team ${currentGame.winner}`;
      turnRoleEl.textContent = 'WINS!';
    } else {
      turnTeamEl.textContent = truncateTeamNameGame(currentGame.currentTeam === 'red' ? (currentGame.redTeamName || 'Red') : (currentGame.blueTeamName || 'Blue'));
      turnTeamEl.className = `turn-team ${currentGame.currentTeam}`;
      if (spectator) {
        turnRoleEl.textContent = '(Spectating)';
      } else {
        turnRoleEl.textContent = currentGame.currentPhase === 'spymaster' ? '(Spymaster)' : '(Operatives)';
      }
    }
  }

  // Top bar names (desktop)
  renderTopbarTeamNames();

  // Role selection
  const roleSelectionEl = document.getElementById('role-selection');
  if (!spectator && currentGame.currentPhase === 'role-selection' && myTeamColor) {
    const mySpymaster = getTeamSpymasterName(myTeamColor, currentGame);
    if (!mySpymaster) {
      roleSelectionEl.style.display = 'block';
      updateRoleButtons();
    } else {
      roleSelectionEl.style.display = 'none';
    }
  } else {
    roleSelectionEl.style.display = 'none';
  }

  // Render board
  renderBoard(isSpymaster);

  // Clue area - handle waiting phase
  renderClueArea(isSpymaster, myTeamColor, spectator);

  // Game log
  renderGameLog();

  // Check for game end
  if (currentGame.winner) {
    showGameEndOverlay();
    // Stop AI actions once the game is decided.
    try { window.stopAIGameLoop && window.stopAIGameLoop(); } catch (_) {}
  }

  // Render advanced features
  renderAdvancedFeatures();
}

window.refreshStyleSensitiveGameUI = function refreshStyleSensitiveGameUI() {
  try { syncClueSubmitButtonAppearance(); } catch (_) {}
  if (currentGame) {
    try { renderGame(); } catch (_) {}
  }
};

// Advanced features rendering hook
function renderAdvancedFeatures() {
  if (!currentGame) return;

  // Clear pending selection if you can't currently guess
  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);
  const canGuessNow = isMyTurn && currentGame.currentPhase === 'operatives' && !isCurrentUserSpymaster() && !currentGame.winner;
  if (!canGuessNow && pendingCardSelection !== null) {
    pendingCardSelection = null;
    _pendingSelectAnimIndex = null;
    _pendingSelectionContextKey = null;
    void syncTeamConsidering(null);
    updatePendingCardSelectionUI();
  }

  const canStackNow = canCurrentUserStackClueTargets();
  if (!canStackNow && clueTargetSelection.length) {
    clueTargetSelection = [];
  } else if (canStackNow) {
    clueTargetSelection = getCurrentClueTargetSelection(currentGame);
  }

  // Load tags from localStorage for this game
  loadTagsFromLocal();

  // Render advanced UI
  renderCardTags();
  renderClueHistory();
  renderClueStackingPanel();
  renderTeamRoster();
  updateChatPrivacyBadge();

  // Hide tag legend (tagging removed)
  const tagLegend = document.getElementById('card-tag-legend');
  if (tagLegend) {
    tagLegend.style.display = 'none';
  }

  // Initialize operative chat
  initOperativeChat();

  // Backfill timer for older/legacy turns that do not have timerEnd yet.
  maybeBackfillCurrentTurnTimer(currentGame);

  // Handle timer if present
  const timerPhase = String(currentGame?.currentPhase || '');
  if (currentGame?.winner) {
    stopGameTimer();
  } else if (timerPhase === 'spymaster' || timerPhase === 'operatives') {
    if (currentGame?.timerEnd) startGameTimer(currentGame.timerEnd, timerPhase);
    else showStaticGameTimer(timerPhase);
  } else {
    stopGameTimer();
  }

  // Render OG mode panels if active
  renderOgPanels();
}

let _rosterExpandPopupHideTimer = null;
let _rosterExpandOpenBoxEl = null;
let _rosterExpandJoinBusy = false;

function getRosterExpandPopupActionStates(teamColor, seatRole) {
  if (!currentGame || currentGame.type !== 'quick') return null;
  const myId = String(getUserId?.() || '').trim();
  const myName = String(getUserName?.() || '').trim();
  if (!myId || !myName) return null;

  if (_rosterExpandJoinBusy) {
    return {
      seat: { label: 'Working...', disabled: true, hint: '' },
      spectator: { label: 'Working...', disabled: true, hint: '' },
    };
  }

  const myTeam = getQuickPlayerRole(currentGame, myId);
  const mySeat = getQuickPlayerSeatRole(currentGame, myId);
  const inProgress = !!(currentGame.currentPhase && currentGame.currentPhase !== 'waiting' && currentGame.winner == null);
  const activeJoinOn = isActiveJoinOn(currentGame);
  const isTeamMember = (myTeam === 'red' || myTeam === 'blue');
  const onTargetSeat = (myTeam === teamColor && mySeat === seatRole);

  const seat = {
    label: onTargetSeat ? 'Already Here' : ((isTeamMember && myTeam !== teamColor) ? 'Switch Team' : 'Join Team'),
    disabled: onTargetSeat,
    hint: '',
  };
  if (!seat.disabled && inProgress && !activeJoinOn && !isTeamMember) {
    seat.disabled = true;
    seat.hint = 'Active Join is off for this game right now.';
  }

  const spectator = {
    label: (myTeam === 'spectator') ? 'Spectating' : 'Spectate',
    disabled: (myTeam === 'spectator'),
    hint: '',
  };

  return { seat, spectator };
}

async function joinQuickSeatFromRosterExpand(teamColor, seatRole) {
  if (!currentGame || currentGame.type !== 'quick') return;
  if (_rosterExpandJoinBusy) return;

  _rosterExpandJoinBusy = true;
  const popup = document.getElementById('roster-expand-popup');
  if (popup?.classList.contains('visible')) {
    openRosterExpandPopup(teamColor, seatRole, _rosterExpandOpenBoxEl);
  }

  try {
    await joinQuickLobby(teamColor, seatRole);
    if (selectedQuickTeam === teamColor && selectedQuickSeatRole === seatRole) {
      spectatorMode = false;
      spectatingGameId = null;
      closeRosterExpandPopup();
    }
  } catch (err) {
    console.error('Failed to join/switch from roster popup:', err);
  } finally {
    _rosterExpandJoinBusy = false;
    if (popup?.classList.contains('visible')) {
      openRosterExpandPopup(teamColor, seatRole, _rosterExpandOpenBoxEl);
    }
  }
}

async function joinQuickSpectatorFromRosterExpand() {
  if (!currentGame || currentGame.type !== 'quick') return;
  if (_rosterExpandJoinBusy) return;

  _rosterExpandJoinBusy = true;
  const popup = document.getElementById('roster-expand-popup');
  const teamColor = popup?.dataset?.teamColor === 'blue' ? 'blue' : 'red';
  const seatRole = popup?.dataset?.seatRole === 'spymaster' ? 'spymaster' : 'operative';
  if (popup?.classList.contains('visible')) {
    openRosterExpandPopup(teamColor, seatRole, _rosterExpandOpenBoxEl);
  }

  try {
    await joinQuickLobby('spectator');
    spectatorMode = true;
    spectatingGameId = String(currentGame?.id || QUICKPLAY_DOC_ID);
    closeRosterExpandPopup();
  } catch (err) {
    console.error('Failed to spectate from roster popup:', err);
  } finally {
    _rosterExpandJoinBusy = false;
    if (popup?.classList.contains('visible')) {
      openRosterExpandPopup(teamColor, seatRole, _rosterExpandOpenBoxEl);
    }
  }
}

function closeRosterExpandPopup() {
  if (_rosterExpandOpenBoxEl?.isConnected) {
    _rosterExpandOpenBoxEl.setAttribute('aria-expanded', 'false');
  }
  _rosterExpandOpenBoxEl = null;

  const popup = document.getElementById('roster-expand-popup');
  if (!popup) return;
  popup.classList.remove('visible');
  popup.classList.remove('has-actions');
  if (_rosterExpandPopupHideTimer) clearTimeout(_rosterExpandPopupHideTimer);
  _rosterExpandPopupHideTimer = window.setTimeout(() => {
    _rosterExpandPopupHideTimer = null;
    if (!popup.classList.contains('visible')) popup.style.display = 'none';
  }, 180);
}

function openRosterExpandPopup(team, role, sourceBox = null) {
  if (!currentGame) return;
  const popup = document.getElementById('roster-expand-popup');
  const titleEl = document.getElementById('roster-expand-title');
  const subtitleEl = document.getElementById('roster-expand-subtitle');
  const listEl = document.getElementById('roster-expand-list');
  const cardEl = popup?.querySelector?.('.roster-expand-card');
  if (!popup || !titleEl || !subtitleEl || !listEl || !cardEl) return;
  let actionsEl = popup.querySelector('.roster-expand-actions');
  if (!actionsEl) {
    actionsEl = document.createElement('div');
    actionsEl.id = 'roster-expand-actions';
    actionsEl.className = 'roster-expand-actions';
    cardEl.appendChild(actionsEl);
  }
  if (_rosterExpandPopupHideTimer) {
    clearTimeout(_rosterExpandPopupHideTimer);
    _rosterExpandPopupHideTimer = null;
  }

  const teamColor = (team === 'blue') ? 'blue' : 'red';
  const seatRole = (role === 'spymaster') ? 'spymaster' : 'operative';
  const roster = getTeamPlayers(teamColor, currentGame);
  const isSpy = (p) => isSpymasterPlayerForTeam(p, teamColor, currentGame);
  const players = roster.filter((p) => seatRole === 'spymaster' ? isSpy(p) : !isSpy(p));
  const myId = String(getUserId?.() || '').trim();
  const teamNameRaw = teamColor === 'blue' ? currentGame.blueTeamName : currentGame.redTeamName;
  const teamName = String(teamNameRaw || (teamColor === 'blue' ? 'Blue Team' : 'Red Team')).trim();
  const roleLabel = seatRole === 'spymaster' ? 'Spymasters' : 'Operatives';
  popup.dataset.teamColor = teamColor;
  popup.dataset.seatRole = seatRole;

  popup.classList.remove('team-red', 'team-blue', 'role-spymaster', 'role-operative');
  popup.classList.add(teamColor === 'blue' ? 'team-blue' : 'team-red');
  popup.classList.add(seatRole === 'spymaster' ? 'role-spymaster' : 'role-operative');
  cardEl.classList.remove('team-red', 'team-blue', 'role-spymaster', 'role-operative');
  cardEl.classList.add(teamColor === 'blue' ? 'team-blue' : 'team-red');
  cardEl.classList.add(seatRole === 'spymaster' ? 'role-spymaster' : 'role-operative');

  titleEl.textContent = `${teamName} ${roleLabel}`;
  subtitleEl.textContent = players.length === 1 ? '1 player' : `${players.length} players`;

  if (!players.length) {
    listEl.innerHTML = '<div class="roster-expand-empty">No players in this seat yet.</div>';
  } else {
    listEl.innerHTML = players.map((p) => {
      const pid = String(p?.odId || p?.userId || '').trim();
      const isMe = !!(myId && pid && pid === myId);
      const ai = !!p?.isAI;
      const name = escapeHtml(displayPlayerName(p) || '—');
      const rowClasses = ['roster-expand-item', teamColor, ai ? 'is-ai' : '', isMe ? 'is-me' : ''].filter(Boolean).join(' ');
      const attrs = pid && !ai
        ? `class="${rowClasses} profile-link" data-profile-type="player" data-profile-id="${escapeHtml(pid)}"`
        : `class="${rowClasses}"`;
      const initials = escapeHtml((displayPlayerName(p) || '?').trim().slice(0, 2).toUpperCase());
      const badge = ai ? 'AI' : (isMe ? 'YOU' : 'HUMAN');
      return `
        <div ${attrs}>
          <div class="roster-expand-avatar">${initials}</div>
          <div class="roster-expand-meta">
            <div class="roster-expand-name">${name}</div>
            <div class="roster-expand-kind">${ai ? 'Autonomous AI' : 'Player'}</div>
          </div>
          <div class="roster-expand-badge">${badge}</div>
        </div>
      `;
    }).join('');
  }

  const actionStates = getRosterExpandPopupActionStates(teamColor, seatRole);
  if (actionsEl && actionStates) {
    popup.classList.add('has-actions');
    actionsEl.style.display = 'grid';
    actionsEl.innerHTML = `
      <div class="roster-expand-actions-row">
        <button
          type="button"
          class="roster-expand-action-btn team-${teamColor}"
          data-roster-seat-action="join-seat"
          ${actionStates.seat.disabled ? 'disabled' : ''}
        >${escapeHtml(actionStates.seat.label)}</button>
        <button
          type="button"
          class="roster-expand-action-btn roster-expand-action-btn-spectator"
          data-roster-seat-action="join-spectator"
          ${actionStates.spectator.disabled ? 'disabled' : ''}
        >${escapeHtml(actionStates.spectator.label)}</button>
      </div>
      ${actionStates.seat.hint ? `<div class="roster-expand-action-hint">${escapeHtml(actionStates.seat.hint)}</div>` : ''}
    `;
  } else if (actionsEl) {
    popup.classList.remove('has-actions');
    actionsEl.style.display = 'none';
    actionsEl.innerHTML = '';
  }

  if (_rosterExpandOpenBoxEl && _rosterExpandOpenBoxEl !== sourceBox && _rosterExpandOpenBoxEl.isConnected) {
    _rosterExpandOpenBoxEl.setAttribute('aria-expanded', 'false');
  }
  _rosterExpandOpenBoxEl = sourceBox || null;
  if (_rosterExpandOpenBoxEl?.isConnected) {
    _rosterExpandOpenBoxEl.setAttribute('aria-expanded', 'true');
  }

  popup.style.display = 'block';
  void popup.offsetWidth;
  popup.classList.add('visible');

  if (popup.dataset.bound !== '1') {
    popup.dataset.bound = '1';
    document.getElementById('roster-expand-close')?.addEventListener('click', closeRosterExpandPopup);
    document.getElementById('roster-expand-backdrop')?.addEventListener('click', closeRosterExpandPopup);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeRosterExpandPopup();
    });
    popup.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('[data-roster-seat-action]');
      if (!btn || btn.disabled) return;
      const action = String(btn.getAttribute('data-roster-seat-action') || '');
      if (action === 'join-spectator') {
        void joinQuickSpectatorFromRosterExpand();
        return;
      }
      if (action === 'join-seat') {
        const teamColor = popup.dataset.teamColor === 'blue' ? 'blue' : 'red';
        const seatRole = popup.dataset.seatRole === 'spymaster' ? 'spymaster' : 'operative';
        void joinQuickSeatFromRosterExpand(teamColor, seatRole);
      }
    });
  }
}

function openRosterExpandPopupForBox(box) {
  if (!box) return;
  const mobileTeamHost = box.closest('.og-mobile-team');
  const desktopTeamHost = box.closest('.og-team-panel');
  const teamHost = mobileTeamHost || desktopTeamHost;
  const team = teamHost?.id?.includes('blue') ? 'blue' : 'red';
  const role = (box.classList.contains('og-mobile-box-spy') || box.classList.contains('online-roster-spymasters'))
    ? 'spymaster'
    : 'operative';
  const popup = document.getElementById('roster-expand-popup');
  const alreadyOpen = !!(popup && popup.classList.contains('visible') && _rosterExpandOpenBoxEl === box);
  if (alreadyOpen) {
    closeRosterExpandPopup();
    return;
  }
  openRosterExpandPopup(team, role, box);
}

function bindOgDesktopBoxExpanders() {
  const panels = Array.from(document.querySelectorAll('#og-panel-blue, #og-panel-red'));
  if (!panels.length) return;

  panels.forEach((panel) => {
    const boxes = Array.from(panel.querySelectorAll('.online-roster-block'));
    boxes.forEach((box) => {
      box.classList.add('roster-expand-trigger');
      box.setAttribute('role', 'button');
      box.setAttribute('tabindex', '0');
      box.setAttribute('aria-haspopup', 'dialog');
      const expanded = !!(_rosterExpandOpenBoxEl && _rosterExpandOpenBoxEl === box);
      box.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    });

    if (panel.dataset.expandBound === '1') return;
    panel.dataset.expandBound = '1';
    let lastOpenAt = 0;
    const openFromEvent = (e) => {
      const now = Date.now();
      if (now - lastOpenAt < 180) return;
      const interactive = e.target?.closest?.('a, button, input, textarea, select');
      if (interactive && !interactive.classList.contains('online-roster-block')) return;
      const box = e.target?.closest?.('.online-roster-block');
      if (!box || !panel.contains(box)) return;
      lastOpenAt = now;
      openRosterExpandPopupForBox(box);
    };
    panel.addEventListener('click', openFromEvent);
    panel.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const box = e.target?.closest?.('.online-roster-block');
      if (!box || !panel.contains(box)) return;
      e.preventDefault();
      openRosterExpandPopupForBox(box);
    });
  });
}

function bindOgMobileBoxExpanders() {
  const panels = document.getElementById('og-mobile-panels');
  if (!panels) return;

  const boxes = Array.from(panels.querySelectorAll('.og-mobile-box'));
  boxes.forEach((box) => {
    box.setAttribute('role', 'button');
    box.setAttribute('tabindex', '0');
    box.setAttribute('aria-haspopup', 'dialog');
    const expanded = !!(_rosterExpandOpenBoxEl && _rosterExpandOpenBoxEl === box);
    box.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  });

  if (panels.dataset.expandBound !== '1') {
    panels.dataset.expandBound = '1';
    let lastOpenAt = 0;
    const openFromEvent = (e) => {
      const now = Date.now();
      if (now - lastOpenAt < 180) return;
      const interactive = e.target?.closest?.('a, button, input, textarea, select');
      if (interactive && !interactive.classList.contains('og-mobile-box')) return;
      const box = e.target?.closest?.('.og-mobile-box');
      if (!box || !panels.contains(box)) return;
      lastOpenAt = now;
      openRosterExpandPopupForBox(box);
    };
    panels.addEventListener('click', openFromEvent);
    panels.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const box = e.target?.closest?.('.og-mobile-box');
      if (!box || !panels.contains(box)) return;
      e.preventDefault();
      openRosterExpandPopupForBox(box);
    });
  }
}

function renderOgPanels() {
  const isOgMode = document.body.classList.contains('cozy-mode') || document.body.classList.contains('og-mode');
  const ogPanelBlue = document.getElementById('og-panel-blue');
  const ogPanelRed = document.getElementById('og-panel-red');
  const ogMobilePanels = document.getElementById('og-mobile-panels');

  // Dock the standard chat panel into the OG left panel on desktop.
  dockChatIntoOgPanels(isOgMode);

  if (!ogPanelBlue || !ogPanelRed) return;

  if (!isOgMode || !currentGame) {
    closeRosterExpandPopup();
    ogPanelBlue.style.display = 'none';
    ogPanelRed.style.display = 'none';
    if (ogMobilePanels) ogMobilePanels.style.display = '';
    return;
  }

  ogPanelBlue.style.display = 'flex';
  ogPanelRed.style.display = 'flex';

  // Split players into spymasters and operatives.
  // Prefer explicit role, with name field as fallback for older docs.
  const splitRoles = (team, players) => {
    const spymasters = [];
    const operatives = [];
    (players || []).forEach(p => {
      if (isSpymasterPlayerForTeam(p, team, currentGame)) spymasters.push(p);
      else operatives.push(p);
    });
    return { spymasters, operatives };
  };

  const renderSlotHtml = (players) => {
    if (!players.length) return '<div class="og-player-slot og-empty">---</div>';
    return players.map(p =>
      `<div class="og-player-slot">${escapeHtml(displayPlayerName(p))}</div>`
    ).join('');
  };

  const blue = splitRoles('blue', currentGame.bluePlayers);
  const red = splitRoles('red', currentGame.redPlayers);

  const blueCardsLeftRaw = getCardsLeft(currentGame, 'blue');
  const redCardsLeftRaw = getCardsLeft(currentGame, 'red');
  const blueCardsLeft = Number.isFinite(blueCardsLeftRaw) ? blueCardsLeftRaw : 0;
  const redCardsLeft = Number.isFinite(redCardsLeftRaw) ? redCardsLeftRaw : 0;
  const renderAgentDots = (count) => {
    const safe = Math.max(0, Math.min(9, Number(count) || 0));
    let html = '';
    for (let i = 0; i < safe; i++) html += '<span class="og-agent-dot"></span>';
    return html;
  };


  // --- Desktop panels ---
  const blueScore = document.getElementById('og-blue-score');
  const redScore = document.getElementById('og-red-score');
  if (blueScore) blueScore.textContent = blueCardsLeft;
  if (redScore) redScore.textContent = redCardsLeft;


const blueAgents = document.getElementById('og-blue-agents');
const redAgents = document.getElementById('og-red-agents');
if (blueAgents) blueAgents.innerHTML = renderAgentDots(blueCardsLeft);
if (redAgents) redAgents.innerHTML = renderAgentDots(redCardsLeft);
  const blueOps = document.getElementById('og-blue-operatives');
  const blueSpy = document.getElementById('og-blue-spymasters');
  const redOps = document.getElementById('og-red-operatives');
  const redSpy = document.getElementById('og-red-spymasters');

  if (blueOps) blueOps.innerHTML = renderSlotHtml(blue.operatives);
  if (blueSpy) blueSpy.innerHTML = renderSlotHtml(blue.spymasters);
  if (redOps) redOps.innerHTML = renderSlotHtml(red.operatives);
  if (redSpy) redSpy.innerHTML = renderSlotHtml(red.spymasters);

  // Mirror game log into slidedown panel
  const ogSlidedownLog = document.getElementById('og-gamelog-slidedown-entries');
  const existingLog = document.getElementById('game-log-entries-sidebar');
  if (ogSlidedownLog && existingLog) {
    ogSlidedownLog.innerHTML = existingLog.innerHTML;
  }
  const ogSlidedownLeft = document.getElementById('og-gamelog-slidedown-clues-left');
  const existingLeft = document.getElementById('game-log-clues-left-sidebar');
  if (ogSlidedownLeft && existingLeft) {
    ogSlidedownLeft.innerHTML = existingLeft.innerHTML;
  }
  applyGameLogTabState();

  // --- Mobile panels ---
  const mBlueScore = document.getElementById('og-mobile-blue-score');
  const mRedScore = document.getElementById('og-mobile-red-score');
  if (mBlueScore) mBlueScore.textContent = blueCardsLeft;
  if (mRedScore) mRedScore.textContent = redCardsLeft;

  const mBlueAgents = document.getElementById('og-mobile-blue-agents');
  const mRedAgents = document.getElementById('og-mobile-red-agents');
  if (mBlueAgents) mBlueAgents.innerHTML = renderAgentDots(blueCardsLeft);
  if (mRedAgents) mRedAgents.innerHTML = renderAgentDots(redCardsLeft);

  const mBlueOps = document.getElementById('og-mobile-blue-operatives');
  const mRedOps = document.getElementById('og-mobile-red-operatives');
  const mBlueSpy = document.getElementById('og-mobile-blue-spymasters');
  const mRedSpy = document.getElementById('og-mobile-red-spymasters');
  if (mBlueOps) mBlueOps.innerHTML = renderSlotHtml(blue.operatives);
  if (mRedOps) mRedOps.innerHTML = renderSlotHtml(red.operatives);
  if (mBlueSpy) mBlueSpy.innerHTML = renderSlotHtml(blue.spymasters);
  if (mRedSpy) mRedSpy.innerHTML = renderSlotHtml(red.spymasters);


  // --- OG top bar player count ---
  const countEl = document.getElementById('og-player-count');
  if (countEl) {
    const total = (currentGame.bluePlayers?.length || 0) + (currentGame.redPlayers?.length || 0);
    countEl.textContent = total;
  }

  bindOgMobileBoxExpanders();
  bindOgDesktopBoxExpanders();
}

function dockChatIntoOgPanels(isOgMode) {
  const chatPanel = document.querySelector('.operative-chat-panel');
  const hostDesktop = document.getElementById('og-chat-host');
  const hostMobile = document.getElementById('og-mobile-chat-host');

  if (!chatPanel) return;

  const isMobile = isMobileLayoutLike();
  const mobileChatOpen = !!document.getElementById('og-chat-slidedown')?.classList.contains('open');

  // Save original location once
  if (!ogChatOriginalParent) {
    ogChatOriginalParent = chatPanel.parentElement;
    ogChatOriginalNextSibling = chatPanel.nextElementSibling;
  }

  const targetHost = isOgMode
    ? (isMobile ? (mobileChatOpen ? hostMobile : null) : hostDesktop)
    : null;

  if (targetHost) {
    if (chatPanel.parentElement !== targetHost) {
      targetHost.appendChild(chatPanel);
    }
    chatPanel.classList.add('og-docked-chat');
    chatPanel.classList.toggle('og-docked-chat-mobile', !!isMobile);
  } else {
    // Restore to original container when leaving OG panels.
    if (ogChatOriginalParent && chatPanel.parentElement !== ogChatOriginalParent) {
      if (ogChatOriginalNextSibling && ogChatOriginalParent.contains(ogChatOriginalNextSibling)) {
        ogChatOriginalParent.insertBefore(chatPanel, ogChatOriginalNextSibling);
      } else {
        ogChatOriginalParent.appendChild(chatPanel);
      }
    }
    chatPanel.classList.remove('og-docked-chat');
    chatPanel.classList.remove('og-docked-chat-mobile');
  }
}

function renderBoard(isSpymaster) {
  const boardEl = document.getElementById('game-board');
  if (!boardEl || !currentGame?.cards) return;
  setupBoardCardInteractions();
  const isOgMode = isOnlineStyleActive();
  const boardWordFitKey = currentGame.cards.map((c) => `${String(c?.word || '')}:${c?.revealed ? 1 : 0}`).join('|');
  const boardWordFitViewportKey = `${window.innerWidth}x${window.innerHeight}`;

  // If the peeked card is no longer revealed (new board / reset), clear stale state.
  if (revealedPeekCardIndex !== null && revealedPeekCardIndex !== undefined) {
    const peeked = currentGame.cards[revealedPeekCardIndex];
    if (!peeked || !peeked.revealed) revealedPeekCardIndex = null;
  }

  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);
  const canGuess = isMyTurn && currentGame.currentPhase === 'operatives' && !isSpymaster && !currentGame.winner;
  const canStackTargets = isMyTurn
    && currentGame.currentPhase === 'spymaster'
    && isSpymaster
    && !currentGame.winner
    && !hasBlockingPendingClue(currentGame)
    && isStackingEnabledForGame(currentGame);
  if (!canStackTargets && clueTargetSelection.length) {
    clueTargetSelection = [];
  }
  const selectedStackTargets = canStackTargets ? getCurrentClueTargetSelection(currentGame) : [];
  clueTargetSelection = selectedStackTargets;
  const stackTargetSet = new Set(selectedStackTargets);
  const stackTargetOrderByIndex = new Map(selectedStackTargets.map((idx, order) => [idx, order + 1]));
  const currentSelectionContextKey = getPendingSelectionContextKey(currentGame);
  const hasStoredPendingSelection =
    pendingCardSelection !== null &&
    pendingCardSelection !== undefined &&
    String(pendingCardSelection).trim() !== '';
  const pendingIdx = hasStoredPendingSelection ? Number(pendingCardSelection) : NaN;
  const hasPendingSelection = hasStoredPendingSelection && Number.isInteger(pendingIdx) && pendingIdx >= 0 && pendingIdx < currentGame.cards.length;
  const pendingCard = hasPendingSelection ? currentGame.cards[pendingIdx] : null;
  const stalePendingSelection =
    !canGuess ||
    !hasPendingSelection ||
    !!pendingCard?.revealed ||
    !!(_pendingSelectionContextKey && _pendingSelectionContextKey !== currentSelectionContextKey);

  if (stalePendingSelection) {
    if (hasStoredPendingSelection) {
      void syncTeamConsidering(null);
    }
    pendingCardSelection = null;
    _pendingSelectAnimIndex = null;
    _pendingSelectionContextKey = null;
  } else {
    pendingCardSelection = pendingIdx;
  }

  const turnTeam = (currentGame?.currentTeam === 'red' || currentGame?.currentTeam === 'blue')
    ? currentGame.currentTeam
    : null;
  const canViewTurnConsidering = !!turnTeam && (spectator || (myTeamColor && myTeamColor === turnTeam));
  const teamConsidering = canViewTurnConsidering
    ? (turnTeam === 'red' ? (currentGame?.redConsidering || {}) : (currentGame?.blueConsidering || {}))
    : {};
  const myOwnerId = getCurrentMarkerOwnerId();

  boardEl.innerHTML = currentGame.cards.map((card, i) => {
    const classes = ['game-card'];
    const canTargetThisCard = canStackTargets && !card.revealed && String(card.type || '') === String(myTeamColor || '');

    if (card.revealed) {
      classes.push('revealed');
      classes.push(`card-${card.type}`);
      if (isOgMode && revealedPeekCardIndex === i) classes.push('revealed-peek');
    } else if (isSpymaster && !spectator) {
      classes.push('spymaster-view');
      classes.push(`card-${card.type}`);
      if (canTargetThisCard) classes.push('stacking-selectable');
      else classes.push('disabled');
    } else if (!canGuess) {
      classes.push('disabled');
    }

    // Pending selection highlight
    if (canGuess && !card.revealed && pendingCardSelection === i) {
      classes.push('pending-select');
    }
    if (canTargetThisCard && stackTargetSet.has(i)) {
      classes.push('stacking-selected');
    }

    const word = escapeHtml(card.word);
    const confirmLabel = escapeHtml(`Confirm ${card.word}`);
    const stackOrder = Number(stackTargetOrderByIndex.get(i) || 0);
    const stackOrderHtml = stackOrder
      ? `<div class="card-stack-order" aria-hidden="true">${stackOrder}</div>`
      : '';
    const consideringEntries = (!card.revealed)
      ? getTeamConsideringEntriesForCard(teamConsidering, i, myOwnerId)
      : [];
    let consideringVisible = [...consideringEntries];
    if (canGuess && pendingCardSelection === i && !consideringVisible.some(entry => entry.isMine)) {
      consideringVisible.unshift({
        owner: myOwnerId,
        initials: getPlayerInitials(getUserName()),
        name: getUserName() || 'You',
        ts: Date.now(),
        isMine: true
      });
    }
    const visibleConsidering = consideringVisible.slice(0, 4);
    const consideringHtml = visibleConsidering.length
      ? `
          <div class="card-considering-row" aria-hidden="true">
            ${visibleConsidering.map(entry => {
              const initials = escapeHtml(String(entry.initials || '?').slice(0, 3));
              const title = escapeHtml(entry.name || 'Teammate');
              return `<span class="card-considering-chip ${entry.isMine ? 'mine' : ''} ${entry.isAI ? 'ai' : ''}" title="${title}">${initials}</span>`;
            }).join('')}
            ${consideringVisible.length > visibleConsidering.length
              ? `<span class="card-considering-chip more">+${consideringVisible.length - visibleConsidering.length}</span>`
              : ''}
          </div>
        `
      : '';
    const backFace = isOgMode
      ? `
          <div class="card-face card-back">
            <span class="card-word"><span class="word-text">${word}</span></span>
          </div>
        `
      : '';
    return `
      <div class="${classes.join(' ')}" data-index="${i}">
        ${consideringHtml}
        ${stackOrderHtml}
        <div class="og-peek-label" aria-hidden="true">${word}</div>
        <div class="card-inner">
          <div class="card-face card-front">
            <span class="card-word"><span class="word-text">${word}</span></span>
            <div class="og-reveal-face" aria-hidden="true">
              <div class="og-reveal-icon"></div>
            </div>
          </div>
          ${backFace}
        </div>
        <button type="button" class="card-checkmark" data-card-index="${i}" aria-label="${confirmLabel}" title="${confirmLabel}">✓</button>
      </div>
    `;
  }).join('');

  // Fit words only when board/reveal state or viewport changed.
  const shouldRefitWords =
    boardWordFitKey !== _lastWordFitBoardKey ||
    boardWordFitViewportKey !== _lastWordFitViewportKey;
  if (shouldRefitWords) {
    _lastWordFitBoardKey = boardWordFitKey;
    _lastWordFitViewportKey = boardWordFitViewportKey;
    scheduleFitCardWords();
  }

  // Tags removed – no longer rendering card tags
}


// --- Card word fitting (prevents overflow and reduces eye strain) ---
let _lastWordFitBoardKey = '';
let _lastWordFitViewportKey = '';

function fitAllCardWords() {
  const containers = document.querySelectorAll('.game-card .card-word');
  containers.forEach(container => {
    const textEl = container.querySelector('.word-text') || container;

    // Reset any previous inline sizing so we start from CSS defaults
    textEl.style.fontSize = '';
    textEl.style.letterSpacing = '';
    textEl.style.transform = '';
    textEl.style.transformOrigin = '';

    const cs = getComputedStyle(textEl);
    const baseSize = parseFloat(cs.fontSize) || 14;
    const baseLS = parseFloat(cs.letterSpacing) || 0;

    let size = baseSize;
    const minSize = window.innerWidth <= 768 ? 5 : 8;
    let guard = 0;

    // Use the container as the constraint box (this is the visible label strip)
    const boxW = container.clientWidth;
    const boxH = container.clientHeight;
    if (!boxW || !boxH) return;

    const overflows = () => (textEl.scrollWidth > boxW || textEl.scrollHeight > boxH);

    // First pass: reduce font-size until it fits
    while (guard < 80 && size > minSize && overflows()) {
      size -= 0.5;
      textEl.style.fontSize = size + 'px';
      // Reduce tracking a bit as we shrink (helps long words feel less cramped)
      const scaledLS = Math.max(0, baseLS * (size / baseSize) * 0.85);
      if (!Number.isNaN(scaledLS)) textEl.style.letterSpacing = scaledLS + 'px';
      guard++;
    }

    // Second pass: if we still overflow (very long words), compress in X/Y slightly.
    // This keeps the label box geometry consistent without clipping.
    if (overflows()) {
      const sw = textEl.scrollWidth || 1;
      const sh = textEl.scrollHeight || 1;
      const minRatioX = window.innerWidth <= 768 ? 0.58 : 0.72;
      const minRatioY = window.innerWidth <= 768 ? 0.72 : 0.82;
      const ratioX = Math.max(minRatioX, Math.min(1, (boxW - 1) / sw));
      const ratioY = Math.max(minRatioY, Math.min(1, (boxH - 1) / sh));
      textEl.style.transformOrigin = 'center';
      textEl.style.transform = `scale(${ratioX}, ${ratioY})`;
      // Slightly reduce tracking to avoid "smeared" look when scaled
      const tighterLS = Math.max(0, (parseFloat(getComputedStyle(textEl).letterSpacing) || 0) * 0.85);
      textEl.style.letterSpacing = tighterLS + 'px';
    }
  });
}

let _fitWordsRaf = null;
function scheduleFitCardWords() {
  if (_fitWordsRaf) cancelAnimationFrame(_fitWordsRaf);
  _fitWordsRaf = requestAnimationFrame(() => {
    _fitWordsRaf = null;
    fitAllCardWords();
  });
}

window.addEventListener('resize', () => {
  _lastWordFitViewportKey = '';
  scheduleFitCardWords();
});

// Fonts can load after the board renders, changing text metrics.
// Re-fit once fonts are ready to prevent overflow (especially in OG mode).
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => {
    setTimeout(scheduleFitCardWords, 0);
    setTimeout(scheduleFitCardWords, 120);
  }).catch(() => {});
}

function isStackingSettingEnabledLocal() {
  const key = (typeof LS_SETTINGS_STACKING === 'string' && LS_SETTINGS_STACKING)
    ? LS_SETTINGS_STACKING
    : 'ct_stacking_v1';
  try {
    if (typeof window.isStackingEnabled === 'function') {
      return !!window.isStackingEnabled();
    }
  } catch (_) {}
  try {
    return String(localStorage.getItem(key) || '').toLowerCase() === 'true';
  } catch (_) {
    return false;
  }
}

function isStackingEnabledForGame(game = currentGame) {
  if (!isStackingSettingEnabledLocal()) return false;
  if (!game || typeof game !== 'object') return true;

  if (String(game.type || '') === 'quick') {
    const quick = getQuickSettings(game);
    return quick.stackingEnabled !== false;
  }

  if (String(game.type || '') === 'practice') {
    const practice = (game.practice && typeof game.practice === 'object') ? game.practice : {};
    return practice.stackingEnabled !== false;
  }

  return true;
}

function normalizeClueTargetSelection(selection = [], game = currentGame, teamOverride = null, opts = {}) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  const team = (teamOverride === 'blue' || teamOverride === 'red')
    ? teamOverride
    : ((game?.currentTeam === 'blue') ? 'blue' : 'red');
  const allowRevealed = !!opts.allowRevealed;
  const seen = new Set();
  const normalized = [];
  (Array.isArray(selection) ? selection : []).forEach((raw) => {
    const idx = Number(raw);
    if (!Number.isInteger(idx) || idx < 0 || idx >= cards.length) return;
    if (seen.has(idx)) return;
    const card = cards[idx];
    if (!card || (!allowRevealed && card.revealed)) return;
    if (String(card.type || '') !== team) return;
    seen.add(idx);
    normalized.push(idx);
  });
  return normalized;
}

function canCurrentUserStackClueTargets() {
  if (!currentGame || currentGame.winner) return false;
  if (currentGame.currentPhase !== 'spymaster') return false;
  if (hasBlockingPendingClue(currentGame)) return false;
  if (isSpectating()) return false;
  if (!isCurrentUserSpymaster()) return false;
  const myTeamColor = getMyTeamColor();
  if (!myTeamColor || currentGame.currentTeam !== myTeamColor) return false;
  return isStackingEnabledForGame(currentGame);
}

function getCurrentClueTargetSelection(game = currentGame) {
  const team = (typeof getMyTeamColor === 'function') ? getMyTeamColor() : null;
  return normalizeClueTargetSelection(clueTargetSelection, game, team);
}

function getClueTargetWords(indices = [], game = currentGame) {
  const cards = Array.isArray(game?.cards) ? game.cards : [];
  return (Array.isArray(indices) ? indices : [])
    .map((idx) => String(cards?.[idx]?.word || '').trim())
    .filter(Boolean);
}

function clearClueTargetSelection(opts = {}) {
  const changed = Array.isArray(clueTargetSelection) && clueTargetSelection.length > 0;
  clueTargetSelection = [];
  if (opts.refreshGame && changed && currentGame) {
    try { renderGame(); } catch (_) {}
    return;
  }
  if (!opts.skipPanelSync) renderClueStackingPanel();
}

function toggleClueTargetSelection(cardIndex) {
  if (!canCurrentUserStackClueTargets()) return;
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;
  const myTeamColor = getMyTeamColor();
  const card = currentGame?.cards?.[idx];
  if (!card || card.revealed) return;
  if (String(card.type || '') !== String(myTeamColor || '')) return;

  const next = getCurrentClueTargetSelection(currentGame);
  const at = next.indexOf(idx);
  if (at >= 0) next.splice(at, 1);
  else next.push(idx);
  clueTargetSelection = next;
  try { renderGame(); } catch (_) {}
}

function renderClueStackingPanel() {
  const panel = document.getElementById('clue-stack-panel');
  const summaryEl = document.getElementById('clue-stack-summary');
  const chipRow = document.getElementById('clue-stack-chip-row');
  const inputSlot = document.getElementById('clue-stack-input-slot');
  const clueForm = document.getElementById('clue-form');
  const actionBar = panel ? panel.closest('.game-action-bar') : null;
  const numInput = document.getElementById('clue-num-input');
  const minusBtn = document.getElementById('og-num-minus');
  const plusBtn = document.getElementById('og-num-plus');
  const stackingActive = canCurrentUserStackClueTargets();
  document.body.classList.toggle('stacking-turn-active', stackingActive);
  if (!panel || !summaryEl || !chipRow) return;

  if (!stackingActive) {
    panel.style.display = 'none';
    chipRow.innerHTML = '';
    // Move clue form back out of stacking panel to action bar (after the panel)
    if (clueForm && actionBar && clueForm.parentElement === inputSlot) {
      panel.insertAdjacentElement('afterend', clueForm);
    }
    if (numInput) numInput.disabled = false;
    if (minusBtn) minusBtn.disabled = false;
    if (plusBtn) plusBtn.disabled = false;
    return;
  }

  const selected = getCurrentClueTargetSelection(currentGame);
  clueTargetSelection = selected;
  panel.style.display = 'flex';

  // Move clue form into stacking panel input slot
  if (clueForm && inputSlot && clueForm.parentElement !== inputSlot) {
    inputSlot.appendChild(clueForm);
  }

  if (selected.length > 0) {
    summaryEl.textContent = `${selected.length} target${selected.length === 1 ? '' : 's'} selected`;
  } else {
    summaryEl.textContent = 'Tap your team cards to mark clue targets';
  }

  const words = getClueTargetWords(selected, currentGame);
  if (!words.length) {
    chipRow.innerHTML = '<span class="clue-stack-chip clue-stack-chip-empty">No cards selected</span>';
  } else {
    chipRow.innerHTML = words.map((word, idx) => (
      `<span class="clue-stack-chip">${idx + 1}. ${escapeHtml(String(word).toUpperCase())}</span>`
    )).join('');
  }

  if (numInput) {
    numInput.disabled = true;
    if (selected.length > 0) {
      numInput.value = String(Math.max(0, Math.min(9, selected.length)));
    } else if (!String(numInput.value || '').trim()) {
      numInput.value = '1';
    }
  }
  if (minusBtn) minusBtn.disabled = true;
  if (plusBtn) plusBtn.disabled = true;
}

function normalizePendingClueEntry(raw, game = currentGame) {
  if (!raw || typeof raw !== 'object') return null;
  const team = String(raw.team || '').toLowerCase() === 'blue' ? 'blue' : 'red';
  const word = String(raw.word || '').trim().toUpperCase();
  const number = Number(raw.number);
  const id = String(raw.id || '').trim();
  if (!word || !Number.isFinite(number) || !id) return null;
  const stateRaw = String(raw.state || 'awaiting').toLowerCase();
  const state = (stateRaw === 'reviewing' || stateRaw === 'rejected') ? stateRaw : 'awaiting';
  const targets = getClueTargetIndicesFromEntry(raw, game);
  const targetWords = Array.isArray(raw.targetWords)
    ? raw.targetWords.map((w) => String(w || '').trim()).filter(Boolean)
    : getClueTargetWords(targets, game);
  return {
    ...raw,
    id,
    team,
    word,
    number: Math.max(0, Math.min(9, Math.floor(number))),
    state,
    targets,
    targetWords,
    byId: String(raw.byId || '').trim(),
    byName: String(raw.byName || '').trim(),
    seqField: String(raw.seqField || '').trim(),
    challengedById: String(raw.challengedById || '').trim(),
    challengedByName: String(raw.challengedByName || '').trim(),
    submittedAtMs: Number(raw.submittedAtMs || 0),
  };
}

function hasBlockingPendingClue(game = currentGame) {
  const pending = normalizePendingClueEntry(game?.pendingClue, game);
  if (!pending) return false;
  return pending.state === 'awaiting' || pending.state === 'reviewing';
}

function getTeamSpymasterPlayer(team, game = currentGame) {
  const players = getTeamPlayers(team, game);
  return players.find((p) => isSpymasterPlayerForTeam(p, team, game)) || null;
}

function hasHumanOpposingSpymaster(game, team) {
  const t = team === 'blue' ? 'blue' : 'red';
  const opp = t === 'red' ? 'blue' : 'red';
  const oppSpy = getTeamSpymasterPlayer(opp, game);
  return !!(oppSpy && !oppSpy.isAI);
}

function hasOpposingSpymaster(game, team) {
  const t = team === 'blue' ? 'blue' : 'red';
  const opp = t === 'red' ? 'blue' : 'red';
  return !!getTeamSpymasterPlayer(opp, game);
}

function shouldOfferChallengeForPendingClue(game, team) {
  const isPractice = String(game?.type || '') === 'practice';
  if (isPractice) return hasOpposingSpymaster(game, team);
  return hasHumanOpposingSpymaster(game, team);
}

function normalizeLiveClueDraft(raw, game = currentGame) {
  if (!raw || typeof raw !== 'object') return null;
  const team = String(raw.team || '').toLowerCase() === 'blue' ? 'blue' : 'red';
  // Live clue drafts are for realtime UX while a spymaster types.
  // Operatives should see masked progress, but opposing spymasters may see the exact text.
  const word = String(raw.word || '').trim().toUpperCase().slice(0, 40);
  const wordLenRaw = (raw.wordLen ?? raw.len ?? raw.wordLength);
  const wordLen = Number.isFinite(Number(wordLenRaw))
    ? Math.max(0, Math.min(40, Math.floor(Number(wordLenRaw))))
    : Math.max(0, Math.min(40, word.length));

  const numberRaw = String(raw.number ?? '').trim();
  const number = numberRaw === '' ? '' : String(Math.max(0, Math.min(9, parseInt(numberRaw, 10) || 0)));
  const byId = String(raw.byId || '').trim();
  const byName = String(raw.byName || '').trim();
  const updatedAtMs = Number(raw.updatedAtMs || 0);
  const activeTeam = String(game?.currentTeam || '').toLowerCase() === 'blue' ? 'blue' : 'red';
  if (team !== activeTeam) return null;
  if (!word && !number) return null;
  return { team, word, wordLen, number, byId, byName, updatedAtMs };
}

function canPublishLiveClueDraft(game = currentGame) {
  if (!game || game.winner) return false;
  if (String(game.type || '') === 'practice') return false;
  if (String(game.currentPhase || '') !== 'spymaster') return false;
  if (hasBlockingPendingClue(game)) return false;
  if (isSpectating()) return false;
  if (!isCurrentUserSpymaster()) return false;
  const myTeam = getMyTeamColor();
  if (!myTeam || String(game.currentTeam || '') !== myTeam) return false;
  return true;
}

function buildLiveClueDraftPayload(game = currentGame) {
  if (!canPublishLiveClueDraft(game)) return null;
  const wordInput = document.getElementById('clue-input');
  const numInput = document.getElementById('clue-num-input');
  const word = String(wordInput?.value || '').trim().toUpperCase().slice(0, 40);
  const wordLen = word.length;
  const numRaw = String(numInput?.value || '').trim();
  const number = numRaw ? String(Math.max(0, Math.min(9, parseInt(numRaw, 10) || 0))) : '';
  const team = String(game.currentTeam || '') === 'blue' ? 'blue' : 'red';
  const byId = String(getUserId?.() || '').trim();
  const byName = String(getUserName?.() || '').trim();
  if (!word && !number) return null;
  return {
    team,
    word,
    wordLen,
    number,
    byId,
    byName,
    updatedAtMs: Date.now(),
  };
}

function queueLiveClueDraftSync(opts = {}) {
  const force = !!opts.force;
  if (_clueDraftSyncTimer) clearTimeout(_clueDraftSyncTimer);
  _clueDraftSyncTimer = setTimeout(() => {
    _clueDraftSyncTimer = null;
    void flushLiveClueDraftSync({ force });
  }, force ? 0 : 140);
}

async function clearLiveClueDraftOwnership(opts = {}) {
  await flushLiveClueDraftSync({ force: true, clearOnly: true, silent: !!opts.silent });
}

async function flushLiveClueDraftSync(opts = {}) {
  if (_clueDraftSyncInFlight) return;
  if (!currentGame?.id) return;
  if (isCurrentLocalPracticeGame()) return;

  const force = !!opts.force;
  const clearOnly = !!opts.clearOnly;
  const payload = clearOnly ? null : buildLiveClueDraftPayload(currentGame);
  const sig = payload
    ? `set|${payload.team}|${payload.word}|${payload.wordLen}|${payload.number}|${payload.byId}`
    : `clear|${String(getUserId?.() || '').trim()}`;
  if (!force && sig === _lastSentClueDraftSig) return;

  _clueDraftSyncInFlight = true;
  const gid = String(currentGame.id || '').trim();
  const ref = db.collection('games').doc(gid);
  try {
    if (payload) {
      await ref.update({
        liveClueDraft: payload,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    } else {
      const myId = String(getUserId?.() || '').trim();
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const game = snap.data() || {};
        const live = game.liveClueDraft;
        const owner = String(live?.byId || '').trim();
        if (owner && myId && owner !== myId) return;
        tx.update(ref, {
          liveClueDraft: firebase.firestore.FieldValue.delete(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });
    }
    _lastSentClueDraftSig = sig;
  } catch (e) {
    if (!opts.silent) console.warn('Live clue draft sync failed:', e);
  } finally {
    _clueDraftSyncInFlight = false;
  }
}

function buildClueEntryFromPending(pending) {
  return {
    team: pending.team,
    word: pending.word,
    number: pending.number,
    targets: Array.isArray(pending.targets) ? pending.targets : [],
    targetWords: Array.isArray(pending.targetWords) ? pending.targetWords : [],
    results: [],
    timestamp: new Date().toISOString(),
  };
}

function buildCouncilSummaryLine(pending, review) {
  const legalVotes = Number(review?.legalVotes || 0);
  const illegalVotes = Number(review?.illegalVotes || 0);
  const verdict = review?.verdict === 'legal' ? 'LEGAL' : 'ILLEGAL';
  return `Council ruled "${pending.word}" for ${pending.number}: ${verdict} (${legalVotes}-${illegalVotes}).`;
}

function buildAcceptedClueRemoteUpdates(game, pending, opts = {}) {
  const teamName = pending.team === 'red'
    ? (game.redTeamName || 'Red Team')
    : (game.blueTeamName || 'Blue Team');
  const clueLog = `${teamName} Spymaster: "${pending.word}" for ${pending.number}`;
  const logLines = [clueLog];
  if (opts.review) logLines.push(buildCouncilSummaryLine(pending, opts.review));
  const updates = {
    currentClue: { word: pending.word, number: pending.number },
    pendingClue: firebase.firestore.FieldValue.delete(),
    liveClueDraft: firebase.firestore.FieldValue.delete(),
    guessesRemaining: (pending.number === 0 ? 0 : (pending.number + 1)),
    currentPhase: 'operatives',
    timerEnd: buildPhaseTimerEndValue(game, 'operatives'),
    log: firebase.firestore.FieldValue.arrayUnion(...logLines),
    clueHistory: firebase.firestore.FieldValue.arrayUnion(buildClueEntryFromPending(pending)),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
  };
  if (opts.seqField) updates[opts.seqField] = firebase.firestore.FieldValue.increment(1);
  return updates;
}

function applyAcceptedClueLocalState(draft, pending, opts = {}) {
  const teamName = pending.team === 'red' ? (draft.redTeamName || 'Red Team') : (draft.blueTeamName || 'Blue Team');
  draft.currentClue = { word: pending.word, number: pending.number };
  draft.pendingClue = null;
  draft.liveClueDraft = null;
  draft.guessesRemaining = (pending.number === 0 ? 0 : (pending.number + 1));
  draft.currentPhase = 'operatives';
  draft.timerEnd = buildPhaseTimerEndValue(draft, 'operatives');
  draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
  draft.log.push(`${teamName} Spymaster: "${pending.word}" for ${pending.number}`);
  if (opts.review) draft.log.push(buildCouncilSummaryLine(pending, opts.review));
  draft.clueHistory = Array.isArray(draft.clueHistory) ? [...draft.clueHistory] : [];
  draft.clueHistory.push(buildClueEntryFromPending(pending));
  draft.updatedAtMs = Date.now();
  draft.lastMoveAtMs = Date.now();
  if (opts.seqField) {
    const cur = Number(draft?.[opts.seqField] || 0);
    draft[opts.seqField] = Number.isFinite(cur) ? cur + 1 : 1;
  }
}

function isUserSpymasterForTeamInGame(game, team, userId = '', userName = '') {
  if (!game || (team !== 'red' && team !== 'blue')) return false;
  const roster = getTeamPlayers(team, game);
  const uid = String(userId || '').trim();
  const unameNorm = normalizeSpyIdentity(userName || '');
  const me = roster.find((p) => {
    const pid = String(p?.odId || p?.userId || p?.id || '').trim();
    if (uid && pid && pid === uid) return true;
    if (!unameNorm) return false;
    return normalizeSpyIdentity(p?.name) === unameNorm;
  }) || null;
  if (!me) return false;
  return isSpymasterPlayerForTeam(me, team, game);
}

function canCurrentUserChallengePendingClue(pending, game = currentGame) {
  if (!pending || !game) return false;
  if (pending.state !== 'awaiting') return false;
  if (isSpectating()) return false;
  const myTeam = getMyTeamColor();
  if (myTeam !== 'red' && myTeam !== 'blue') return false;
  if (myTeam === pending.team) return false;
  const uid = String(getUserId?.() || '').trim();
  const uname = String(getUserName?.() || '').trim();
  return isUserSpymasterForTeamInGame(game, myTeam, uid, uname);
}

function basicClueLegalityCheck(pending, game = currentGame) {
  const word = String(pending?.word || '').trim().toUpperCase();
  if (!word) return { legal: false, reason: 'Clue is empty.' };
  if (word.includes(' ') || word.includes('-')) return { legal: false, reason: 'Clue must be one word.' };
  const boardWords = new Set((game?.cards || []).map((c) => String(c?.word || '').trim().toUpperCase()).filter(Boolean));
  if (boardWords.has(word)) return { legal: false, reason: 'Clue cannot match a board word.' };
  const n = Number(pending?.number);
  if (!Number.isFinite(n) || n < 0 || n > 9) return { legal: false, reason: 'Clue number must be 0-9.' };
  return { legal: true, reason: 'Passes hard-rule checks.' };
}

async function decidePracticeAISpymasterPendingAction(aiSpy, game, pending) {
  const baseline = basicClueLegalityCheck(pending, game);
  if (!baseline.legal) {
    return {
      decision: 'challenge',
      reason: baseline.reason,
      baseline,
    };
  }

  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') {
    return {
      decision: 'allow',
      reason: 'Fallback allow (hard checks passed).',
      baseline,
    };
  }

  const boardWords = (game?.cards || [])
    .map((c) => String(c?.word || '').trim().toUpperCase())
    .filter(Boolean);
  const system = [
    'You are a Codenames spymaster deciding whether to challenge an opponent clue for legality.',
    'Challenge only for likely ILLEGAL clues. Do not challenge for strategy disagreement.',
    'Hard rules:',
    '- one word only (no spaces or hyphens)',
    '- cannot match any board word',
    '- clue number must be 0-9',
    'Return JSON only:',
    '{"decision":"allow|challenge","reason":"short reason"}',
  ].join('\n');
  const user = [
    `YOUR NAME: ${String(aiSpy?.name || 'AI').trim() || 'AI'}`,
    `CLUE: "${pending.word}"`,
    `NUMBER: ${pending.number}`,
    `BOARD WORDS: ${boardWords.join(', ')}`,
    `HARD CHECK: pass`,
    'Would you ALLOW or CHALLENGE this clue for legality?',
  ].join('\n');

  try {
    const raw = await chatFn(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        temperature: 0.35,
        max_tokens: 140,
        response_format: { type: 'json_object' },
      }
    );
    const parsed = safeJsonParse(raw);
    const decisionRaw = String(parsed?.decision || '').trim().toLowerCase();
    const decision = decisionRaw === 'challenge' ? 'challenge' : 'allow';
    const reason = String(parsed?.reason || '').trim().slice(0, 140) || 'No reason provided.';
    return { decision, reason, baseline };
  } catch (_) {
    return {
      decision: 'allow',
      reason: 'Fallback allow (judge unavailable).',
      baseline,
    };
  }
}

async function maybeResolveLocalPracticePendingClue(gameId, game) {
  if (!isLocalPracticeGameId(gameId)) return false;
  const pending = normalizePendingClueEntry(game?.pendingClue, game);
  if (!pending || pending.state !== 'awaiting') return false;

  const opposingTeam = pending.team === 'red' ? 'blue' : 'red';
  const opposingSpy = getTeamSpymasterPlayer(opposingTeam, game);
  if (!opposingSpy || !opposingSpy.isAI) return false;

  const aiSpy = toLocalPracticeRuntimeAI(opposingSpy, opposingTeam);
  const live = getLocalPracticeGame(gameId);
  const livePending = normalizePendingClueEntry(live?.pendingClue, live);
  if (!live || !livePending || livePending.id !== pending.id || livePending.state !== 'awaiting') return false;

  const decision = await decidePracticeAISpymasterPendingAction(aiSpy, live, livePending);
  const actorName = String(opposingSpy?.name || aiSpy?.name || 'AI').trim() || 'AI';

  if (decision.decision === 'challenge') {
    mutateLocalPracticeGame(gameId, (draft) => {
      const currentPending = normalizePendingClueEntry(draft.pendingClue, draft);
      if (!currentPending || currentPending.id !== livePending.id || currentPending.state !== 'awaiting') return;
      draft.pendingClue = {
        ...currentPending,
        state: 'reviewing',
        challengedById: String(opposingSpy?.odId || opposingSpy?.id || aiSpy?.id || '').trim(),
        challengedByName: actorName,
        challengedAtMs: Date.now(),
      };
      draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
      draft.log.push(`${actorName} challenged "${currentPending.word}" (${decision.reason}).`);
      draft.updatedAtMs = Date.now();
    });
    const after = getLocalPracticeGame(gameId);
    const afterPending = normalizePendingClueEntry(after?.pendingClue, after);
    if (afterPending && afterPending.state === 'reviewing') {
      void runCouncilReviewForPendingClue(gameId, afterPending.id);
      return true;
    }
    return false;
  }

  mutateLocalPracticeGame(gameId, (draft) => {
    const currentPending = normalizePendingClueEntry(draft.pendingClue, draft);
    if (!currentPending || currentPending.id !== livePending.id || currentPending.state !== 'awaiting') return;
    draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
    draft.log.push(`${actorName} allowed "${currentPending.word}".`);
    applyAcceptedClueLocalState(draft, currentPending);
  });
  if (window.playSound) window.playSound('clueGiven');
  return true;
}

async function judgePendingClueWithAI(game, pending, judgeIdx, baseline) {
  const chatFn = window.aiChatCompletion;
  if (typeof chatFn !== 'function') {
    return {
      judge: `AI-${judgeIdx + 1}`,
      verdict: baseline.legal ? 'legal' : 'illegal',
      reason: baseline.reason,
    };
  }

  const boardWords = (game?.cards || [])
    .map((c) => String(c?.word || '').trim().toUpperCase())
    .filter(Boolean);
  const system = [
    'You are one judge in a 3-AI Codenames clue legality council.',
    'Judge ONLY legality, not clue quality.',
    'Strict legality rules:',
    '- clue must be exactly one word (no spaces or hyphens)',
    '- clue must not match any board word',
    '- clue number must be an integer from 0 to 9',
    'Return JSON only:',
    '{"verdict":"legal|illegal","reason":"short reason"}',
  ].join('\n');

  const user = [
    `CLUE: "${pending.word}"`,
    `NUMBER: ${pending.number}`,
    `BOARD WORDS: ${boardWords.join(', ')}`,
    `HARD CHECK: ${baseline.legal ? 'pass' : `fail (${baseline.reason})`}`,
    `Decide legal or illegal.`,
  ].join('\n');

  try {
    const raw = await chatFn(
      [{ role: 'system', content: system }, { role: 'user', content: user }],
      {
        temperature: [0.15, 0.35, 0.55][judgeIdx] || 0.35,
        max_tokens: 180,
        response_format: { type: 'json_object' },
      }
    );
    const parsed = safeJsonParse(raw);
    const verdict = String(parsed?.verdict || '').trim().toLowerCase() === 'illegal' ? 'illegal' : 'legal';
    const reason = String(parsed?.reason || '').trim().slice(0, 160) || 'No reason provided.';
    return { judge: `AI-${judgeIdx + 1}`, verdict, reason };
  } catch (e) {
    return {
      judge: `AI-${judgeIdx + 1}`,
      verdict: baseline.legal ? 'legal' : 'illegal',
      reason: `Fallback: ${baseline.reason}`,
    };
  }
}



function buildCouncilTribunalHtml(liveState, scope) {
  const voteHtml = (verdict) => {
    const v = verdict === 'illegal' ? 'illegal' : 'legal';
    const letter = v === 'illegal' ? 'A' : 'D';
    const word = v === 'illegal' ? 'AGREE' : 'DISAGREE';
    return `<span class="council-vote-letter">${letter}</span><span class="council-vote-word">${word}</span>`;
  };

  const judgeNames = ['Aria', 'Kai', 'Nova'];
  const safeScope = scope ? String(scope) : 'panel';
  const j0cls = liveState?.judges?.[0] ? (liveState.judges[0].verdict === 'legal' ? 'judge-legal' : 'judge-illegal') : 'judge-center';
  const j1cls = liveState?.judges?.[1] ? (liveState.judges[1].verdict === 'legal' ? 'judge-legal' : 'judge-illegal') : 'judge-center';
  const j2cls = liveState?.judges?.[2] ? (liveState.judges[2].verdict === 'legal' ? 'judge-legal' : 'judge-illegal') : 'judge-center';
  const j0label = liveState?.judges?.[0] ? voteHtml(liveState.judges[0].verdict) : '';
  const j1label = liveState?.judges?.[1] ? voteHtml(liveState.judges[1].verdict) : '';
  const j2label = liveState?.judges?.[2] ? voteHtml(liveState.judges[2].verdict) : '';

  const flashCls = liveState?.finalVerdict ? (liveState.finalVerdict === 'legal' ? 'judge-flash-green' : 'judge-flash-red') : '';
  const verdictShowCls = liveState?.finalVerdict ? 'verdict-show' : '';
  const stampText = liveState?.finalVerdict
    ? (liveState.finalVerdict === 'illegal' ? 'CHALLENGE ACCEPTED' : 'CHALLENGE OVERRULED')
    : '';
  const stampCls = liveState?.finalVerdict
    ? (liveState.finalVerdict === 'illegal' ? 'accepted' : 'denied')
    : '';

  const pendingDots = '<span class="council-judge-pending-dots"><span></span><span></span><span></span></span>';

  return `
    <div class="council-tribunal ${flashCls} ${verdictShowCls}" id="judge-courtroom-${safeScope}">
      ${stampText ? `<div class="council-verdict-stamp ${stampCls}" id="council-verdict-stamp-${safeScope}">${stampText}</div>` : ''}
      <div class="council-judges-row" aria-label="AI legality council">
        <div class="council-judge-card ${j0cls}" id="judge-avatar-${safeScope}-0" style="--judge-idx:0">
          <div class="council-judge-avatar">
            <span class="council-judge-initial">${judgeNames[0][0]}</span>
          </div>
          <div class="council-judge-name">${judgeNames[0]}</div>
          <div class="council-judge-verdict">${j0label || pendingDots}</div>
        </div>
        <div class="council-judge-card ${j1cls}" id="judge-avatar-${safeScope}-1" style="--judge-idx:1">
          <div class="council-judge-avatar">
            <span class="council-judge-initial">${judgeNames[1][0]}</span>
          </div>
          <div class="council-judge-name">${judgeNames[1]}</div>
          <div class="council-judge-verdict">${j1label || pendingDots}</div>
        </div>
        <div class="council-judge-card ${j2cls}" id="judge-avatar-${safeScope}-2" style="--judge-idx:2">
          <div class="council-judge-avatar">
            <span class="council-judge-initial">${judgeNames[2][0]}</span>
          </div>
          <div class="council-judge-name">${judgeNames[2]}</div>
          <div class="council-judge-verdict">${j2label || pendingDots}</div>
        </div>
      </div>
    </div>
  `;
}
function _updateJudgeCourtUI(pid) {
  const state = _liveJudgeVerdicts[pid];
  if (!state) return;

  const renderVoteHtml = (verdict) => {
    // A = Agree with the challenge (clue is ILLEGAL)
    // D = Disagree with the challenge (clue is LEGAL)
    const letter = verdict === 'illegal' ? 'A' : 'D';
    const word = verdict === 'illegal' ? 'AGREE' : 'DISAGREE';
    return `<span class="council-vote-letter">${letter}</span><span class="council-vote-word">${word}</span>`;
  };

  const verdictLabel = (finalVerdict) => (finalVerdict === 'illegal' ? 'CHALLENGE ACCEPTED' : 'CHALLENGE OVERRULED');

  const ensureVerdictStamp = (containerEl, finalVerdict, scope) => {
    if (!containerEl) return;
    containerEl.classList.add('verdict-show');
    const stampId = scope ? `council-verdict-stamp-${scope}` : 'council-verdict-stamp';
    let stamp = containerEl.querySelector(`#${stampId}`);
    if (!stamp) {
      stamp = document.createElement('div');
      stamp.id = stampId;
      stamp.className = 'council-verdict-stamp';
      containerEl.appendChild(stamp);
    }
    const accepted = finalVerdict === 'illegal';
    stamp.classList.toggle('accepted', accepted);
    stamp.classList.toggle('denied', !accepted);
    stamp.textContent = verdictLabel(finalVerdict);
  };

  const scopes = ['panel', 'modal', null]; // null supports any legacy ids
  for (const scope of scopes) {
    for (let i = 0; i < 3; i++) {
      const el = scope ? document.getElementById(`judge-avatar-${scope}-${i}`) : document.getElementById(`judge-avatar-${i}`);
      if (!el) continue;
      const j = state.judges[i];
      if (j) {
        el.classList.remove('judge-center');
        el.classList.add(j.verdict === 'legal' ? 'judge-legal' : 'judge-illegal');
        const labelEl = el.querySelector('.council-judge-verdict');
        if (labelEl) labelEl.innerHTML = renderVoteHtml(j.verdict);
      }
    }
  }

  if (state.finalVerdict) {
    const modalCard = document.getElementById('clue-review-modal-card');
    if (modalCard) {
      modalCard.classList.add(state.finalVerdict === 'legal' ? 'judge-flash-green' : 'judge-flash-red');
    }

    for (const scope of scopes) {
      const courtEl = scope ? document.getElementById(`judge-courtroom-${scope}`) : document.getElementById('judge-courtroom');
      if (!courtEl) continue;
      courtEl.classList.add(state.finalVerdict === 'legal' ? 'judge-flash-green' : 'judge-flash-red');
      ensureVerdictStamp(courtEl, state.finalVerdict, scope || undefined);
    }
  }
}

async function evaluatePendingClueWithCouncil(game, pending) {
  const baseline = basicClueLegalityCheck(pending, game);
  const pid = pending?.id || '';
  // Initialize live judge tracking
  _liveJudgeVerdicts[pid] = { judges: [], finalVerdict: null, flashDone: false };

  const judges = [];
  for (let idx = 0; idx < 3; idx += 1) {
    const verdict = await judgePendingClueWithAI(game, pending, idx, baseline);
    judges.push(verdict);
    // Update live tracking and animate this judge sliding
    _liveJudgeVerdicts[pid].judges = [...judges];
    _updateJudgeCourtUI(pid);
    // Brief pause so the slide animation is visible before next judge
    await new Promise(r => setTimeout(r, 700));
  }
  let legalVotes = judges.filter((j) => j.verdict === 'legal').length;
  let illegalVotes = judges.length - legalVotes;
  let verdict = legalVotes >= illegalVotes ? 'legal' : 'illegal';
  if (!baseline.legal) verdict = 'illegal';
  if (verdict === 'illegal' && legalVotes >= illegalVotes) {
    illegalVotes = Math.max(illegalVotes, 2);
    legalVotes = Math.min(legalVotes, 1);
  }
  // Set final verdict and trigger flash animation
  _liveJudgeVerdicts[pid].finalVerdict = verdict;
  _updateJudgeCourtUI(pid);
  // Wait for flash animation to play
  await new Promise(r => setTimeout(r, 1200));
  _liveJudgeVerdicts[pid].flashDone = true;
  // Cleanup
  delete _liveJudgeVerdicts[pid];
  return {
    verdict,
    legalVotes,
    illegalVotes,
    baseline,
    judges,
    reviewedAtMs: Date.now(),
  };
}

async function runCouncilReviewForPendingClue(gameId, pendingId) {
  const gid = String(gameId || '').trim();
  const pid = String(pendingId || '').trim();
  if (!gid || !pid) return;
  const runKey = `${gid}:${pid}`;
  if (_councilReviewRunning.has(runKey)) return;
  _councilReviewRunning.add(runKey);

  try {
    let game = null;
    if (isLocalPracticeGameId(gid)) {
      game = getLocalPracticeGame(gid);
    } else {
      const snap = await db.collection('games').doc(gid).get();
      if (snap.exists) game = { id: snap.id, ...snap.data() };
    }
    if (!game) return;
    const pending = normalizePendingClueEntry(game.pendingClue, game);
    if (!pending || pending.id !== pid || pending.state !== 'reviewing') return;

    const review = await evaluatePendingClueWithCouncil(game, pending);
    const legal = review.verdict === 'legal';

    if (isLocalPracticeGameId(gid)) {
      mutateLocalPracticeGame(gid, (draft) => {
        const livePending = normalizePendingClueEntry(draft.pendingClue, draft);
        if (!livePending || livePending.id !== pid || livePending.state !== 'reviewing') return;
        if (legal) {
          applyAcceptedClueLocalState(draft, livePending, {
            review,
            seqField: livePending.seqField || null,
          });
        } else {
          // Clear pending clue entirely so spymaster can immediately type a new one
          draft.pendingClue = null;
          draft.liveClueDraft = null;
          draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
          draft.log.push(buildCouncilSummaryLine(livePending, review));
          draft.updatedAtMs = Date.now();
          draft.lastMoveAtMs = Date.now();
        }
      });
      if (legal && window.playSound) window.playSound('clueGiven');
      return;
    }

    const ref = db.collection('games').doc(gid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const current = snap.data() || {};
      const livePending = normalizePendingClueEntry(current.pendingClue, current);
      if (!livePending || livePending.id !== pid || livePending.state !== 'reviewing') return;
      if (legal) {
        tx.update(ref, buildAcceptedClueRemoteUpdates(current, livePending, {
          review,
          seqField: livePending.seqField || null,
        }));
      } else {
        // Clear pending clue entirely so spymaster can immediately type a new one
        tx.update(ref, {
          pendingClue: firebase.firestore.FieldValue.delete(),
          liveClueDraft: firebase.firestore.FieldValue.delete(),
          log: firebase.firestore.FieldValue.arrayUnion(buildCouncilSummaryLine(livePending, review)),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
    if (legal && window.playSound) window.playSound('clueGiven');
  } catch (e) {
    console.error('Council review failed:', e);
  } finally {
    _councilReviewRunning.delete(runKey);
  }
}

function maybeRunCouncilReviewFromSnapshot(game = currentGame) {
  const pending = normalizePendingClueEntry(game?.pendingClue, game);
  if (!pending || pending.state !== 'reviewing' || !game?.id) return;
  const myId = String(getUserId?.() || '').trim();
  const challengerId = String(pending.challengedById || '').trim();
  const challengedAtMs = Number(pending.challengedAtMs || 0);
  const fallbackHoldMs = 2_500;
  if (challengerId && myId && challengerId !== myId) {
    // Let the challenger device start the council first, but keep fallback quick.
    if (challengedAtMs && (Date.now() - challengedAtMs) < fallbackHoldMs) return;
  }
  void runCouncilReviewForPendingClue(game.id, pending.id);
}

async function handleAllowPendingClue() {
  if (_clueChallengeActionBusy) return;
  if (!currentGame?.id) return;
  const pending = normalizePendingClueEntry(currentGame.pendingClue, currentGame);
  if (!pending || pending.state !== 'awaiting') return;
  if (!canCurrentUserChallengePendingClue(pending, currentGame)) return;

  _clueChallengeActionBusy = true;
  try {
    if (isCurrentLocalPracticeGame()) {
      mutateLocalPracticeGame(currentGame.id, (draft) => {
        const livePending = normalizePendingClueEntry(draft.pendingClue, draft);
        if (!livePending || livePending.id !== pending.id || livePending.state !== 'awaiting') return;
        applyAcceptedClueLocalState(draft, livePending, {
          seqField: livePending.seqField || null,
        });
      });
    } else {
      const ref = db.collection('games').doc(currentGame.id);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const game = snap.data() || {};
        const livePending = normalizePendingClueEntry(game.pendingClue, game);
        if (!livePending || livePending.id !== pending.id || livePending.state !== 'awaiting') return;

        const myTeam = livePending.team === 'red' ? 'blue' : 'red';
        const uid = String(getUserId?.() || '').trim();
        const uname = String(getUserName?.() || '').trim();
        if (!isUserSpymasterForTeamInGame(game, myTeam, uid, uname)) return;

        tx.update(ref, buildAcceptedClueRemoteUpdates(game, livePending, {
          seqField: livePending.seqField || null,
        }));
      });
    }
    if (window.playSound) window.playSound('clueGiven');
  } catch (e) {
    console.error('Allow clue failed:', e);
  } finally {
    _clueChallengeActionBusy = false;
  }
}

async function handleChallengePendingClue() {
  if (_clueChallengeActionBusy) return;
  if (!currentGame?.id) return;
  const pending = normalizePendingClueEntry(currentGame.pendingClue, currentGame);
  if (!pending || pending.state !== 'awaiting') return;
  if (!canCurrentUserChallengePendingClue(pending, currentGame)) return;

  _clueChallengeActionBusy = true;
  try {
    if (isCurrentLocalPracticeGame()) {
      mutateLocalPracticeGame(currentGame.id, (draft) => {
        const livePending = normalizePendingClueEntry(draft.pendingClue, draft);
        if (!livePending || livePending.id !== pending.id || livePending.state !== 'awaiting') return;
        draft.pendingClue = {
          ...livePending,
          state: 'reviewing',
          challengedById: String(getUserId?.() || '').trim(),
          challengedByName: String(getUserName?.() || '').trim(),
          challengedAtMs: Date.now(),
        };
        draft.updatedAtMs = Date.now();
      });
      void runCouncilReviewForPendingClue(currentGame.id, pending.id);
      return;
    }

    const ref = db.collection('games').doc(currentGame.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const livePending = normalizePendingClueEntry(game.pendingClue, game);
      if (!livePending || livePending.id !== pending.id || livePending.state !== 'awaiting') return;

      const myTeam = livePending.team === 'red' ? 'blue' : 'red';
      const uid = String(getUserId?.() || '').trim();
      const uname = String(getUserName?.() || '').trim();
      if (!isUserSpymasterForTeamInGame(game, myTeam, uid, uname)) return;

      tx.update(ref, {
        pendingClue: {
          ...livePending,
          state: 'reviewing',
          challengedById: uid,
          challengedByName: uname,
          challengedAtMs: Date.now(),
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
    void runCouncilReviewForPendingClue(currentGame.id, pending.id);
  } catch (e) {
    console.error('Challenge clue failed:', e);
  } finally {
    _clueChallengeActionBusy = false;
  }
}

async function submitClueForReviewFlow(opts = {}) {
  const game = opts.game || currentGame;
  if (!game || !game.id) throw new Error('Missing game state.');

  const team = String(game.currentTeam || '').toLowerCase() === 'blue' ? 'blue' : 'red';
  const word = String(opts.word || '').trim().toUpperCase();
  const number = Math.max(0, Math.min(9, Number(opts.number || 0)));
  const byId = String(opts.byId || getUserId?.() || '').trim();
  const byName = String(opts.byName || getUserName?.() || '').trim() || 'Spymaster';
  const selectedTargets = normalizeClueTargetSelection(opts.targets || [], game, team);
  const targetWords = Array.isArray(opts.targetWords) && opts.targetWords.length
    ? opts.targetWords.map((w) => String(w || '').trim()).filter(Boolean)
    : getClueTargetWords(selectedTargets, game);
  const seqField = String(opts.seqField || '').trim();

  const pending = {
    id: `clue_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    team,
    word,
    number,
    targets: selectedTargets,
    targetWords,
    byId,
    byName,
    seqField,
    submittedAtMs: Date.now(),
    state: 'awaiting',
  };

  const shouldOfferChallenge = shouldOfferChallengeForPendingClue(game, team);

  if (isLocalPracticeGameId(game.id)) {
    if (!shouldOfferChallenge) {
      mutateLocalPracticeGame(game.id, (draft) => {
        applyAcceptedClueLocalState(draft, pending, { seqField: seqField || null });
      });
      return { accepted: true, pending: false };
    }

    mutateLocalPracticeGame(game.id, (draft) => {
      draft.pendingClue = pending;
      draft.liveClueDraft = null;
      draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
      draft.log.push(`${byName} proposed "${pending.word}" for ${pending.number}.`);
      draft.updatedAtMs = Date.now();
    });
    return { accepted: false, pending: true };
  }

  const ref = db.collection('games').doc(game.id);
  let result = { accepted: false, pending: false, rejected: false };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() || {};
    if (current.winner) return;
    if (String(current.currentPhase || '') !== 'spymaster') return;
    if (String(current.currentTeam || '') !== team) return;
    if (hasBlockingPendingClue(current)) return;

    const offerChallenge = shouldOfferChallengeForPendingClue(current, team);
    if (offerChallenge) {
      tx.update(ref, {
        pendingClue: pending,
        liveClueDraft: firebase.firestore.FieldValue.delete(),
        log: firebase.firestore.FieldValue.arrayUnion(`${byName} proposed "${pending.word}" for ${pending.number}.`),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      result = { accepted: false, pending: true, rejected: false };
      return;
    }

    tx.update(ref, buildAcceptedClueRemoteUpdates(current, pending, { seqField: seqField || null }));
    result = { accepted: true, pending: false, rejected: false };
  });

  return result;
}
window.submitClueForReviewFlow = submitClueForReviewFlow;

function renderClueArea(isSpymaster, myTeamColor, spectator) {
  const currentClueEl = document.getElementById('current-clue');
  const clueFormEl = document.getElementById('clue-form');
  const operativeActionsEl = document.getElementById('operative-actions');
  const actionBarEl = currentClueEl?.closest?.('.game-action-bar') || null;
  const waitingEl = document.getElementById('waiting-message');
  const typingLiveEl = document.getElementById('clue-live-typing');
  const reviewPanelEl = document.getElementById('clue-review-panel');
  const reviewTitleEl = document.getElementById('clue-review-title');
  const reviewStatusEl = document.getElementById('clue-review-status');
  const reviewMetaEl = document.getElementById('clue-review-meta');
  const reviewActionsEl = document.getElementById('clue-review-actions');
  const reviewHintEl = document.getElementById('clue-review-hint');
  const allowBtn = document.getElementById('clue-review-allow-btn');
  const challengeBtn = document.getElementById('clue-review-challenge-btn');
  const reviewModalEl = document.getElementById('clue-review-modal');
  const reviewModalCardEl = document.getElementById('clue-review-modal-card');
  const reviewModalPanelEl = document.getElementById('clue-review-modal-panel');
  const reviewModalTitleEl = document.getElementById('clue-review-modal-title');
  const reviewModalStatusEl = document.getElementById('clue-review-modal-status');
  const reviewModalMetaEl = document.getElementById('clue-review-modal-meta');
  const reviewModalActionsEl = document.getElementById('clue-review-modal-actions');
  const reviewModalHintEl = document.getElementById('clue-review-modal-hint');
  const reviewModalAllowBtn = document.getElementById('clue-review-modal-allow-btn');
  const reviewModalChallengeBtn = document.getElementById('clue-review-modal-challenge-btn');
  if (!currentClueEl || !clueFormEl || !operativeActionsEl || !waitingEl) return;
  const waitingForEl = document.getElementById('waiting-for');
  const clueWordEl = document.getElementById('clue-word');
  const clueNumberEl = document.getElementById('clue-number');
  const guessesLeftEl = document.getElementById('guesses-left');
  const endTurnBtn = document.getElementById('end-turn-btn');
  // guessesLeftEl is optional (we hide/remove it for unlimited guesses)
  if (!clueWordEl || !clueNumberEl || !endTurnBtn) return;

  syncClueSubmitButtonAppearance();

  // Default: keep clue/end-turn pills visible during gameplay.
  currentClueEl.style.display = 'flex';
  operativeActionsEl.style.display = 'flex';
  currentClueEl.classList.remove('clue-team-red', 'clue-team-blue');
  operativeActionsEl.classList.remove('clue-team-red', 'clue-team-blue');
  const activeTeam = currentGame?.currentTeam === 'blue' ? 'blue' : 'red';
  const teamClass = activeTeam === 'blue' ? 'clue-team-blue' : 'clue-team-red';
  currentClueEl.classList.add(teamClass);
  operativeActionsEl.classList.add(teamClass);

  clueFormEl.style.display = 'none';
  waitingEl.style.display = 'none';
  if (typingLiveEl) typingLiveEl.style.display = 'none';
  if (reviewPanelEl) reviewPanelEl.style.display = 'none';
  if (reviewActionsEl) reviewActionsEl.style.display = 'none';
  if (reviewPanelEl) reviewPanelEl.classList.remove('is-reviewing');
  if (reviewModalActionsEl) reviewModalActionsEl.style.display = 'none';
  if (reviewModalPanelEl) reviewModalPanelEl.classList.remove('is-reviewing');
  if (reviewModalCardEl) reviewModalCardEl.classList.remove('is-reviewing');
  if (reviewModalEl) {
    reviewModalEl.classList.remove('modal-open');
    reviewModalEl.setAttribute('aria-hidden', 'true');
    reviewModalEl.style.display = 'none';
  }
  if (actionBarEl) actionBarEl.classList.remove('row-clue-endturn');
  const clueStackPanel = document.getElementById('clue-stack-panel');
  if (clueStackPanel) clueStackPanel.style.display = 'none';
  renderClueStackingPanel();

  const pending = normalizePendingClueEntry(currentGame?.pendingClue, currentGame);
  const pendingBlocking = !!(pending && (pending.state === 'awaiting' || pending.state === 'reviewing'));
  const pendingRejected = !!(pending && pending.state === 'rejected');
  const pendingReview = (pending && pending.review && typeof pending.review === 'object') ? pending.review : null;
  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);
  const myActiveSpymaster = !!(!spectator && isMyTurn && isSpymaster);
  const opposingSpymaster = !!(!spectator && isSpymaster && myTeamColor && myTeamColor !== activeTeam);

  let clueWord = '—';
  let clueNumber = '—';
  if (currentGame?.currentClue) {
    clueWord = String(currentGame.currentClue.word || '—');
    clueNumber = String(currentGame.currentClue.number ?? '—');
  } else if (pending) {
    clueWord = String(pending.word || '—');
    clueNumber = String(pending.number ?? '—');
  }
  clueWordEl.textContent = clueWord;
  clueNumberEl.textContent = clueNumber;
  // Unlimited guesses: remove/hide guesses remaining text.
  if (guessesLeftEl) {
    guessesLeftEl.textContent = '';
    guessesLeftEl.style.display = 'none';
  }

  const liveDraft = normalizeLiveClueDraft(currentGame?.liveClueDraft, currentGame);
  const isOperativeViewer = !!(!spectator && !isSpymaster);
  const isSpectatorViewer = !!spectator;

  // While a spymaster is typing, show masked progress to operatives (and spectators),
  // while opposing spymasters can see the exact text in real time.
  if (currentGame?.currentPhase === 'spymaster' && liveDraft && !pendingBlocking) {
    // Operatives see one "*" per character as it is typed.
    if (isOperativeViewer || isSpectatorViewer) {
      const n = Math.max(0, Math.min(40, Number(liveDraft.wordLen || 0)));
      clueWordEl.textContent = n ? '*'.repeat(n) : '—';
      clueNumberEl.textContent = liveDraft.number === '' ? '…' : String(liveDraft.number || '—');
    }

    // Opposing spymaster sees the exact word/number as it is typed.
    if (opposingSpymaster) {
      clueWordEl.textContent = liveDraft.word || '—';
      clueNumberEl.textContent = liveDraft.number === '' ? '…' : String(liveDraft.number || '—');
    }
  }

  if (reviewPanelEl && pending) {
    reviewPanelEl.style.display = 'flex';
    if (reviewTitleEl) {
      const inlineMaskedWord = isSpymaster ? pending.word : '*****';
      const reviewTitle = `${inlineMaskedWord} ${pending.number}`;
      reviewTitleEl.textContent = reviewTitle;
      reviewTitleEl.title = reviewTitle;
    }

    let statusText = '';
    let hintText = '';
    let hintHtml = '';
    let hintHtmlModal = '';
    let metaText = '';
    const canChallenge = canCurrentUserChallengePendingClue(pending, currentGame);

    if (pending.state === 'awaiting') {
      statusText = 'Awaiting Decision';
      metaText = `Submitted by ${pending.byName || 'Spymaster'}`;
      if (canChallenge) {
        hintText = 'Challenge sends this clue to a 3-AI legality council.';
        if (reviewActionsEl) reviewActionsEl.style.display = 'flex';
        if (allowBtn) allowBtn.disabled = _clueChallengeActionBusy;
        if (challengeBtn) challengeBtn.disabled = _clueChallengeActionBusy;
      } else if (myActiveSpymaster && myTeamColor === pending.team) {
        hintText = 'Waiting for the opposing spymaster to allow or challenge.';
      } else {
        hintText = 'Clue is pending review.';
      }
    } else if (pending.state === 'reviewing') {
      statusText = 'Council Reviewing';
      metaText = pending.challengedByName ? `Challenged by ${pending.challengedByName}` : 'Challenge in progress';
      const liveState = _liveJudgeVerdicts[pending.id];
      hintHtml = buildCouncilTribunalHtml(liveState, 'panel');
      hintHtmlModal = buildCouncilTribunalHtml(liveState, 'modal');
      reviewPanelEl.classList.add('is-reviewing');
    } else if (pending.state === 'rejected') {
      statusText = 'Rejected';
      const legalVotes = Number(pendingReview?.legalVotes || 0);
      const illegalVotes = Number(pendingReview?.illegalVotes || 0);
      metaText = (pendingReview && (legalVotes || illegalVotes))
        ? `Council vote: legal ${legalVotes} · illegal ${illegalVotes}`
        : 'The clue was judged illegal.';
      hintText = myActiveSpymaster && myTeamColor === pending.team
        ? 'Submit a new clue.'
        : 'Waiting for a replacement clue.';
    }

    if (reviewStatusEl) reviewStatusEl.textContent = statusText;
    if (reviewMetaEl) reviewMetaEl.textContent = metaText;
    if (reviewHintEl) {
      if (hintHtml) reviewHintEl.innerHTML = hintHtml;
      else reviewHintEl.textContent = hintText;
    }

    // Show modal for ALL players when clue is awaiting/reviewing
    const showReviewModal = !spectator
      && (pending.state === 'awaiting' || pending.state === 'reviewing');
    if (showReviewModal && reviewModalEl) {
      // While the council popup is up, keep the clue pill centered in the action bar.
      if (actionBarEl) actionBarEl.classList.add('row-clue-endturn');

      const maskedWord = isSpymaster ? pending.word : '*****';
      const reviewTitle = `${maskedWord} ${pending.number}`;
      if (reviewModalTitleEl) {
        reviewModalTitleEl.textContent = reviewTitle;
        reviewModalTitleEl.title = reviewTitle;
      }
      if (reviewModalStatusEl) reviewModalStatusEl.textContent = statusText;
      if (reviewModalMetaEl) reviewModalMetaEl.textContent = metaText;
      if (reviewModalHintEl) {
        const modalHtml = hintHtmlModal || hintHtml;
        if (modalHtml) reviewModalHintEl.innerHTML = modalHtml;
        else reviewModalHintEl.textContent = hintText;
      }

      // Only show Accept/Challenge buttons for the OPPOSING spymaster
      if (reviewModalActionsEl) reviewModalActionsEl.style.display = canChallenge ? 'grid' : 'none';
      if (canChallenge) {
        if (reviewModalAllowBtn) reviewModalAllowBtn.disabled = _clueChallengeActionBusy;
        if (reviewModalChallengeBtn) reviewModalChallengeBtn.disabled = _clueChallengeActionBusy;
      }

      if (pending.state === 'reviewing') {
        reviewModalPanelEl?.classList.add('is-reviewing');
        reviewModalCardEl?.classList.add('is-reviewing');
      }

      reviewPanelEl.style.display = 'none';
      reviewModalEl.style.display = 'flex';
      void reviewModalEl.offsetWidth;
      reviewModalEl.classList.add('modal-open');
      reviewModalEl.setAttribute('aria-hidden', 'false');
    }
  }

  // Update OG mode phase banner
  const ogBanner = document.getElementById('og-phase-banner');
  const ogText = document.getElementById('og-phase-text');
  if (ogBanner && ogText) {
    const isOgMode = document.body.classList.contains('cozy-mode') || document.body.classList.contains('og-mode');
    ogBanner.style.display = isOgMode ? 'block' : 'none';
    if (isOgMode) {
      if (currentGame.winner) {
        const winnerName = currentGame.winner === 'red'
          ? (currentGame.redTeamName || 'RED')
          : (currentGame.blueTeamName || 'BLUE');
        ogText.textContent = winnerName.toUpperCase() + ' TEAM WINS!';
      } else if (currentGame.currentPhase === 'spymaster') {
        ogText.textContent = 'GIVE YOUR OPERATIVES A CLUE';
      } else if (currentGame.currentPhase === 'operatives') {
        // Desktop-only guidance above the board.
        ogText.textContent = isMobileLayoutLike() ? '' : 'GUESS THE WORDS';
      } else if (currentGame.currentPhase === 'waiting') {
        ogText.textContent = '';
      } else if (currentGame.currentPhase === 'role-selection') {
        ogText.textContent = 'SELECT YOUR ROLE';
      }
    }
  }

  const canEndTurn = !spectator
    && !currentGame?.winner
    && currentGame?.currentPhase === 'operatives'
    && isMyTurn
    && !isSpymaster;
  endTurnBtn.disabled = !canEndTurn;
  endTurnBtn.classList.toggle('disabled', !canEndTurn);

  // Hide the entire end-turn container for spymasters
  if (isSpymaster) {
    operativeActionsEl.style.display = 'none';
  }

  if (currentGame.winner) {
    void clearLiveClueDraftOwnership({ silent: true });
    return;
  }

  // Quick Play waiting phase
  if (currentGame.currentPhase === 'waiting') {
    void clearLiveClueDraftOwnership({ silent: true });
    const redCount = (currentGame.redPlayers || []).length;
    const blueCount = (currentGame.bluePlayers || []).length;
    const hasPlayers = redCount > 0 && blueCount > 0;

    waitingEl.style.display = 'none';
    if (myTeamColor && hasPlayers) {
      // Keep start action available without waiting-status text.
      waitingEl.style.display = 'block';
      if (waitingForEl) waitingForEl.innerHTML = `
        <span>Ready to start!</span>
        <button class="btn primary small" style="margin-left: 12px;" onclick="startQuickGame('${currentGame.id}')">Start Game</button>
      `;
    }
    return;
  }

  if (currentGame.currentPhase === 'role-selection') {
    void clearLiveClueDraftOwnership({ silent: true });
    waitingEl.style.display = 'none';
    return;
  }

  if (currentGame.currentPhase === 'spymaster') {
    if (pendingBlocking) {
      waitingEl.style.display = 'block';
      if (waitingForEl) {
        if (pending.state === 'reviewing') {
          waitingForEl.textContent = 'AI council verdict…';
        } else if (myActiveSpymaster && myTeamColor === pending.team) {
          waitingForEl.textContent = 'opposing spymaster decision…';
        } else if (canCurrentUserChallengePendingClue(pending, currentGame)) {
          waitingForEl.textContent = 'your allow/challenge decision…';
        } else {
          waitingForEl.textContent = 'clue review…';
        }
      }
      void clearLiveClueDraftOwnership({ silent: true });
      return;
    }

    if (myActiveSpymaster) {
      // Active spymaster: clue input replaces the clue pill while typing.
      if (!pendingRejected) currentClueEl.style.display = 'none';
      clueFormEl.style.display = 'flex';
      const numInput = document.getElementById('clue-num-input');
      if (numInput && !String(numInput.value || '').trim()) numInput.value = '1';
      renderClueStackingPanel();
      queueLiveClueDraftSync();
      return;
    }
    void clearLiveClueDraftOwnership({ silent: true });
    return;
  }

  void clearLiveClueDraftOwnership({ silent: true });
  if (currentGame.currentPhase === 'operatives') {
    if (actionBarEl) actionBarEl.classList.add('row-clue-endturn');
    return;
  }
}

function renderGameLog() {
  const popoverHistoryEl = document.getElementById('game-log-entries');
  const sidebarHistoryEl = document.getElementById('game-log-entries-sidebar');
  const sidebarCluesLeftEl = document.getElementById('game-log-clues-left-sidebar');
  const slidedownHistoryEl = document.getElementById('og-gamelog-slidedown-entries');
  const slidedownCluesLeftEl = document.getElementById('og-gamelog-slidedown-clues-left');
  if (!popoverHistoryEl && !sidebarHistoryEl && !sidebarCluesLeftEl && !slidedownHistoryEl && !slidedownCluesLeftEl) return;
  if (!currentGame) return;

  const rawLog = Array.isArray(currentGame.log)
    ? currentGame.log.map(entry => String(entry ?? '')).filter(Boolean)
    : [];

  const redName = String(currentGame.redTeamName || 'Red').trim();
  const blueName = String(currentGame.blueTeamName || 'Blue').trim();

  const detectTeam = (entry) => {
    if (!entry) return null;

    // Common patterns:
    // - "Alice (TeamName) guessed ..."
    // - "TeamName Spymaster: ..."
    // - "TeamName ended their turn."
    if (redName && entry.includes(`(${redName})`)) return 'red';
    if (blueName && entry.includes(`(${blueName})`)) return 'blue';

    if (redName && entry.startsWith(redName)) return 'red';
    if (blueName && entry.startsWith(blueName)) return 'blue';

    if (/Red team/i.test(entry)) return 'red';
    if (/Blue team/i.test(entry)) return 'blue';

    return null;
  };

  const detectType = (entry) => {
    if (!entry) return 'neutral';
    const s = String(entry);

    if (/Spymaster:\s*/i.test(s)) return 'clue';
    if (/ASSASSIN/i.test(s)) return 'assassin';
    if (/\bCorrect!\b/i.test(s)) return 'correct';
    if (/\bWrong!\b/i.test(s)) return 'wrong';
    if (/\bNeutral\b/i.test(s)) return 'neutral';
    if (/wins!/i.test(s) || /Game ended/i.test(s) || /ended the game/i.test(s) || /Game over/i.test(s)) return 'end';
    if (/Game started/i.test(s) || /Starting game/i.test(s)) return 'start';

    return 'neutral';
  };
  const renderWithQuotes = (raw) => {
    const str = String(raw || '');
    const parts = str.split(/"([^"]+)"/g); // even = normal, odd = inside quotes

    const wrapOutside = (segment) => {
      let rawSeg = String(segment || '');

      // Team name placeholders (avoid double-escaping / partial matches)
      const RED = '__LOG_RED_TEAM__';
      const BLUE = '__LOG_BLUE_TEAM__';
      if (redName) rawSeg = rawSeg.split(redName).join(RED);
      if (blueName) rawSeg = rawSeg.split(blueName).join(BLUE);

      // Common phrases
      rawSeg = rawSeg.replace(/\bRed team\b/gi, RED);
      rawSeg = rawSeg.replace(/\bBlue team\b/gi, BLUE);

      // Escape after placeholders
      let s = escapeHtml(rawSeg);

      // Re-insert team spans
      if (redName) s = s.split(RED).join(`<span class="log-team red">${escapeHtml(redName)}</span>`);
      if (blueName) s = s.split(BLUE).join(`<span class="log-team blue">${escapeHtml(blueName)}</span>`);

      // Color only certain keywords (keep the rest readable)
      s = s.replace(/\bSpymaster\b/g, '<span class="log-token role">Spymaster</span>');
      s = s.replace(/\bOperatives?\b/g, (m) => `<span class="log-token role">${m}</span>`);

      s = s.replace(/\bguessed\b/gi, (m) => `<span class="log-token action">${m}</span>`);
      s = s.replace(/\bended their turn\b/gi, (m) => `<span class="log-token action">${m}</span>`);
      s = s.replace(/\bupdated rules\b/gi, (m) => `<span class="log-token system">${m}</span>`);
      s = s.replace(/\bGame started!\b/gi, (m) => `<span class="log-token system">${m}</span>`);
      s = s.replace(/\bStarting game\b/gi, (m) => `<span class="log-token system">${m}</span>`);
      s = s.replace(/\bGame ended\b/gi, (m) => `<span class="log-token system">${m}</span>`);
      s = s.replace(/\bGame over\b/gi, (m) => `<span class="log-token system">${m}</span>`);

      s = s.replace(/\bCorrect!\b/g, '<span class="log-token result-correct">Correct!</span>');
      s = s.replace(/\bWrong!\b/g, '<span class="log-token result-wrong">Wrong!</span>');
      s = s.replace(/\bNeutral\b/g, '<span class="log-token result-neutral">Neutral</span>');
      s = s.replace(/\bASSASSIN\b/g, '<span class="log-token result-assassin">ASSASSIN</span>');
      s = s.replace(/\bwins!\b/g, '<span class="log-token system">wins!</span>');

      return s;
    };

    return parts.map((p, i) => {
      if (i % 2 === 1) return `<span class="log-quote">${escapeHtml(p)}</span>`;
      return wrapOutside(p);
    }).join('');
  };

  const html = rawLog.map(entry => {
    const team = detectTeam(entry);
    const type = detectType(entry);
    const cls = ['log-entry', `type-${type}`];
    if (team) cls.push(`team-${team}`);
    return `<div class="${cls.join(' ')}">${renderWithQuotes(entry)}</div>`;
  }).join('');
  const fallbackHtml = html || '<div class="gamelog-empty">No events yet. Clues and guesses will appear here.</div>';

  if (popoverHistoryEl) popoverHistoryEl.innerHTML = fallbackHtml;

  const isOgMode = document.body.classList.contains('cozy-mode') || document.body.classList.contains('og-mode');
  let historyHtml = fallbackHtml;
  if (isOgMode && currentGame.clueHistory && currentGame.clueHistory.length > 0) {
    const ogHtml = buildOgStructuredLog();
    historyHtml = ogHtml || fallbackHtml;
  }

  if (sidebarHistoryEl) sidebarHistoryEl.innerHTML = historyHtml;
  if (slidedownHistoryEl) slidedownHistoryEl.innerHTML = historyHtml;

  const cluesLeftHtml = buildCluesLeftLogHtml();
  if (sidebarCluesLeftEl) sidebarCluesLeftEl.innerHTML = cluesLeftHtml;
  if (slidedownCluesLeftEl) slidedownCluesLeftEl.innerHTML = cluesLeftHtml;
  applyGameLogTabState();

  // Auto-scroll to bottom (popover container + sidebar scroller)
  const popover = document.getElementById('game-log');
  const activeTab = normalizeGameLogTab(gameLogActiveTab);
  if (popover && activeTab === 'history') popover.scrollTop = popover.scrollHeight;
  if (sidebarHistoryEl && activeTab === 'history') sidebarHistoryEl.scrollTop = sidebarHistoryEl.scrollHeight;
  if (slidedownHistoryEl && activeTab === 'history') slidedownHistoryEl.scrollTop = slidedownHistoryEl.scrollHeight;
  if (sidebarCluesLeftEl && activeTab === 'clues-left') sidebarCluesLeftEl.scrollTop = sidebarCluesLeftEl.scrollHeight;
  if (slidedownCluesLeftEl && activeTab === 'clues-left') slidedownCluesLeftEl.scrollTop = slidedownCluesLeftEl.scrollHeight;
}

function getClueTargetIndicesFromEntry(clue, game = currentGame) {
  const rawTargets = Array.isArray(clue?.targets) ? clue.targets : [];
  const parsed = rawTargets.map((raw) => {
    if (Number.isInteger(raw)) return raw;
    if (raw && typeof raw === 'object') return Number(raw.index);
    return Number(raw);
  });
  const team = String(clue?.team || '').toLowerCase() === 'blue' ? 'blue' : 'red';
  return normalizeClueTargetSelection(parsed, game, team, { allowRevealed: true });
}

function buildCluesLeftLogHtml() {
  const history = Array.isArray(currentGame?.clueHistory) ? currentGame.clueHistory : [];
  const cards = Array.isArray(currentGame?.cards) ? currentGame.cards : [];
  if (!history.length || !cards.length) {
    return '<div class="gamelog-empty">No stacked clues yet. Turn on Stacking in Settings and pick target cards when giving clues.</div>';
  }

  // Spymasters can see the specific target words. Operatives should still see
  // the clue and how many words are associated with it.
  const spectator = isSpectating();
  const canSeeWords = !spectator && isCurrentUserSpymaster();

  // Only show clues from the current user's team (spectators see all).
  const myTeamColor = getMyTeamColor();

  // Build a fast word -> index map (cards are unique words).
  const wordIndex = new Map();
  for (let i = 0; i < cards.length; i += 1) {
    const w = String(cards[i]?.word || '').trim().toUpperCase();
    if (w) wordIndex.set(w, i);
  }

  const rows = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const clue = history[i];
    if (!clue || typeof clue !== 'object') continue;
    const team = String(clue.team || '').toLowerCase() === 'blue' ? 'blue' : 'red';

    // Filter: only show clues from your own team (spectators see all).
    if (myTeamColor && team !== myTeamColor) continue;

    const clueWord = String(clue.word || '').trim() || 'CLUE';
    const targetIndices = getClueTargetIndicesFromEntry(clue, currentGame);
    const targetWords = Array.isArray(clue.targetWords)
      ? clue.targetWords.map((w) => String(w || '').trim()).filter(Boolean)
      : [];

    // Total targets: prefer indices, then explicit words, then the clue number.
    const clueNumberRaw = parseInt(clue.number, 10);
    const clueNumber = Number.isFinite(clueNumberRaw) ? Math.max(0, Math.min(9, clueNumberRaw)) : 0;
    let total = targetIndices.length || targetWords.length || clueNumber;
    if (!total) continue;

    // If we have indices, we can compute remaining precisely. If we only have
    // words, map them back to indices so we can still compute remaining.
    let computedIndices = targetIndices;
    if (!computedIndices.length && targetWords.length) {
      const mapped = [];
      targetWords.forEach((w) => {
        const idx = wordIndex.get(String(w).trim().toUpperCase());
        if (Number.isInteger(idx)) mapped.push(idx);
      });
      computedIndices = Array.from(new Set(mapped));
      if (computedIndices.length) total = computedIndices.length;
    }

    let remainingCount = null;
    let foundCount = null;
    let remainingWords = [];
    if (computedIndices.length) {
      const remainingIndices = computedIndices.filter((idx) => {
        const card = cards[idx];
        return !!card && !card.revealed;
      });

      // If everything is found, hide it from "Clues Left".
      if (!remainingIndices.length) continue;

      remainingCount = remainingIndices.length;
      foundCount = Math.max(0, total - remainingCount);
      remainingWords = remainingIndices
        .map((idx) => String(cards[idx]?.word || '').trim())
        .filter(Boolean);
    }



    // Operatives want a simple "N words left" indicator.
    const progressText = (remainingCount === null)
      ? ''
      : `${remainingCount} word${remainingCount === 1 ? '' : 's'} left`;

    // In the Clues Left (Game Log) UI, surface this directly in the count badge.
    // This matches the user's mental model: "3 words left" rather than a bare "3".
    const countBadgeText = progressText || String(clueNumber);

    const wordsHtml = canSeeWords
      ? (remainingWords.length
          ? remainingWords.map((word) => `<span class="gamelog-left-word-chip">${escapeHtml(String(word).toUpperCase())}</span>`).join('')
          : '<span class="gamelog-left-word-chip empty">Waiting for guesses</span>')
      : '<span class="gamelog-left-word-chip empty">Words hidden from operatives</span>';

    rows.push(`
      <div class="gamelog-left-item team-${escapeHtml(team)}">
        <div class="gamelog-left-head">
          <span class="gamelog-left-clue-word">${escapeHtml(clueWord)}</span>
          <span class="gamelog-left-clue-count">${escapeHtml(String(countBadgeText))}</span>
        </div>
        <div class="gamelog-left-word-list">${wordsHtml}</div>
      </div>
    `);
  }

  if (!rows.length) {
    return '<div class="gamelog-empty">No remaining stacked clues right now.</div>';
  }
  return rows.join('');
}

function buildOgStructuredLog() {
  if (!Array.isArray(currentGame?.clueHistory) || currentGame.clueHistory.length === 0) return '';
  const history = currentGame.clueHistory;

  return history.map(clue => {
    if (!clue || typeof clue !== 'object') return '';

    const teamRaw = String(clue.team || 'red').toLowerCase();
    const team = (teamRaw === 'blue' || teamRaw === 'red') ? teamRaw : 'red';
    const teamRoster = getTeamPlayers(team, currentGame);
    const spymasterRaw = getTeamSpymasterName(team, currentGame) || 'Spymaster';
    const spymaster = displayNameFromRoster(spymasterRaw, teamRoster) || 'Spymaster';
    const initial = (spymaster || 'S').trim().slice(0, 1).toUpperCase();
    const clueWord = String(clue.word || '').trim() || 'CLUE';
    const clueNumberRaw = parseInt(clue.number, 10);
    const clueNumber = Number.isFinite(clueNumberRaw) && clueNumberRaw >= 0 ? clueNumberRaw : '?';

    // In OG/Codenames-Online style, show the hint in the *same badge* as the avatar (like the spymaster card).
    // This makes the clue more visible and uses space more efficiently.
    const clueRow = `<div class="gamelog-clue-row">
        <div class="gamelog-clue-pill clue-with-avatar team-${escapeHtml(team)}">
          <div class="gamelog-avatar-wrap small team-${escapeHtml(team)}">
            <div class="gamelog-avatar">${escapeHtml(initial)}</div>
            <div class="gamelog-avatar-name">${escapeHtml(spymaster)}</div>
          </div>
          <div class="gamelog-clue-word">${escapeHtml(clueWord)}</div>
          <div class="gamelog-clue-count">${escapeHtml(String(clueNumber))}</div>
        </div>
      </div>`;

    const guesses = Array.isArray(clue.results) ? clue.results : [];
    const guessesHtml = guesses.map(r => {
      const name = String(r?.by || 'Someone').trim() || 'Someone';
      const gi = name.trim().slice(0, 1).toUpperCase();
      const typeRaw = String(r?.type || 'neutral').toLowerCase();
      const cardType = (typeRaw === 'red' || typeRaw === 'blue' || typeRaw === 'neutral' || typeRaw === 'assassin')
        ? typeRaw
        : 'neutral';
      const guessedWord = String(r?.word || '').trim() || 'Unknown';
      return `<div class="gamelog-guess-item">
          <div class="gamelog-avatar-wrap small team-${escapeHtml(team)}">
            <div class="gamelog-avatar">${escapeHtml(gi)}</div>
            <div class="gamelog-avatar-name">${escapeHtml(name)}</div>
          </div>
          <div class="gamelog-word-pill type-${escapeHtml(cardType)}">${escapeHtml(guessedWord)}</div>
        </div>`;
    }).join('');

    return `<div class="gamelog-turn">
        ${clueRow}
        ${guessesHtml ? `<div class="gamelog-guesses">${guessesHtml}</div>` : ''}
      </div>`;
  }).filter(Boolean).join('');
}

function updateRoleButtons() {
  const spymasterBtn = document.getElementById('role-spymaster');
  const operativeBtn = document.getElementById('role-operative');
  const statusEl = document.getElementById('role-status');

  const myTeamColor = getMyTeamColor();
  // Spectators can view chats but cannot post.
  if (!myTeamColor) return;

  const mySpymaster = getTeamSpymasterName(myTeamColor, currentGame);

  if (mySpymaster) {
    spymasterBtn.classList.add('taken');
    spymasterBtn.disabled = true;
    const roster = (myTeamColor === 'red') ? (currentGame.redPlayers || []) : (currentGame.bluePlayers || []);
    statusEl.textContent = `Spymaster: ${displayNameFromRoster(mySpymaster, roster)}`;
  } else {
    spymasterBtn.classList.remove('taken');
    spymasterBtn.disabled = false;
    statusEl.textContent = '';
  }
}

/* =========================
   Role Selection
========================= */
async function selectRole(role) {
  if (!currentGame) return;
  if (isSpectating()) return;

  const myTeamColor = getMyTeamColor();
  const userName = getUserName();

  if (!myTeamColor || !userName) return;

  if (isCurrentLocalPracticeGame()) {
    mutateLocalPracticeGame(currentGame.id, (draft) => {
      if (role === 'spymaster') {
        if (myTeamColor === 'red') {
          if (draft.redSpymaster) return;
          draft.redSpymaster = userName;
        } else {
          if (draft.blueSpymaster) return;
          draft.blueSpymaster = userName;
        }
      }
      if (draft.redSpymaster && draft.blueSpymaster) {
        draft.currentPhase = 'spymaster';
        draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
        draft.log.push('Game started! Red team goes first.');
      }
      draft.updatedAtMs = Date.now();
    });
    maybeStartLocalPracticeAI();
    return;
  }

  const updates = {
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  if (role === 'spymaster') {
    if (myTeamColor === 'red') {
      if (currentGame.redSpymaster) return; // Already taken
      updates.redSpymaster = userName;
    } else {
      if (currentGame.blueSpymaster) return; // Already taken
      updates.blueSpymaster = userName;
    }
  }

  // Check if both teams have spymasters - if so, start the game
  const willHaveRedSpymaster = updates.redSpymaster || currentGame.redSpymaster;
  const willHaveBlueSpymaster = updates.blueSpymaster || currentGame.blueSpymaster;

  if (willHaveRedSpymaster && willHaveBlueSpymaster) {
    updates.currentPhase = 'spymaster';
    updates.timerEnd = buildPhaseTimerEndValue(currentGame, 'spymaster');
    updates.log = firebase.firestore.FieldValue.arrayUnion('Game started! Red team goes first.');
  }

  try {
    await db.collection('games').doc(currentGame.id).update(updates);
  } catch (e) {
    console.error('Failed to select role:', e);
  }
}

/* =========================
   Clue Giving
========================= */
async function handleClueSubmit(e) {
  e.preventDefault();

  if (isSpectating()) return;

  if (!currentGame || currentGame.currentPhase !== 'spymaster') return;
  if (!isCurrentUserSpymaster()) return;
  if (hasBlockingPendingClue(currentGame)) return;

  const wordInput = document.getElementById('clue-input');
  const numInput = document.getElementById('clue-num-input');
  const submitBtn = document.querySelector('#clue-form button[type="submit"]');
  if (!wordInput || !numInput) return;

  const word = (wordInput.value || '').trim().toUpperCase();
  const parsed = parseInt(numInput.value, 10);
  let number = Number.isInteger(parsed) ? parsed : 1;
  if (!Number.isInteger(parsed)) numInput.value = '1';
  const stackingOnTurn = canCurrentUserStackClueTargets();
  const selectedTargets = stackingOnTurn ? getCurrentClueTargetSelection(currentGame) : [];
  const selectedTargetWords = getClueTargetWords(selectedTargets, currentGame);

  if (stackingOnTurn && selectedTargets.length <= 0) {
    alert('Select at least one target card for this clue.');
    return;
  }

  if (stackingOnTurn && selectedTargets.length > 0) {
    number = Math.max(0, Math.min(9, selectedTargets.length));
    if (numInput) numInput.value = String(number);
  }

  if (!word || isNaN(number) || number < 0 || number > 9) {
    return;
  }

  // Validate clue is one word
  if (word.includes(' ')) {
    alert('Clue must be a single word!');
    return;
  }

  // Check clue isn't a word on the board
  const boardWords = currentGame.cards.map(c => c.word.toUpperCase());
  if (boardWords.includes(word)) {
    alert('Clue cannot be a word on the board!');
    return;
  }

  // Prevent double-submission (rapid double-click / double Enter)
  if (_processingClue) return;
  _processingClue = true;
  if (submitBtn) submitBtn.disabled = true;
  try {
    const result = await submitClueForReviewFlow({
      game: currentGame,
      word,
      number,
      targets: selectedTargets,
      targetWords: selectedTargetWords,
      byId: String(getUserId?.() || '').trim(),
      byName: String(getUserName?.() || '').trim() || 'Spymaster',
    });

    void clearLiveClueDraftOwnership({ silent: true });
    clearClueTargetSelection({ skipPanelSync: true });
    wordInput.value = '';
    numInput.value = '';
    _lastSentClueDraftSig = '';

    if (result?.accepted && window.playSound) window.playSound('clueGiven');
    if (isCurrentLocalPracticeGame() && result?.accepted) maybeStartLocalPracticeAI();
  } catch (e) {
    console.error('Failed to give clue:', e);
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    _processingClue = false;
  }
}

/* =========================
   Card Guessing
========================= */
async function handleCardClick(cardIndex) {
  if (!currentGame || currentGame.currentPhase !== 'operatives') return false;
  if (isSpectating()) return false;
  if (currentGame.winner) return false;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return false;
  if (isCurrentUserSpymaster()) return false;

  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0 || idx >= currentGame.cards.length) return false;

  const card = currentGame.cards[idx];
  if (!card || card.revealed) return false;

  // Prevent concurrent guess processing (double-click / multi-player race)
  if (_processingGuess) return false;
  _processingGuess = true;
  try {
    // Clear pending selection only after we've validated this guess attempt.
    clearPendingCardSelection();

    if (isCurrentLocalPracticeGame()) {
      const guessByName = getUserName() || 'Someone';
      if (window.playSound) window.playSound('cardReveal');
      mutateLocalPracticeGame(currentGame.id, (draft) => {
        applyLocalPracticeGuessState(draft, idx, guessByName);
      });
      maybeStartLocalPracticeAI();
      return true;
    }

    const gameId = String(currentGame?.id || '').trim();
    if (!gameId) return false;
    const gameRef = db.collection('games').doc(gameId);
    const myUserId = String(getUserId() || '').trim();
    const myNameNorm = normalizeSpyIdentity(getUserName());

    const txResult = await db.runTransaction(async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists) return { committed: false, reason: 'missing-game' };

      const liveGame = { id: snap.id, ...snap.data() };
      if (!liveGame || liveGame.currentPhase !== 'operatives' || liveGame.winner) {
        return { committed: false, reason: 'stale-phase' };
      }

      const cardsLive = Array.isArray(liveGame.cards) ? liveGame.cards : [];
      if (!Number.isInteger(idx) || idx < 0 || idx >= cardsLive.length) {
        return { committed: false, reason: 'bad-index' };
      }

      const cardLive = cardsLive[idx];
      if (!cardLive || cardLive.revealed) {
        return { committed: false, reason: 'already-revealed' };
      }

      const isMe = (p) => {
        const pid = String(p?.odId || p?.userId || p?.id || '').trim();
        if (myUserId && pid && pid === myUserId) return true;
        return !!myNameNorm && normalizeSpyIdentity(p?.name) === myNameNorm;
      };

      const redPlayers = Array.isArray(liveGame.redPlayers) ? liveGame.redPlayers : [];
      const bluePlayers = Array.isArray(liveGame.bluePlayers) ? liveGame.bluePlayers : [];
      const inRed = redPlayers.some(isMe);
      const inBlue = !inRed && bluePlayers.some(isMe);
      const teamLive = inRed ? 'red' : (inBlue ? 'blue' : null);
      if (!teamLive) return { committed: false, reason: 'not-on-team' };
      if (liveGame.currentTeam !== teamLive) return { committed: false, reason: 'not-your-turn' };

      const myRoster = teamLive === 'red' ? redPlayers : bluePlayers;
      const me = myRoster.find(isMe) || null;
      if (!me) return { committed: false, reason: 'player-not-found' };
      if (isSpymasterPlayerForTeam(me, teamLive, liveGame)) {
        return { committed: false, reason: 'spymaster-blocked' };
      }

      const clueWordAtGuess = liveGame.currentClue?.word || null;
      const clueNumberAtGuess = (liveGame.currentClue && typeof liveGame.currentClue.number !== 'undefined')
        ? liveGame.currentClue.number
        : null;
      const guessByName = displayPlayerName(me) || getUserName() || 'Someone';

      const nextCards = [...cardsLive];
      nextCards[idx] = { ...cardLive, revealed: true };

      const teamName = teamLive === 'red'
        ? (liveGame.redTeamName || 'Red Team')
        : (liveGame.blueTeamName || 'Blue Team');

      const updates = {
        cards: nextCards,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      };
      const redCardsLeftNow = getCardsLeft(liveGame, 'red');
      const blueCardsLeftNow = getCardsLeft(liveGame, 'blue');

      let logEntry = `${guessByName} (${teamName}) guessed "${cardLive.word}" - `;
      let winner = null;
      let endTurn = false;

      if (cardLive.type === 'assassin') {
        winner = teamLive === 'red' ? 'blue' : 'red';
        logEntry += 'ASSASSIN! Game over.';
      } else if (cardLive.type === teamLive) {
        logEntry += 'Correct!';
        if (teamLive === 'red') {
          updates.redCardsLeft = Math.max(0, redCardsLeftNow - 1);
          if (updates.redCardsLeft === 0) winner = 'red';
        } else {
          updates.blueCardsLeft = Math.max(0, blueCardsLeftNow - 1);
          if (updates.blueCardsLeft === 0) winner = 'blue';
        }
      } else if (cardLive.type === 'neutral') {
        logEntry += 'Neutral. Turn ends.';
        endTurn = true;
      } else {
        const ownerTeamName = cardLive.type === 'red'
          ? (liveGame.redTeamName || 'Red Team')
          : (liveGame.blueTeamName || 'Blue Team');
        logEntry += `Wrong! (${ownerTeamName}'s card)`;
        if (cardLive.type === 'red') {
          updates.redCardsLeft = Math.max(0, redCardsLeftNow - 1);
          if (updates.redCardsLeft === 0) winner = 'red';
        } else {
          updates.blueCardsLeft = Math.max(0, blueCardsLeftNow - 1);
          if (updates.blueCardsLeft === 0) winner = 'blue';
        }
        endTurn = true;
      }

      const guessesNow = Number.isFinite(+liveGame.guessesRemaining) ? +liveGame.guessesRemaining : 0;
      const guessesNext = Math.max(0, guessesNow - 1);
      if (liveGame.currentClue) {
        updates.guessesRemaining = guessesNext;
        if (!winner && !endTurn && cardLive.type === teamLive && guessesNext <= 0) {
          endTurn = true;
        }
        if (winner || endTurn) updates.guessesRemaining = 0;
      }

      const guessResult = {
        word: cardLive.word,
        result: (cardLive.type === 'assassin')
          ? 'assassin'
          : (cardLive.type === teamLive ? 'correct' : (cardLive.type === 'neutral' ? 'neutral' : 'wrong')),
        type: cardLive.type,
        by: guessByName,
        timestamp: new Date().toISOString()
      };

      const logEntries = [logEntry];
      if (winner) {
        updates.winner = winner;
        updates.currentPhase = 'ended';
        updates.pendingClue = firebase.firestore.FieldValue.delete();
        updates.liveClueDraft = firebase.firestore.FieldValue.delete();
        updates.timerEnd = null;
        const winnerName = truncateTeamNameGame(winner === 'red' ? liveGame.redTeamName : liveGame.blueTeamName);
        logEntries.push(`${winnerName} wins!`);
      } else if (endTurn) {
        updates.currentTeam = teamLive === 'red' ? 'blue' : 'red';
        updates.currentPhase = 'spymaster';
        updates.currentClue = null;
        updates.pendingClue = firebase.firestore.FieldValue.delete();
        updates.liveClueDraft = firebase.firestore.FieldValue.delete();
        updates.guessesRemaining = 0;
        updates.timerEnd = buildPhaseTimerEndValue(liveGame, 'spymaster');
      }
      updates.log = firebase.firestore.FieldValue.arrayUnion(...logEntries);

      if (clueWordAtGuess && clueNumberAtGuess !== null && clueNumberAtGuess !== undefined) {
        const history = Array.isArray(liveGame.clueHistory) ? [...liveGame.clueHistory] : [];
        let historyIdx = -1;
        for (let i = history.length - 1; i >= 0; i -= 1) {
          const item = history[i];
          if (!item) continue;
          if (
            String(item.team) === String(teamLive) &&
            String(item.word) === String(clueWordAtGuess) &&
            Number(item.number) === Number(clueNumberAtGuess)
          ) {
            historyIdx = i;
            break;
          }
        }

        if (historyIdx >= 0) {
          const entry = { ...history[historyIdx] };
          const results = Array.isArray(entry.results) ? [...entry.results] : [];
          const guessWordNorm = String(guessResult.word || '').toUpperCase();
          const hasGuess = guessWordNorm && results.some((r) => String(r?.word || '').toUpperCase() === guessWordNorm);
          if (!hasGuess) {
            results.push(guessResult);
            entry.results = results;
            history[historyIdx] = entry;
            updates.clueHistory = history;
          }
        }
      }

      tx.update(gameRef, updates);
      return { committed: true, result: guessResult.result };
    });

    if (!txResult?.committed) return false;

    if (window.playSound) window.playSound('cardReveal');
    if (txResult.result === 'assassin') {
      setTimeout(() => { if (window.playSound) window.playSound('cardAssassin'); }, 200);
    } else if (txResult.result === 'correct') {
      setTimeout(() => { if (window.playSound) window.playSound('cardCorrect'); }, 200);
    } else {
      setTimeout(() => { if (window.playSound) window.playSound('cardWrong'); }, 200);
    }

    return true;
  } catch (e) {
    console.error('Failed to reveal card:', e);
    return false;
  } finally {
    _processingGuess = false;
  }
}

async function handleEndTurn() {
  if (!currentGame || currentGame.currentPhase !== 'operatives') return;
  if (isSpectating()) return;
  if (currentGame.winner) return;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return;

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
  const userName = getUserName() || 'Someone';

  // Play end turn sound
  if (window.playSound) window.playSound('endTurn');

  if (isCurrentLocalPracticeGame()) {
    mutateLocalPracticeGame(currentGame.id, (draft) => {
      const draftTeam = draft.currentTeam === 'red' ? 'red' : 'blue';
      const draftTeamName = draftTeam === 'red' ? draft.redTeamName : draft.blueTeamName;
      draft.currentTeam = draftTeam === 'red' ? 'blue' : 'red';
      draft.currentPhase = 'spymaster';
      draft.currentClue = null;
      draft.pendingClue = null;
      draft.liveClueDraft = null;
      draft.guessesRemaining = 0;
      draft.log = Array.isArray(draft.log) ? [...draft.log] : [];
      draft.log.push(`${userName} (${draftTeamName}) ended their turn.`);
      draft.updatedAtMs = Date.now();
      draft.lastMoveAtMs = Date.now();
    });
    maybeStartLocalPracticeAI();
    return;
  }

  try {
    await db.collection('games').doc(currentGame.id).update({
      currentTeam: currentGame.currentTeam === 'red' ? 'blue' : 'red',
      currentPhase: 'spymaster',
      currentClue: null,
      pendingClue: firebase.firestore.FieldValue.delete(),
      liveClueDraft: firebase.firestore.FieldValue.delete(),
      guessesRemaining: 0,
      timerEnd: buildPhaseTimerEndValue(currentGame, 'spymaster'),
      log: firebase.firestore.FieldValue.arrayUnion(`${userName} (${teamName}) ended their turn.`),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error('Failed to end turn:', e);
  }
}

async function handleLeaveGame(opts = {}) {
  // Handles both "Leave Game" (participant) and "Stop Spectating" (spectator).
  const skipConfirm = !!opts.skipConfirm;
  const closePracticeWindow = !!opts.closePracticeWindow;
  const skipReturn = !!opts.skipReturn;
  if (!currentGame) {
    try { stopGameListener(); } catch (_) {}
    if (!skipReturn) {
      try { window.returnToLaunchScreen?.({ skipPracticeCleanup: true }); }
      catch (_) { try { showGameLobby(); } catch (_) {} }
    }
    return;
  }

  const gameId = currentGame.id;
  const wasPractice = currentGame?.type === 'practice';
  const odId = getUserId();
  const userName = getUserName() || 'Someone';

  const spectator = (typeof isSpectating === 'function') ? !!isSpectating() : false;
  const isQuick = (currentGame.type === 'quick') || (gameId === QUICKPLAY_DOC_ID);

  // Confirm leaving if you are an active participant (not a spectator) and the game is in progress.
  const inProgress = !!(currentGame.currentPhase && currentGame.currentPhase !== 'waiting' && currentGame.winner == null && currentGame.currentPhase !== 'ended');
  if (!skipConfirm && !spectator && inProgress) {
    const ok = await showCustomConfirm({
      title: 'Leave game?',
      message: 'You can rejoin later, but your seat will be freed for others.',
      okText: 'Leave',
      cancelText: 'Stay'
    });
    if (!ok) return;
  }

  // Best-effort: remove you from the game doc if this is Quick Play, including spectators.
  if (isQuick && odId) {
    const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const g = snap.data() || {};
        const nextRed = (g.redPlayers || []).filter(p => p.odId !== odId);
        const nextBlue = (g.bluePlayers || []).filter(p => p.odId !== odId);
        const nextSpec = (g.spectators || []).filter(p => p.odId !== odId);

        // If this was an in-progress game, log the departure.
        const logLine = spectator
          ? `${userName} stopped spectating.`
          : `${userName} left the game.`;

        tx.update(ref, {
          redPlayers: nextRed,
          bluePlayers: nextBlue,
          spectators: nextSpec,
          log: firebase.firestore.FieldValue.arrayUnion(logLine),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (e) {
      console.warn('Leave quick play (best-effort) failed:', e);
    }
  }

  const isLocalPractice = wasPractice && isLocalPracticeGameId(gameId);

  // Practice should always terminate when the player leaves.
  // This avoids orphan practice docs and stale "in progress" sessions.
  if (wasPractice && gameId && !isLocalPractice) {
    try {
      const ref = db.collection('games').doc(gameId);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const g = snap.data() || {};
        if (String(g.type || '') !== 'practice') return;
        if (g.winner || g.currentPhase === 'ended') return;

        tx.update(ref, {
          winner: 'ended',
          currentPhase: 'ended',
          timerEnd: null,
          endedReason: 'practice_left',
          endedBy: {
            odId: odId || null,
            name: userName || 'Someone'
          },
          log: firebase.firestore.FieldValue.arrayUnion(`${userName} left practice. Practice ended.`),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (e) {
      console.warn('Ending practice on leave failed (best-effort):', e);
    }
  }

  if (isLocalPractice) {
    try { deleteLocalPracticeGame(gameId); } catch (_) {}
    try { stopLocalPracticeAI(); } catch (_) {}
  }

  // Local cleanup
  try { cleanupAdvancedFeatures?.(); } catch (_) {}
  try { window.cleanupAllAI && window.cleanupAllAI(); } catch (_) {}
  try { window.stopAIGameLoop && window.stopAIGameLoop(); } catch (_) {}

  try { stopGameListener(); } catch (_) {}

  // Reset local lobby selections when leaving Quick Play so next join is clean.
  if (isQuick) {
    try {
      selectedQuickTeam = null;
      selectedQuickSeatRole = 'operative';
      quickAutoJoinedSpectator = false;
    } catch (_) {}
  }

  // Return to home/launch (do NOT sign out)
  if (closePracticeWindow && wasPractice) {
    try { window.close(); } catch (_) {}
  }
  if (!skipReturn) {
    try { window.returnToLaunchScreen?.({ skipPracticeCleanup: true }); }
    catch (_) { try { showGameLobby(); } catch (_) {} }
  }
}

async function handleEndGame() {
  if (!currentGame) return;

  const gameId = currentGame.id;
  const userName = getUserName() || 'Someone';
  if (isCurrentLocalPracticeGame()) {
    await handleLeaveGame({ skipConfirm: true });
    return;
  }

  // Use the in-app confirm dialog (no browser confirm).
  const ok = await showCustomConfirm({
    title: 'End game?',
    message: 'End this game for everyone? This cannot be undone.',
    okText: 'End Game',
    cancelText: 'Cancel',
    danger: true
  });
  if (!ok) return;

  // Close any open UI immediately and go back to the main page.
  try { closeSettingsModal?.(); } catch (_) {}
  try { (function(){ const __el = document.getElementById('game-log'); if (__el) __el.style.display = 'none'; })() } catch (_) {}
  try { (function(){ const __el = document.getElementById('game-menu'); if (__el) __el.style.display = 'none'; })() } catch (_) {}
  try { (function(){ const __el = document.getElementById('popover-backdrop'); if (__el) __el.style.display = 'none'; })() } catch (_) {}

  // Stop listening to the game on this client right away.
  try { stopGameListener?.(); } catch (_) {}

  // Return to the launch screen (do NOT sign out).
  try { window.returnToLaunchScreen?.(); } catch (_) {}

  // End the game for everyone (best-effort; don't block UI navigation).
  db.collection('games').doc(gameId).update({
    winner: 'ended',
    currentPhase: 'ended',
    timerEnd: null,
    endedReason: 'manual',
    endedBy: {
      odId: getUserId() || null,
      name: userName
    },
    log: firebase.firestore.FieldValue.arrayUnion(`${userName} ended the game.`),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }).catch((e) => {
    console.error('Failed to end game:', e);
  });
}

/* =========================
   Game End
========================= */
function showGameEndOverlay() {
  // Remove existing overlay if any
  const existing = document.querySelector('.game-end-overlay');
  if (existing) existing.remove();

  if (!currentGame?.winner) return;

  const isRedBlueWin = currentGame.winner === 'red' || currentGame.winner === 'blue';

  const overlay = document.createElement('div');
  overlay.className = 'game-end-overlay';

  if (isRedBlueWin) {
    const winnerName = truncateTeamNameGame(currentGame.winner === 'red' ? (currentGame.redTeamName || 'Red') : (currentGame.blueTeamName || 'Blue'));

    // Play a single result sound (if available)
    if (window.playSound) {
      setTimeout(() => {
        window.playSound('gameWin');
      }, 250);
    }

    overlay.innerHTML = `
      <div class="game-end-card">
        <div class="game-end-title win">${escapeHtml(winnerName)} won!</div>
        <div class="game-end-subtitle">Thanks for playing.</div>
        <div class="game-end-actions">
          <button class="btn primary" onclick="handleBackToHomepageAfterGame()">Back to Homepage</button>
        </div>
      </div>
    `;
  } else {
    const endedByName = currentGame?.endedBy?.name;
    const reason = currentGame?.endedReason;
    const subtitleParts = [];
    if (endedByName) subtitleParts.push(`Ended by ${escapeHtml(endedByName)}.`);
    if (reason) subtitleParts.push(`${escapeHtml(String(reason))}.`);
    const subtitle = subtitleParts.length ? subtitleParts.join(' ') : 'This game has ended.';

    overlay.innerHTML = `
      <div class="game-end-card">
        <div class="game-end-title">Game ended</div>
        <div class="game-end-subtitle">${subtitle}</div>
        <div class="game-end-actions">
          <button class="btn primary" onclick="handleBackToHomepageAfterGame()">Back to Homepage</button>
        </div>
      </div>
    `;
  }

  document.body.appendChild(overlay);
}

async function handleBackToHomepageAfterGame() {
  // Remove overlay
  const overlay = document.querySelector('.game-end-overlay');
  if (overlay) overlay.remove();

  // Stop any running AI loops/timers
  try { window.cleanupAllAI && window.cleanupAllAI(); } catch (_) {}
  try { window.stopAIGameLoop && window.stopAIGameLoop(); } catch (_) {}

  const wasLocalPractice = isCurrentLocalPracticeGame();
  const localPracticeId = currentGame?.id;
  const wasQuick = (currentGame?.type === 'quick') || (currentGame?.id === QUICKPLAY_DOC_ID);

  if (wasLocalPractice && localPracticeId) {
    try { deleteLocalPracticeGame(localPracticeId); } catch (_) {}
    try { stopLocalPracticeAI(); } catch (_) {}
  }

  stopGameListener();

  // Clear the Quick Play lobby completely (new, empty waiting game)
  if (wasQuick) {
    try {
      const uiSettings = readQuickSettingsFromUI();
      const newGameData = await buildQuickPlayGameData(uiSettings);
      await db.collection('games').doc(QUICKPLAY_DOC_ID).set({
        ...newGameData,
        log: ['Previous game finished. Lobby cleared.']
      });
      await clearOperativeChats(QUICKPLAY_DOC_ID);
    } catch (e) {
      console.warn('Failed to clear Quick Play lobby (best-effort):', e);
    }
  }

  // Reset local lobby selections so the next join starts clean.
  try {
    selectedQuickTeam = null;
    selectedQuickSeatRole = 'operative';
    quickAutoJoinedSpectator = false;
  } catch (_) {}

  // Back to the main/home UI
  try {
    currentPlayMode = 'select';
  } catch (_) {}
  try { window.returnToLaunchScreen?.(); }
  catch (_) { showGameLobby(); }
}

function isSpectating() {
  if (!currentGame) return false;
  if (spectatorMode) return true;
  // If you're not on either team in this game, you're effectively a spectator
  return !getMyTeamColor();
}

/* =========================
   Helpers
========================= */
function getMyTeam() {
  const userId = getUserId();
  if (!userId) return null;

  return teamsCache.find(t => {
    return getMembers(t).some(m => isSameAccount(m, userId));
  });
}

function isCurrentUserRosterEntry(player) {
  if (!player) return false;
  const myId = String(getUserId() || '').trim();
  const playerId = String(player?.odId || player?.userId || player?.id || '').trim();
  if (myId && playerId && playerId === myId) return true;

  const myNameNorm = normalizeSpyIdentity(getUserName());
  if (!myNameNorm) return false;
  return normalizeSpyIdentity(player?.name) === myNameNorm;
}

function getMyTeamColor() {
  if (!currentGame) return null;

  // Quick Play + Practice both store per-game player arrays.
  if (currentGame.type === 'quick' || currentGame.type === 'practice') {
    const inRed = (currentGame.redPlayers || []).some((p) => isCurrentUserRosterEntry(p));
    const inBlue = (currentGame.bluePlayers || []).some((p) => isCurrentUserRosterEntry(p));
    if (inRed) return 'red';
    if (inBlue) return 'blue';
    return null;
  }

  // For Tournament games, check team membership
  const myTeam = getMyTeam();
  if (!myTeam) return null;

  if (currentGame.redTeamId === myTeam.id) return 'red';
  if (currentGame.blueTeamId === myTeam.id) return 'blue';
  return null;
}

function isCurrentUserSpymaster() {
  if (!currentGame) return false;

  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return false;

  const roster = getTeamPlayers(myTeamColor, currentGame);
  const me = roster.find((p) => isCurrentUserRosterEntry(p)) || null;
  if (me) {
    if (isSpymasterPlayerForTeam(me, myTeamColor, currentGame)) return true;
    return String(me?.role || '').toLowerCase() === 'spymaster';
  }

  const userNorm = normalizeSpyIdentity(getUserName());
  if (!userNorm) return false;
  const byName = getTeamSpymasterName(myTeamColor, currentGame);
  return !!byName && normalizeSpyIdentity(byName) === userNorm;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

/* =========================
   Game Tab Badge
========================= */
function updateGameTabBadge() {
  const desktopBadge = document.getElementById('badge-game-desktop');
  const mobileBadge = document.getElementById('badge-game-mobile');

  // Count incoming challenges and active games
  let badgeCount = 0;

  const myTeam = getMyTeam();
  if (myTeam) {
    // Check for incoming challenges (async, but we use cached data if available)
    getChallenges().then(challenges => {
      const incoming = challenges.filter(c => c.toTeamId === myTeam.id && c.status === 'pending');
      badgeCount = incoming.length;

      // Also check for active game
      getActiveGameForTeam(myTeam.id).then(game => {
        if (game) badgeCount++;

        if (desktopBadge) {
          desktopBadge.style.display = badgeCount > 0 ? 'inline-flex' : 'none';
          desktopBadge.textContent = badgeCount;
        }
        if (mobileBadge) {
          mobileBadge.style.display = badgeCount > 0 ? 'inline-flex' : 'none';
          mobileBadge.textContent = badgeCount;
        }
      });
    });
  } else {
    if (desktopBadge) desktopBadge.style.display = 'none';
    if (mobileBadge) mobileBadge.style.display = 'none';
  }
}

// Call badge update on init
setTimeout(updateGameTabBadge, 1000);

/* =========================
   ADVANCED GAME FEATURES
   - Card Tagging
   - Operative Chat
   - Clue History
   - Timer Display
   - Team Roster
========================= */

// State for advanced features
let cardTags = {}; // { cardIndex: 'yes'|'maybe'|'no' }
let pendingCardSelection = null;
let clueTargetSelection = [];
let gameLogActiveTab = 'history';
let _gameLogTabBindingsReady = false;
let _stackingSettingsBindingReady = false;
// Used to run the slow, smooth selection animation exactly once
let _pendingSelectAnimIndex = null; // cardIndex pending confirmation
let _pendingSelectionContextKey = null; // turn/clue context at time of selection
let revealedPeekCardIndex = null; // one revealed card can be "stood up" at a time
let activeTagMode = null; // 'yes'|'maybe'|'no'|'clear'|null
let _processingGuess = false; // Guard against concurrent handleCardClick calls
let _processingClue = false; // Guard against concurrent giveClue calls
let _clueDraftSyncTimer = null;
let _clueDraftSyncInFlight = false;
let _lastSentClueDraftSig = '';
let _clueChallengeActionBusy = false;
const _councilReviewRunning = new Set();
// Live judge verdict tracking for animated UI
let _liveJudgeVerdicts = {}; // { pendingId: { judges: [{judge,verdict,reason},...], finalVerdict: null|'legal'|'illegal', flashDone: false } }
let _lastCardConfirmAt = 0;
let _lastCardConfirmIndex = -1;
let operativeChatUnsub = null;
let operativeChatTeamViewing = null; // 'red' | 'blue'
let spectatorChatTeam = 'red';
let ogChatUnreadCount = 0;
let ogChatLastSeenMs = 0;
let ogChatLastMessageMs = 0;
let ogChatUnreadKey = '';
let _consideringSyncNonce = 0;

// When Cozy/Online (OG-style) panels are active, we dock the existing chat panel
// into the left OG panel so it sits bottom-left parallel to the Game Log.
let ogChatOriginalParent = null;
let ogChatOriginalNextSibling = null;
let gameTimerInterval = null;
let gameTimerEnd = null;
let timerBackfillInFlight = false;
let timerBackfillLastKey = '';
let timerBackfillLastAt = 0;

function maybeBackfillCurrentTurnTimer(game) {
  if (!game || game.type !== 'quick' || game.winner) return;
  const phase = String(game.currentPhase || '');
  if (phase !== 'spymaster' && phase !== 'operatives') return;
  if (game.timerEnd) return;

  const secs = getPhaseTimerSeconds(game, phase);
  if (!secs) return;

  const key = `${String(game.id || '')}:${phase}:${String(game.currentTeam || '')}:${secs}`;
  const now = Date.now();
  if (timerBackfillInFlight) return;
  if (timerBackfillLastKey === key && (now - timerBackfillLastAt) < 1500) return;

  timerBackfillInFlight = true;
  timerBackfillLastKey = key;
  timerBackfillLastAt = now;

  const ref = db.collection('games').doc(String(game.id || '').trim());
  db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;
    const current = snap.data() || {};
    if (current.winner) return;
    if (String(current.currentPhase || '') !== phase) return;
    if (String(current.currentTeam || '') !== String(game.currentTeam || '')) return;
    if (current.timerEnd) return;
    const end = buildPhaseTimerEndValue(current, phase);
    if (!end) return;
    tx.update(ref, {
      timerEnd: end,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  }).catch(() => {}).finally(() => {
    timerBackfillInFlight = false;
  });
}

// Initialize advanced features
function initAdvancedFeatures() {
  // Robust card interaction routing (selection + confirm) via event delegation.
  // This avoids inline onclick timing/bubbling glitches.
  setupBoardCardInteractions();

  // Tag buttons
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const tag = btn.dataset.tag;
      if (tag === 'clear') {
        clearAllTags();
        return;
      }
      setActiveTagMode(tag === activeTagMode ? null : tag);
    });
  });

  // Mobile swipe gestures: swipe right for Clue History/Log, swipe left for Team Chat
  initMobileSidebarSwipes();

  // Sidebar toggles
  document.getElementById('toggle-left-sidebar')?.addEventListener('click', toggleLeftSidebar);
  document.getElementById('toggle-right-sidebar')?.addEventListener('click', toggleRightSidebar);

  // Mobile: players popup
  document.getElementById('mobile-players-popup-btn')?.addEventListener('click', openPlayersPopup);
  document.getElementById('players-popup-close')?.addEventListener('click', closePlayersPopup);
  document.getElementById('players-popup-backdrop')?.addEventListener('click', closePlayersPopup);

  // Operative chat form
  document.getElementById('operative-chat-form')?.addEventListener('submit', handleOperativeChatSubmit);

  // Spectator: toggle between RED/BLUE operative chats
  document.getElementById('spectator-chat-toggle')?.addEventListener('click', () => {
    if (!spectatorMode && getMyTeamColor()) return;
    spectatorChatTeam = (spectatorChatTeam === 'red') ? 'blue' : 'red';
    initOperativeChat();
  });

  // Close sidebars on backdrop click
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('sidebar-backdrop')) {
      closeMobileSidebars();
    }
  });

  // If the tab was backgrounded during an in-flight guess, avoid a stuck local lock.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) _processingGuess = false;
  });
  window.addEventListener('focus', () => {
    _processingGuess = false;
  });

  if (!window.__ogChatUnreadResizeBound) {
    window.__ogChatUnreadResizeBound = true;
    window.addEventListener('resize', updateOgChatUnreadBadge);
  }
}

// Call init on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  initAdvancedFeatures();
});

let _boardCardInteractionsBound = false;
function setupBoardCardInteractions() {
  if (_boardCardInteractionsBound) return;
  const boardEl = document.getElementById('game-board');
  if (!boardEl) return;
  _boardCardInteractionsBound = true;

  const routeCardInteraction = (evt, source = 'click') => {
    const target = evt.target;
    if (!target) return;

    const checkmark = target.closest('.card-checkmark');
    if (checkmark && boardEl.contains(checkmark)) {
      const ownerCard = checkmark.closest('.game-card');
      const idx = Number(checkmark.getAttribute('data-card-index') || ownerCard?.dataset?.index);
      if (!Number.isInteger(idx) || idx < 0) return;
      // Pointer-based devices often dispatch pointerup + click for the same tap.
      // Let pointerup win and ignore the duplicate click.
      const now = Date.now();
      if (
        source === 'click' &&
        setupBoardCardInteractions._lastSource === 'pointerup' &&
        setupBoardCardInteractions._lastKind === 'confirm' &&
        setupBoardCardInteractions._lastIdx === idx &&
        (now - (setupBoardCardInteractions._lastAt || 0)) < 280
      ) {
        return;
      }
      setupBoardCardInteractions._lastSource = source;
      setupBoardCardInteractions._lastKind = 'confirm';
      setupBoardCardInteractions._lastIdx = idx;
      setupBoardCardInteractions._lastAt = now;
      void handleCardConfirm(evt, idx);
      return;
    }

    const cardEl = target.closest('.game-card');
    if (!cardEl || !boardEl.contains(cardEl)) return;

    const idx = Number(cardEl.dataset.index);
    if (!Number.isInteger(idx) || idx < 0) return;

    if (cardEl.classList.contains('revealed') && isOnlineStyleActive()) {
      const now = Date.now();
      if (
        source === 'click' &&
        setupBoardCardInteractions._lastSource === 'pointerup' &&
        setupBoardCardInteractions._lastKind === 'peek' &&
        setupBoardCardInteractions._lastIdx === idx &&
        (now - (setupBoardCardInteractions._lastAt || 0)) < 280
      ) {
        return;
      }
      setupBoardCardInteractions._lastSource = source;
      setupBoardCardInteractions._lastKind = 'peek';
      setupBoardCardInteractions._lastIdx = idx;
      setupBoardCardInteractions._lastAt = now;
      handleRevealedCardPeek(idx);
      return;
    }

    const now = Date.now();
    if (
      source === 'click' &&
      setupBoardCardInteractions._lastSource === 'pointerup' &&
      setupBoardCardInteractions._lastKind === 'select' &&
      setupBoardCardInteractions._lastIdx === idx &&
      (now - (setupBoardCardInteractions._lastAt || 0)) < 280
    ) {
      return;
    }
    setupBoardCardInteractions._lastSource = source;
    setupBoardCardInteractions._lastKind = 'select';
    setupBoardCardInteractions._lastIdx = idx;
    setupBoardCardInteractions._lastAt = now;
    handleCardSelect(idx);
  };

  boardEl.addEventListener('pointerup', (evt) => {
    if (evt.button !== undefined && evt.button !== 0) return;
    routeCardInteraction(evt, 'pointerup');
  });
  boardEl.addEventListener('click', (evt) => {
    routeCardInteraction(evt, 'click');
  });
  boardEl.addEventListener('keydown', (evt) => {
    if (evt.key !== 'Enter' && evt.key !== ' ') return;
    const target = evt.target;
    if (!target) return;
    if (!target.closest?.('.card-checkmark')) return;
    evt.preventDefault();
    routeCardInteraction(evt, 'keyboard');
  });
}
setupBoardCardInteractions._lastSource = '';
setupBoardCardInteractions._lastKind = '';
setupBoardCardInteractions._lastIdx = -1;
setupBoardCardInteractions._lastAt = 0;

/* =========================
   Card Tagging System
========================= */
function setActiveTagMode(mode) {
  activeTagMode = mode;

  // Update button states
  document.querySelectorAll('.tag-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tag === mode);
  });

  // Update card cursor state
  document.querySelectorAll('.game-card').forEach(card => {
    card.classList.toggle('tag-mode', !!mode && !card.classList.contains('revealed'));
  });
}

function getCurrentMarkerOwnerId() {
  try {
    const uid = (typeof getUserId === 'function') ? String(getUserId() || '').trim() : '';
    return uid ? `u:${uid}` : 'u:local';
  } catch (_) {
    return 'u:local';
  }
}

function getPlayerInitials(name) {
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

function normalizeTeamConsideringBucket(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [owner, value] of Object.entries(raw || {})) {
    const id = String(owner || '').trim();
    if (!id) continue;
    if (typeof value === 'string') {
      const initials = getPlayerInitials(value);
      out[id] = { initials, name: String(value || ''), ts: Date.now() };
      continue;
    }
    if (!value || typeof value !== 'object') continue;
    const name = String(value.name || value.n || '').trim();
    const initialsRaw = String(value.initials || value.i || '').trim();
    const initials = (initialsRaw ? initialsRaw : getPlayerInitials(name)).slice(0, 3).toUpperCase();
    const ts = Number(value.ts || value.t || 0);
    out[id] = {
      initials: initials || '?',
      name,
      ts: Number.isFinite(ts) ? ts : 0
    };
  }
  return out;
}

function getTeamConsideringEntriesForCard(teamConsidering, cardIndex, myOwnerId = '') {
  const raw = teamConsidering ? (teamConsidering[String(cardIndex)] ?? teamConsidering[cardIndex]) : null;
  const bucket = normalizeTeamConsideringBucket(raw);
  const now = Date.now();
  const MAX_CONSIDERING_AGE_MS = 3 * 60 * 1000;
  return Object.entries(bucket)
    .map(([owner, value]) => {
      const ts = Number(value?.ts || 0);
      if (ts > 0 && (now - ts) > MAX_CONSIDERING_AGE_MS) return null;
      return {
        owner,
        initials: String(value?.initials || '?').slice(0, 3).toUpperCase(),
        name: String(value?.name || '').trim(),
        ts,
        isAI: owner.startsWith('ai:') || owner.startsWith('ai_'),
        isMine: !!(myOwnerId && owner === myOwnerId),
      };
    })
    .filter(Boolean)
    .sort((a, b) => {
      if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
      const at = Number(a.ts || 0);
      const bt = Number(b.ts || 0);
      return bt - at;
    });
}

async function syncTeamConsidering(cardIndexOrNull) {
  try {
    if (!currentGame?.id) return;
    if (isCurrentLocalPracticeGame()) return;
    const myTeam = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
    if (myTeam !== 'red' && myTeam !== 'blue') return;
    const ownerId = getCurrentMarkerOwnerId();
    const userName = String((typeof getUserName === 'function') ? (getUserName() || '') : '').trim();
    const initials = getPlayerInitials(userName);
    const hasIndex =
      cardIndexOrNull !== null &&
      cardIndexOrNull !== undefined &&
      String(cardIndexOrNull).trim() !== '' &&
      Number.isInteger(Number(cardIndexOrNull));
    const nextIdx = hasIndex ? Number(cardIndexOrNull) : null;
    const field = (myTeam === 'red') ? 'redConsidering' : 'blueConsidering';
    const ref = db.collection('games').doc(currentGame.id);
    const nonce = ++_consideringSyncNonce;

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const considering = { ...(game?.[field] || {}) };

      // Each user can consider at most one card at a time.
      for (const key of Object.keys(considering)) {
        const bucket = normalizeTeamConsideringBucket(considering[key]);
        delete bucket[ownerId];
        if (Object.keys(bucket).length) considering[key] = bucket;
        else delete considering[key];
      }

      if (nextIdx !== null && nextIdx >= 0) {
        const key = String(nextIdx);
        const bucket = normalizeTeamConsideringBucket(considering[key]);
        bucket[ownerId] = {
          initials,
          name: userName || 'Player',
          ts: Date.now()
        };
        considering[key] = bucket;
      }

      tx.update(ref, {
        [field]: considering,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });

    // Ignore stale race completions.
    if (nonce !== _consideringSyncNonce) return;
  } catch (_) {}
}

function normalizeTeamMarkerBucket(raw) {
  const out = {};
  if (!raw) return out;
  const valid = new Set(['yes', 'maybe', 'no']);

  // Legacy shape: marker is a single string for this card.
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

function getTeamMarkerEntriesForCard(teamMarkers, cardIndex, myOwnerId = '') {
  const raw = teamMarkers ? (teamMarkers[String(cardIndex)] ?? teamMarkers[cardIndex]) : null;
  const bucket = normalizeTeamMarkerBucket(raw);
  return Object.entries(bucket).map(([owner, tag]) => ({
    owner,
    tag,
    isAI: owner.startsWith('ai:') || owner.startsWith('ai_'),
    isMine: !!(myOwnerId && owner === myOwnerId),
  }));
}

function buildCardTagElement(tag, opts = {}) {
  const isAI = !!opts.isAI;
  const isShared = !!opts.isShared;
  const isMine = !!opts.isMine;

  const tagEl = document.createElement('div');
  tagEl.className = `card-tag ${isAI ? 'ai' : ''} ${isShared ? 'shared' : ''} ${isMine ? 'mine' : ''} tag-${tag}`;
  tagEl.setAttribute('aria-hidden', 'true');

  if (tag === 'yes') {
    tagEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
  } else if (tag === 'maybe') {
    tagEl.innerHTML = '?';
  } else if (tag === 'no') {
    tagEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  } else {
    return null;
  }

  return tagEl;
}

async function syncTeamMarker(cardIndex, tag) {
  try {
    if (!currentGame?.id) return;
    if (isCurrentLocalPracticeGame()) return;
    const myTeam = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
    if (myTeam !== 'red' && myTeam !== 'blue') return;
    const idx = Number(cardIndex);
    if (!Number.isFinite(idx) || idx < 0) return;
    const ownerId = getCurrentMarkerOwnerId();
    const field = (myTeam === 'red') ? 'redMarkers' : 'blueMarkers';
    const t = String(tag || '').toLowerCase().trim();
    const clear = !t || t === 'clear';
    if (!clear && !['yes', 'maybe', 'no'].includes(t)) return;

    const ref = db.collection('games').doc(currentGame.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const markers = { ...(game?.[field] || {}) };
      const key = String(idx);
      const bucket = normalizeTeamMarkerBucket(markers[key]);

      if (clear) delete bucket[ownerId];
      else bucket[ownerId] = t;

      if (Object.keys(bucket).length) markers[key] = bucket;
      else delete markers[key];

      tx.update(ref, {
        [field]: markers,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (e) {
    // ignore
  }
}

async function clearTeamMarkers() {
  try {
    if (!currentGame?.id) return;
    if (isCurrentLocalPracticeGame()) return;
    const myTeam = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
    if (myTeam !== 'red' && myTeam !== 'blue') return;
    const ownerId = getCurrentMarkerOwnerId();
    const field = (myTeam === 'red') ? 'redMarkers' : 'blueMarkers';
    const ref = db.collection('games').doc(currentGame.id);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const game = snap.data() || {};
      const markers = { ...(game?.[field] || {}) };

      for (const key of Object.keys(markers)) {
        const bucket = normalizeTeamMarkerBucket(markers[key]);
        delete bucket[ownerId];
        if (Object.keys(bucket).length) markers[key] = bucket;
        else delete markers[key];
      }

      tx.update(ref, {
        [field]: markers,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
  } catch (e) {}
}

function tagCard(cardIndex, tag) {
  const idx = Number(cardIndex);

  // Determine what is currently visible on this card for *your team*.
  const myTeam = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
  const teamMarkers = (myTeam === 'red')
    ? (currentGame?.redMarkers || {})
    : (myTeam === 'blue')
      ? (currentGame?.blueMarkers || {})
      : {};
  const myOwnerId = getCurrentMarkerOwnerId();

  const currentLocal = cardTags[idx] || null;
  const currentShared = getTeamMarkerEntriesForCard(teamMarkers, idx, myOwnerId).find(m => m.isMine)?.tag || null;
  const currentEffective = currentLocal || currentShared || null;

  // Toggle behavior:
  // - First click applies the marker.
  // - Clicking the same marker again clears it (for the team), not just locally.
  let effectiveToSync = tag;

  if (tag === 'clear' || (currentEffective && currentEffective === tag)) {
    // Clear local + shared
    delete cardTags[idx];
    effectiveToSync = 'clear';
  } else {
    cardTags[idx] = tag;
  }

  renderCardTags();
  saveTagsToLocal();
  // Share markers with your team (opponents never see them in the UI)
  try { syncTeamMarker(idx, effectiveToSync); } catch (_) {}

  // Notify AI (and any other listeners) that a human tag changed.
  try {
    const gameId = currentGame?.id || null;
    const teamColor = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
    window.dispatchEvent(new CustomEvent('codenames:humanTagsChanged', {
      detail: {
        gameId,
        teamColor,
        cardIndex: idx,
        tag: effectiveToSync,
        tags: { ...cardTags },
      }
    }));
  } catch (_) {}
}

function clearAllTags() {
  cardTags = {};
  clearPendingCardSelection();
  renderCardTags();
  saveTagsToLocal();
  try { clearTeamMarkers(); } catch (_) {}
  setActiveTagMode(null);
}

function renderCardTags() {
  const cards = document.querySelectorAll('.game-card');
  const gameId = currentGame?.id;
  const aiMarks = (gameId && typeof window.getAICardMarksForGame === 'function')
    ? (window.getAICardMarksForGame(gameId) || {})
    : {};

  const myTeam = (typeof getMyTeamColor === 'function') ? (getMyTeamColor() || null) : null;
  const teamMarkers = (myTeam === 'red')
    ? (currentGame?.redMarkers || {})
    : (myTeam === 'blue')
      ? (currentGame?.blueMarkers || {})
      : {};
  const myOwnerId = getCurrentMarkerOwnerId();

  cards.forEach((card, index) => {
    // Remove existing tags (human, team, or AI)
    card.querySelectorAll('.card-tag-row').forEach(el => el.remove());
    card.querySelectorAll('.card-tag').forEach(el => el.remove());

    if (card.classList.contains('revealed')) return;

    const humanTag = cardTags[index];
    const aiTag = aiMarks ? aiMarks[index] : null;
    const sharedEntries = getTeamMarkerEntriesForCard(teamMarkers, index, myOwnerId);
    const marks = [];

    // Local mark first (instant feedback).
    if (humanTag && ['yes', 'maybe', 'no'].includes(humanTag)) {
      marks.push({ tag: humanTag, isAI: false, isShared: false, isMine: true, owner: myOwnerId });
    }

    // Team-shared marks (other players + AIs). If my local tag exists, suppress my shared duplicate.
    sharedEntries
      .sort((a, b) => {
        if (a.isMine !== b.isMine) return a.isMine ? -1 : 1;
        if (a.isAI !== b.isAI) return a.isAI ? 1 : -1;
        return String(a.owner).localeCompare(String(b.owner));
      })
      .forEach(entry => {
        if (!['yes', 'maybe', 'no'].includes(entry.tag)) return;
        if (entry.isMine && humanTag) return;
        marks.push({ tag: entry.tag, isAI: entry.isAI, isShared: true, isMine: entry.isMine, owner: entry.owner });
      });

    // Fallback to local-only AI hint if no shared marks are present.
    if (!marks.length && aiTag && ['yes', 'maybe', 'no'].includes(aiTag)) {
      marks.push({ tag: aiTag, isAI: true, isShared: false, isMine: false, owner: 'ai:local' });
    }

    if (!marks.length) return;

    const row = document.createElement('div');
    row.className = 'card-tag-row';

    const visible = marks.slice(0, 4);
    for (const mark of visible) {
      const el = buildCardTagElement(mark.tag, {
        isAI: mark.isAI,
        isShared: mark.isShared,
        isMine: mark.isMine
      });
      if (el) row.appendChild(el);
    }

    if (marks.length > visible.length) {
      const extra = document.createElement('div');
      extra.className = 'card-tag card-tag-more';
      extra.textContent = `+${marks.length - visible.length}`;
      row.appendChild(extra);
    }

    card.appendChild(row);
  });
}

function saveTagsToLocal() {
  if (!currentGame?.id) return;
  try {
    localStorage.setItem(`codenames_tags_${currentGame.id}`, JSON.stringify(cardTags));
  } catch (e) {}
}

function loadTagsFromLocal() {
  if (!currentGame?.id) return;
  try {
    const saved = localStorage.getItem(`codenames_tags_${currentGame.id}`);
    if (saved) {
      cardTags = JSON.parse(saved);
    } else {
      cardTags = {};
    }
  } catch (e) {
    cardTags = {};
  }
}

function getPendingSelectionContextKey(game = currentGame) {
  if (!game) return '';
  const clueWord = String(game?.currentClue?.word || '').trim().toLowerCase();
  const clueNumberRaw = game?.currentClue?.number;
  const clueNumber = Number.isFinite(+clueNumberRaw) ? String(+clueNumberRaw) : '';
  const guessesRemaining = Number.isFinite(+game?.guessesRemaining) ? String(+game.guessesRemaining) : '';
  return [
    String(game?.id || ''),
    String(game?.currentTeam || ''),
    String(game?.currentPhase || ''),
    clueWord,
    clueNumber,
    guessesRemaining,
    String(game?.winner || ''),
  ].join('|');
}

/* =========================
   Card Selection Confirmation
========================= */
function updateRevealedCardPeekUI() {
  const cards = document.querySelectorAll('.game-card.revealed');
  cards.forEach((el) => el.classList.remove('revealed-peek'));
  if (revealedPeekCardIndex === null || revealedPeekCardIndex === undefined) return;
  const target = document.querySelector(`.game-card[data-index="${revealedPeekCardIndex}"]`);
  if (target && target.classList.contains('revealed')) {
    target.classList.add('revealed-peek');
  }
}

function handleRevealedCardPeek(cardIndex) {
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;
  const card = currentGame?.cards?.[idx];
  if (!card || !card.revealed) return;

  if (revealedPeekCardIndex === idx) revealedPeekCardIndex = null;
  else revealedPeekCardIndex = idx;
  updateRevealedCardPeekUI();
}

function clearPendingCardSelection() {
  pendingCardSelection = null;
  _pendingSelectAnimIndex = null;
  _pendingSelectionContextKey = null;
  revealedPeekCardIndex = null;
  void syncTeamConsidering(null);
  // Clear any OG "peek" state.
  try {
    document.querySelectorAll('.game-card.og-peek').forEach(el => el.classList.remove('og-peek'));
  } catch (_) {}
  updateRevealedCardPeekUI();
  updatePendingCardSelectionUI();
}

function setPendingCardSelection(cardIndex) {
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;
  pendingCardSelection = idx;
  _pendingSelectAnimIndex = idx;
  _pendingSelectionContextKey = getPendingSelectionContextKey(currentGame);
  revealedPeekCardIndex = null;
  void syncTeamConsidering(idx);
  // Ensure only one card can be in "peek" mode.
  try {
    document.querySelectorAll('.game-card.og-peek').forEach(el => el.classList.remove('og-peek'));
  } catch (_) {}
  updateRevealedCardPeekUI();
  updatePendingCardSelectionUI();
}

function updatePendingCardSelectionUI() {
  const cards = document.querySelectorAll('.game-card');
  cards.forEach((el) => {
    el.classList.remove('pending-select');
    el.classList.remove('select-animate');
  });
  if (pendingCardSelection === null || pendingCardSelection === undefined) return;
  const target = document.querySelector(`.game-card[data-index="${pendingCardSelection}"]`);
  if (target && !target.classList.contains('revealed')) {
    target.classList.add('pending-select');
    // Selection should only show an outline; no motion until confirmation.
    if (_pendingSelectAnimIndex === pendingCardSelection) {
      _pendingSelectAnimIndex = null;
    }
  }
  updateRevealedCardPeekUI();
}

/* =========================
   Operative Team Chat
========================= */

function updateOgChatUnreadBadge() {
  const badge = document.getElementById('og-chat-unread-badge');
  if (!badge) return;
  const show = isOgLikeStyleActive() && isMobileLayoutLike() && ogChatUnreadCount > 0;
  badge.textContent = ogChatUnreadCount > 99 ? '99+' : String(Math.max(0, ogChatUnreadCount));
  badge.style.display = show ? 'inline-flex' : 'none';
}

function resetOgChatUnreadState() {
  ogChatUnreadCount = 0;
  ogChatLastSeenMs = 0;
  ogChatLastMessageMs = 0;
  ogChatUnreadKey = '';
  updateOgChatUnreadBadge();
}

function markOgChatSeen(latestMs = ogChatLastMessageMs) {
  if (Number.isFinite(latestMs) && latestMs > 0) {
    ogChatLastSeenMs = Math.max(ogChatLastSeenMs, latestMs);
    ogChatLastMessageMs = Math.max(ogChatLastMessageMs, latestMs);
  }
  ogChatUnreadCount = 0;
  updateOgChatUnreadBadge();
}

function refreshOgChatUnreadFromMessages(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const gameId = String(currentGame?.id || '').trim();
  const team = String(operativeChatTeamViewing || spectatorChatTeam || getMyTeamColor() || '').trim();
  const key = `${gameId}:${team}`;
  const myId = String(getUserId() || '').trim();

  let latestMs = 0;
  let unread = 0;
  for (const msg of list) {
    const date = resolveChatMessageDate(msg);
    const ms = (date instanceof Date) ? date.getTime() : 0;
    if (!Number.isFinite(ms) || ms <= 0) continue;
    if (ms > latestMs) latestMs = ms;
    if (ms > ogChatLastSeenMs && String(msg?.senderId || '').trim() !== myId) unread += 1;
  }

  // On first load (or when switching game/team chat), don't show historical messages as unread.
  if (key !== ogChatUnreadKey) {
    ogChatUnreadKey = key;
    ogChatLastMessageMs = latestMs;
    ogChatLastSeenMs = latestMs;
    ogChatUnreadCount = 0;
    updateOgChatUnreadBadge();
    return;
  }

  if (latestMs > ogChatLastMessageMs) ogChatLastMessageMs = latestMs;
  const chatOpen = !!document.getElementById('og-chat-slidedown')?.classList.contains('open');
  const shouldTrack = isOgLikeStyleActive() && isMobileLayoutLike();
  if (!shouldTrack || chatOpen) {
    markOgChatSeen(latestMs);
    return;
  }

  ogChatUnreadCount = Math.max(0, unread);
  updateOgChatUnreadBadge();
}

function initOperativeChat() {
  if (!currentGame?.id) return;

  // Cleanup previous listener
  if (operativeChatUnsub) {
    operativeChatUnsub();
    operativeChatUnsub = null;
  }

  if (isCurrentLocalPracticeGame()) {
    let teamForChat = getMyTeamColor();
    const isSpectatorChat = !teamForChat && !!spectatorMode;
    const isSpymasterChat = !isSpectatorChat && !!isCurrentUserSpymaster();
    if (isSpectatorChat) teamForChat = spectatorChatTeam || 'red';
    if (!teamForChat) {
      renderOperativeChat([]);
      return;
    }
    operativeChatTeamViewing = teamForChat;

    try {
      const panel = document.querySelector('.operative-chat-panel');
      if (panel) {
        panel.classList.toggle('chat-team-red', teamForChat === 'red');
        panel.classList.toggle('chat-team-blue', teamForChat === 'blue');
      }
    } catch (_) {}

    const toggleBtn = document.getElementById('spectator-chat-toggle');
    const input = document.getElementById('operative-chat-input');
    const form = document.getElementById('operative-chat-form');
    if (toggleBtn) {
      toggleBtn.style.display = isSpectatorChat ? 'inline-flex' : 'none';
      toggleBtn.textContent = isSpectatorChat
        ? `View ${teamForChat === 'red' ? 'Blue' : 'Red'} Chat`
        : '';
    }
    if (input) {
      const readOnly = isSpectatorChat || isSpymasterChat;
      input.disabled = readOnly;
      input.placeholder = isSpectatorChat
        ? `Spectating ${teamForChat.toUpperCase()} chat…`
        : (isSpymasterChat ? 'Spymasters cannot send team chat.' : 'Message your team...');
    }
    if (form) {
      form.classList.toggle('spectator-readonly', isSpectatorChat || isSpymasterChat);
    }
    const chatField = teamForChat === 'blue' ? 'blueChat' : 'redChat';
    const messages = Array.isArray(currentGame?.[chatField]) ? currentGame[chatField] : [];
    renderOperativeChat(messages);
    return;
  }

  let teamForChat = getMyTeamColor();
  const isSpectatorChat = !teamForChat && !!spectatorMode;
  const isSpymasterChat = !isSpectatorChat && !!isCurrentUserSpymaster();

  // Spectators can toggle between RED/BLUE operative chats (read-only)
  if (isSpectatorChat) {
    teamForChat = spectatorChatTeam || 'red';
  }

  if (!teamForChat) return;
  operativeChatTeamViewing = teamForChat;

  // Apply a team palette class so CSS can theme the chat (red/blue)
  try {
    const panel = document.querySelector('.operative-chat-panel');
    if (panel) {
      panel.classList.toggle('chat-team-red', teamForChat === 'red');
      panel.classList.toggle('chat-team-blue', teamForChat === 'blue');
    }
  } catch (_) {}

  // Update spectator toggle UI + read-only state
  const toggleBtn = document.getElementById('spectator-chat-toggle');
  const input = document.getElementById('operative-chat-input');
  const form = document.getElementById('operative-chat-form');

  if (toggleBtn) {
    toggleBtn.style.display = isSpectatorChat ? 'inline-flex' : 'none';
    toggleBtn.textContent = isSpectatorChat
      ? `View ${teamForChat === 'red' ? 'Blue' : 'Red'} Chat`
      : '';
  }
  if (input) {
    const readOnly = isSpectatorChat || isSpymasterChat;
    input.disabled = readOnly;
    input.placeholder = isSpectatorChat
      ? `Spectating ${teamForChat.toUpperCase()} chat…`
      : (isSpymasterChat ? 'Spymasters cannot send team chat.' : 'Message your team...');
  }
  if (form) {
    form.classList.toggle('spectator-readonly', isSpectatorChat || isSpymasterChat);
  }

  // Listen to team chat subcollection
  operativeChatUnsub = db.collection('games').doc(currentGame.id)
    .collection(`${teamForChat}Chat`)
    .orderBy('createdAt', 'asc')
    .limitToLast(50)
    .onSnapshot(snap => {
      renderOperativeChat(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error('Chat error:', err));
}

function renderOperativeChat(messages) {
  const container = document.getElementById('operative-chat-messages');
  if (!container) return;

  const list = Array.isArray(messages) ? messages : [];
  refreshOgChatUnreadFromMessages(list);

  const odId = getUserId();

  if (!list.length) {
    container.innerHTML = '<div class="chat-empty-state">No messages yet. Discuss with your team!</div>';
    return;
  }

  // Check if user is near the bottom before re-rendering (within 80px)
  const wasNearBottom = (container.scrollHeight - container.scrollTop - container.clientHeight) < 80;

  container.innerHTML = list.map(msg => {
    const isMe = msg.senderId === odId;
    const time = formatTime(resolveChatMessageDate(msg));
    const teamColor = operativeChatTeamViewing || getMyTeamColor() || 'red';

    return `
      <div class="chat-message ${isMe ? 'my-message' : ''}">
        <div class="chat-message-header">
          <span class="chat-sender ${teamColor}">${escapeHtml(msg.senderName)}</span>
          <span class="chat-time">${time}</span>
        </div>
        <div class="chat-text">${escapeHtml(msg.text)}</div>
      </div>
    `;
  }).join('');

  // Auto-scroll to bottom reliably (use rAF to ensure DOM has laid out)
  if (wasNearBottom || !container._hasScrolledOnce) {
    container._hasScrolledOnce = true;
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

function resolveChatMessageDate(msg) {
  if (!msg || typeof msg !== 'object') return null;
  try {
    if (msg.createdAt?.toDate && typeof msg.createdAt.toDate === 'function') {
      const d = msg.createdAt.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
  } catch (_) {}
  if (msg.createdAt instanceof Date && !Number.isNaN(msg.createdAt.getTime())) return msg.createdAt;
  if (Number.isFinite(+msg.createdAtMs)) {
    const d = new Date(+msg.createdAtMs);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (msg.createdAt) {
    const d = new Date(msg.createdAt);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

function formatTime(date) {
  if (!date) return '';
  const h = date.getHours();
  const m = date.getMinutes().toString().padStart(2, '0');
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${h12}:${m} ${ampm}`;
}

async function handleOperativeChatSubmit(e) {
  e.preventDefault();

  const input = document.getElementById('operative-chat-input');
  const text = input?.value?.trim();
  if (!text || !currentGame?.id) return;
  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return;
  const myRoster = getTeamPlayers(myTeamColor, currentGame);
  const me = myRoster.find((p) => isCurrentUserRosterEntry(p)) || null;
  if ((me && isSpymasterPlayerForTeam(me, myTeamColor, currentGame)) || isCurrentUserSpymaster()) return;

  if (isCurrentLocalPracticeGame()) {
    const userName = getUserName();
    const odId = getUserId();
    if (!userName || !odId) return;

    input.value = '';
    const nowMs = Date.now();
    const chatField = myTeamColor === 'blue' ? 'blueChat' : 'redChat';

    mutateLocalPracticeGame(currentGame.id, (draft) => {
      const list = Array.isArray(draft?.[chatField]) ? [...draft[chatField]] : [];
      list.push({
        id: `local_chat_${nowMs}_${Math.random().toString(36).slice(2, 7)}`,
        senderId: odId,
        senderName: userName,
        text: text,
        createdAtMs: nowMs,
      });
      if (list.length > LOCAL_PRACTICE_CHAT_LIMIT) {
        draft[chatField] = list.slice(-LOCAL_PRACTICE_CHAT_LIMIT);
      } else {
        draft[chatField] = list;
      }
      draft.updatedAtMs = nowMs;
      draft.lastMoveAtMs = nowMs;
    });
    return;
  }

  const userName = getUserName();
  const odId = getUserId();
  if (!userName || !odId) return;

  input.value = '';

  try {
    await db.collection('games').doc(currentGame.id)
      .collection(`${myTeamColor}Chat`)
      .add({
        senderId: odId,
        senderName: userName,
        text: text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp()
      });
  } catch (err) {
    console.error('Send chat error:', err);
    input.value = text; // Restore on error
  }
}

function updateChatPrivacyBadge() {
  const badge = document.getElementById('chat-privacy-badge');
  if (!badge) return;

  const isSpymaster = isCurrentUserSpymaster();
  if (isSpymaster) {
    badge.textContent = 'All Team';
    badge.classList.add('spymaster-visible');
  } else {
    badge.textContent = 'Operatives Only';
    badge.classList.remove('spymaster-visible');
  }
}

/* =========================
   Clue History
========================= */
function renderClueHistory() {
  const container = document.getElementById('clue-history-list');
  if (!container || !currentGame) return;

  const history = currentGame.clueHistory || [];
  const myTeam = getMyTeamColor();
  const isSpy = isCurrentUserSpymaster();

  // Only show clues from the player's own team
  const teamHistory = myTeam ? history.filter(clue => clue.team === myTeam) : history;

  if (teamHistory.length === 0) {
    container.innerHTML = '<div class="clue-history-empty">No clues given yet</div>';
    return;
  }

  container.innerHTML = teamHistory.map(clue => {
    // Only spymasters see the specific words that were guessed
    let resultsHtml = '';
    if (isSpy) {
      resultsHtml = (clue.results || []).map((r, idx) => {
        const res = (r.result || (r.correct ? 'correct' : (r.wrong ? 'wrong' : 'neutral')));
        let className = 'neutral';
        if (res === 'correct') className = 'correct';
        else if (res === 'wrong') className = 'wrong';
        else if (res === 'assassin') className = 'assassin';
        const word = String(r.word || '').trim();
        const label = `${idx + 1}. ${word}`;
        return `<span class="guess-chip ${className}">${escapeHtml(label)}</span>`;
      }).join('');
    }

    return `
      <div class="clue-history-item ${clue.team}">
        <div class="clue-history-header">
          <span class="clue-history-team ${clue.team}">${clue.team.toUpperCase()}</span>
          <span class="clue-history-number">${clue.number}</span>
        </div>
        <div class="clue-history-clue">
          <span class="clue-chip ${clue.team}">${escapeHtml(clue.word)}</span>
          <span class="clue-chip-count">×${escapeHtml(String(clue.number ?? ''))}</span>
        </div>
        ${resultsHtml ? `<div class="clue-history-results">${resultsHtml}</div>` : ''}
      </div>
    `;
  }).join('');

  // Scroll to latest
  container.scrollTop = container.scrollHeight;
}

/* =========================
   Timer Display
========================= */
function startGameTimer(endTime, phase) {
  stopGameTimer();

  if (!endTime) return;

  gameTimerEnd = endTime instanceof Date ? endTime : endTime.toDate?.() || new Date(endTime);

  const timerEl = document.getElementById('game-timer');
  const fillEl = document.getElementById('timer-fill');
  const textEl = document.getElementById('timer-text');
  const ogTimerEl = document.getElementById('og-topbar-timer');
  const ogTimerTextEl = document.getElementById('og-topbar-timer-text');
  const ogTimerPhaseEl = document.getElementById('og-topbar-timer-phase');

  if (!timerEl || !fillEl || !textEl) return;

  timerEl.style.display = 'flex';
  if (ogTimerEl) ogTimerEl.style.display = 'inline-flex';
  if (ogTimerPhaseEl) {
    ogTimerPhaseEl.textContent = phase === 'spymaster' ? 'CLUE' : (phase === 'operatives' ? 'GUESS' : 'TIMER');
  }

  const totalDuration = Math.max(1, gameTimerEnd - Date.now());

  gameTimerInterval = setInterval(() => {
    const remaining = Math.max(0, gameTimerEnd - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    const timerText = `${minutes}:${secs.toString().padStart(2, '0')}`;

    textEl.textContent = timerText;
    if (ogTimerTextEl) ogTimerTextEl.textContent = timerText;

    const percent = Math.max(0, Math.min(100, (remaining / totalDuration) * 100));
    fillEl.style.width = `${percent}%`;

    // Warning states
    fillEl.classList.remove('warning', 'danger');
    textEl.classList.remove('warning', 'danger');
    ogTimerEl?.classList.remove('warning', 'danger');

    if (seconds <= 10) {
      fillEl.classList.add('danger');
      textEl.classList.add('danger');
      ogTimerEl?.classList.add('danger');
    } else if (seconds <= 30) {
      fillEl.classList.add('warning');
      textEl.classList.add('warning');
      ogTimerEl?.classList.add('warning');
    }

    if (remaining <= 0) {
      stopGameTimer();
    }
  }, 100);
}

function showStaticGameTimer(phase) {
  if (gameTimerInterval) {
    clearInterval(gameTimerInterval);
    gameTimerInterval = null;
  }
  gameTimerEnd = null;

  const timerEl = document.getElementById('game-timer');
  const fillEl = document.getElementById('timer-fill');
  const textEl = document.getElementById('timer-text');
  const ogTimerEl = document.getElementById('og-topbar-timer');
  const ogTimerTextEl = document.getElementById('og-topbar-timer-text');
  const ogTimerPhaseEl = document.getElementById('og-topbar-timer-phase');
  if (!timerEl || !fillEl || !textEl) return;

  timerEl.style.display = 'flex';
  fillEl.style.width = '100%';
  fillEl.classList.remove('warning', 'danger');
  textEl.classList.remove('warning', 'danger');
  textEl.textContent = '∞';

  if (ogTimerEl) {
    ogTimerEl.style.display = 'inline-flex';
    ogTimerEl.classList.remove('warning', 'danger');
  }
  if (ogTimerTextEl) ogTimerTextEl.textContent = '∞';
  if (ogTimerPhaseEl) {
    ogTimerPhaseEl.textContent = phase === 'spymaster' ? 'CLUE' : (phase === 'operatives' ? 'GUESS' : 'TIMER');
  }
}

function stopGameTimer() {
  if (gameTimerInterval) {
    clearInterval(gameTimerInterval);
    gameTimerInterval = null;
  }
  gameTimerEnd = null;

  const timerEl = document.getElementById('game-timer');
  const ogTimerEl = document.getElementById('og-topbar-timer');
  if (timerEl) timerEl.style.display = 'none';
  if (ogTimerEl) {
    ogTimerEl.style.display = 'none';
    ogTimerEl.classList.remove('warning', 'danger');
  }
}

/* =========================
   Team Roster
========================= */
function renderTeamRoster() {
  const redContainer = document.getElementById('roster-red-players');
  const blueContainer = document.getElementById('roster-blue-players');

  if (!redContainer || !blueContainer || !currentGame) return;

  const renderPlayers = (players, team, isCurrentTeam) => {
    if (!players || players.length === 0) {
      return '<div class="roster-player"><span class="roster-player-name" style="color: var(--text-dim);">No players</span></div>';
    }

    return players.map(p => {
      const isSpymaster = isSpymasterPlayerForTeam(p, team, currentGame);
      const role = isSpymaster ? 'spymaster' : 'operative';
      const isCurrent = isCurrentTeam && currentGame.currentPhase !== 'ended';
      const playerId = p.odId || '';

      return `
        <div class="roster-player ${isCurrent ? 'current-turn' : ''}">
          <span class="roster-player-name ${playerId ? 'profile-link' : ''}" ${playerId ? `data-profile-type="player" data-profile-id="${escapeHtml(playerId)}"` : ''}>${escapeHtml(displayPlayerName(p))}</span>
          <span class="roster-player-role ${role}">${isSpymaster ? 'Spy' : 'Op'}</span>
        </div>
      `;
    }).join('');
  };

  const isRedTurn = currentGame.currentTeam === 'red';
  const isBlueTurn = currentGame.currentTeam === 'blue';

  redContainer.innerHTML = renderPlayers(
    currentGame.redPlayers,
    'red',
    isRedTurn
  );

  blueContainer.innerHTML = renderPlayers(
    currentGame.bluePlayers,
    'blue',
    isBlueTurn
  );
}


/* =========================
   Top Bar Turn Strip + Team Popovers
========================= */
const localPracticePopoverSections = {
  red: { spymaster: true, operatives: true },
  blue: { spymaster: true, operatives: true },
};

function isPracticePopoverSectionOpen(team, role) {
  const t = (team === 'blue') ? 'blue' : 'red';
  const r = (role === 'spymaster') ? 'spymaster' : 'operatives';
  const byTeam = localPracticePopoverSections[t];
  if (!byTeam || typeof byTeam[r] !== 'boolean') return true;
  return byTeam[r];
}

function togglePracticePopoverSection(team, role, evt) {
  try { evt?.preventDefault?.(); } catch (_) {}
  try { evt?.stopPropagation?.(); } catch (_) {}
  if (!isCurrentLocalPracticeGame()) return;
  const t = (team === 'blue') ? 'blue' : 'red';
  const r = (role === 'spymaster') ? 'spymaster' : 'operatives';
  if (!localPracticePopoverSections[t]) localPracticePopoverSections[t] = { spymaster: true, operatives: true };
  localPracticePopoverSections[t][r] = !isPracticePopoverSectionOpen(t, r);
  renderTopbarTeamNames();
  const host = document.getElementById(t === 'red' ? 'topbar-red' : 'topbar-blue');
  host?.classList?.add('popover-open');
}
window.togglePracticePopoverSection = togglePracticePopoverSection;

function renderTopbarTeamNames() {
  if (!currentGame) return;

  // One-time init: click-to-toggle popovers + outside click to close
  if (!window.__topbarPopoversInit) {
    window.__topbarPopoversInit = true;

    const closeAll = () => {
      document.querySelectorAll('.topbar-team.popover-open').forEach(el => el.classList.remove('popover-open'));
    };

    document.addEventListener('click', (e) => {
      const inTopbarTeam = e.target && e.target.closest && e.target.closest('.topbar-team');
      if (!inTopbarTeam) closeAll();
    });

    const bindIcon = (iconId, teamId) => {
      const icon = document.getElementById(iconId);
      const teamEl = document.getElementById(teamId);
      if (!icon || !teamEl) return;

      icon.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const willOpen = !teamEl.classList.contains('popover-open');
        closeAll();
        if (willOpen) teamEl.classList.add('popover-open');
      });
    };

    // Best-effort now + later (icons don't exist on lobby)
    setTimeout(() => {
      bindIcon('topbar-red-icon', 'topbar-red');
      bindIcon('topbar-blue-icon', 'topbar-blue');
    }, 0);
  }

  const redStatusEl = document.getElementById('topbar-red-status');
  const blueStatusEl = document.getElementById('topbar-blue-status');
  const redPop = document.getElementById('team-popover-red');
  const bluePop = document.getElementById('team-popover-blue');

  const phaseToLabel = (phase) => {
    if (phase === 'spymaster') return 'Spymaster Turn';
    if (phase === 'operatives') return 'Operative Turn';
    if (phase === 'role-selection') return 'Pick roles';
    if (phase === 'waiting') return 'Waiting';
    if (phase === 'ended') return 'Game Over';
    return '—';
  };

  const isEnded = !!currentGame.winner || currentGame.currentPhase === 'ended';
  const activeTeam = isEnded ? null : currentGame.currentTeam;
  const activeLabel = isEnded ? 'Game Over' : phaseToLabel(currentGame.currentPhase);

  // Color the turn strip halves based on whose turn it is
  const topbar = document.querySelector('.game-topbar');
  const redTop = document.getElementById('topbar-red');
  const blueTop = document.getElementById('topbar-blue');
  if (topbar) {
    topbar.classList.toggle('turn-red', activeTeam === 'red');
    topbar.classList.toggle('turn-blue', activeTeam === 'blue');
    topbar.classList.toggle('turn-none', !activeTeam);
  }
  const boardContainer = document.getElementById('game-board-container');
  if (boardContainer) {
    const isTurnPhase = activeTeam && (currentGame.currentPhase === 'spymaster' || currentGame.currentPhase === 'operatives');
    boardContainer.classList.toggle('turn-red', activeTeam === 'red');
    boardContainer.classList.toggle('turn-blue', activeTeam === 'blue');
    boardContainer.classList.toggle('turn-none', !activeTeam);
    boardContainer.classList.toggle('turn-spymaster', !!(isTurnPhase && currentGame.currentPhase === 'spymaster'));
    boardContainer.classList.toggle('turn-operatives', !!(isTurnPhase && currentGame.currentPhase === 'operatives'));
  }
  if (redTop) redTop.classList.toggle('is-active', activeTeam === 'red');
  if (blueTop) blueTop.classList.toggle('is-active', activeTeam === 'blue');

  if (redStatusEl) {
    if (activeTeam === 'red') redStatusEl.textContent = activeLabel;
    else if (currentGame.currentPhase === 'waiting') redStatusEl.textContent = 'Waiting for players';
    else if (isEnded) redStatusEl.textContent = '—';
    else redStatusEl.textContent = 'Waiting';
  }

  if (blueStatusEl) {
    if (activeTeam === 'blue') blueStatusEl.textContent = activeLabel;
    else if (currentGame.currentPhase === 'waiting') blueStatusEl.textContent = 'Waiting for players';
    else if (isEnded) blueStatusEl.textContent = '—';
    else blueStatusEl.textContent = 'Waiting';
  }

  const myId = (typeof getUserId === 'function') ? String(getUserId() || '').trim() : '';

  const buildTeamPopover = (team) => {
    const isRed = team === 'red';
    const allowCollapsible = isCurrentLocalPracticeGame();
    const teamName = truncateTeamNameGame(isRed ? (currentGame.redTeamName || 'Red Team') : (currentGame.blueTeamName || 'Blue Team'));
    const roster = isRed ? (currentGame.redPlayers || []) : (currentGame.bluePlayers || []);
    const spymasterEntry = roster.find(p => isSpymasterPlayerForTeam(p, team, currentGame)) || null;
    const operatives = roster.filter(p => !isSpymasterPlayerForTeam(p, team, currentGame));

    const renderPlayerRow = (p, role) => {
      const pid = String(p?.odId || p?.userId || '').trim();
      const isMe = !!(myId && pid && pid === myId);
      const name = escapeHtml(displayPlayerName(p));
      const badge = role === 'spymaster' ? 'Spymaster' : 'Operative';
      const isAI = !!p?.isAI;
      const classes = ['team-popover-player', role, isMe ? 'is-me' : '', isAI ? 'is-ai' : ''].filter(Boolean).join(' ');

      // Make names clickable: AI shows traits popup, humans show profile
      let clickAttr = '';
      if (isAI && pid) {
        clickAttr = `onclick="event.stopPropagation(); window.openAITraitsPopup('${pid}')" style="cursor:pointer;"`;
      } else if (pid && !isAI) {
        clickAttr = `onclick="event.stopPropagation(); if(typeof openProfileDetailsModal==='function') openProfileDetailsModal('${pid}','player')" style="cursor:pointer;"`;
      }

      return `
        <div class="${classes}" ${clickAttr}>
          <div class="team-popover-name">${name}</div>
          <div class="team-popover-badge">${badge}</div>
        </div>
      `;
    };

    const spymasterHtml = spymasterEntry
      ? renderPlayerRow(spymasterEntry, 'spymaster')
      : `<div class="team-popover-player spymaster" style="opacity:0.78;">
           <div class="team-popover-name">No Spymaster yet</div>
           <div class="team-popover-badge">Spymaster</div>
         </div>`;

    const opsHtml = (operatives.length > 0)
      ? operatives.map(p => renderPlayerRow(p, 'operative')).join('')
      : `<div class="team-popover-player operative" style="opacity:0.78;">
           <div class="team-popover-name">No Operatives yet</div>
           <div class="team-popover-badge">Operative</div>
         </div>`;

    const buildSection = (label, role, contentHtml) => {
      const open = !allowCollapsible || isPracticePopoverSectionOpen(team, role);
      const sectionClasses = [
        'team-popover-section',
        allowCollapsible ? 'is-collapsible' : '',
        open ? 'is-expanded' : 'is-collapsed',
      ].filter(Boolean).join(' ');
      const headerHtml = allowCollapsible
        ? `<button class="team-popover-role team-popover-role-toggle" type="button" aria-expanded="${open ? 'true' : 'false'}" onclick="window.togglePracticePopoverSection('${team}','${role}', event)">
             <span>${label}</span>
             <span class="team-popover-role-caret" aria-hidden="true"></span>
           </button>`
        : `<div class="team-popover-role">${label}</div>`;
      return `
        <div class="${sectionClasses}">
          ${headerHtml}
          <div class="team-popover-section-body">
            ${contentHtml}
          </div>
        </div>
      `;
    };

    return `
      <div class="team-popover-header">
        <div>
          <div class="team-popover-title">${escapeHtml(teamName)}</div>
          <div class="team-popover-sub">${roster.length || 0} player${(roster.length || 0) === 1 ? '' : 's'}</div>
        </div>
        <button class="team-popover-close" type="button" aria-label="Close" onclick="event.stopPropagation(); document.querySelectorAll('.topbar-team.popover-open').forEach(el => el.classList.remove('popover-open'))">✕</button>
      </div>

      ${buildSection('Spymaster', 'spymaster', spymasterHtml)}
      ${buildSection('Operatives', 'operatives', opsHtml)}
    `;
  };

  if (redPop) redPop.innerHTML = buildTeamPopover('red');
  if (bluePop) bluePop.innerHTML = buildTeamPopover('blue');
}

/* =========================
   AI Traits Popup
========================= */
function openAITraitsPopup(aiOdId) {
  const allPlayers = [
    ...(currentGame?.redPlayers || []),
    ...(currentGame?.bluePlayers || []),
  ];
  const key = String(aiOdId || '').trim();
  const player = allPlayers.find(p => {
    if (!p?.isAI) return false;
    const pid = String(p?.odId || p?.userId || '').trim();
    return pid && pid === key;
  });
  if (!player) return;

  const traits = player.aiTraits || {};
  const traitDefs = [
    { key: 'confidence', label: 'Confidence', color: '#3b82f6', icon: '🎯' },
    { key: 'riskiness', label: 'Riskiness', color: '#ef4444', icon: '🔥' },
    { key: 'reasoning', label: 'Reasoning', color: '#a855f7', icon: '🧠' },
    { key: 'strategic', label: 'Strategic', color: '#22c55e', icon: '📊' },
    { key: 'farFetched', label: 'Far-Fetched', color: '#f59e0b', icon: '🌀' },
  ];

  const barsHtml = traitDefs.map(t => {
    const val = Math.max(0, Math.min(100, Math.floor(Number(traits[t.key]) || 0)));
    const lowLabel = t.key === 'confidence' ? 'Unsure' :
                     t.key === 'riskiness' ? 'Cautious' :
                     t.key === 'reasoning' ? 'Raw' :
                     t.key === 'strategic' ? 'Vibes' :
                     'Literal';
    const highLabel = t.key === 'confidence' ? 'Certain' :
                      t.key === 'riskiness' ? 'Reckless' :
                      t.key === 'reasoning' ? 'Deep' :
                      t.key === 'strategic' ? 'Bayesian' :
                      'Abstract';
    return `
      <div class="ai-trait-row">
        <div class="ai-trait-label-row">
          <span class="ai-trait-label">${t.icon} ${t.label}</span>
          <span class="ai-trait-value">${val}</span>
        </div>
        <div class="ai-trait-bar-bg">
          <div class="ai-trait-bar-fill" style="width: ${val}%; background: ${t.color};"></div>
        </div>
        <div class="ai-trait-range-labels">
          <span>${lowLabel}</span>
          <span>${highLabel}</span>
        </div>
      </div>
    `;
  }).join('');

  const roleName = player.role === 'spymaster' ? 'Spymaster' : 'Operative';
  const teamColor = (currentGame?.redPlayers || []).some(p => String(p?.odId || '') === String(aiOdId)) ? 'red' : 'blue';
  const teamLabel = teamColor === 'red' ? 'Red Team' : 'Blue Team';

  // Use existing profile-details-modal
  const titleEl = document.getElementById('profile-details-title');
  const bodyEl = document.getElementById('profile-details-body');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = `AI ${escapeHtml(player.name)}`;
  bodyEl.innerHTML = `
    <div class="ai-traits-popup">
      <div class="ai-traits-header">
        <div class="ai-traits-avatar">AI</div>
        <div class="ai-traits-info">
          <div class="ai-traits-name">${escapeHtml(player.name)}</div>
          <div class="ai-traits-subtitle">
            <span class="ai-traits-role">${roleName}</span>
            <span class="ai-traits-team ${teamColor}">${teamLabel}</span>
          </div>
        </div>
      </div>
      <div class="ai-traits-section-title">Personality Profile</div>
      <div class="ai-traits-bars">
        ${barsHtml}
      </div>
    </div>
  `;

  // Open the modal
  const modal = document.getElementById('profile-details-modal');
  if (modal) {
    modal.style.display = 'block';
    void modal.offsetWidth;
    modal.classList.add('modal-open');
  }
}
window.openAITraitsPopup = openAITraitsPopup;


/* =========================
   Sidebar Toggles
========================= */
function toggleLeftSidebar() {
  const sidebar = document.querySelector('.game-sidebar-left');
  const other = document.querySelector('.game-sidebar-right');
  if (!sidebar) return;

  if (window.innerWidth <= 1024) {
    const willShow = !sidebar.classList.contains('mobile-visible');
    // Only one side sheet at a time on mobile.
    if (willShow) other?.classList.remove('mobile-visible');
    sidebar.classList.toggle('mobile-visible', willShow);
    toggleSidebarBackdrop(!!document.querySelector('.game-sidebar.mobile-visible'));
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function toggleRightSidebar() {
  const sidebar = document.querySelector('.game-sidebar-right');
  const other = document.querySelector('.game-sidebar-left');
  if (!sidebar) return;

  if (window.innerWidth <= 1024) {
    const willShow = !sidebar.classList.contains('mobile-visible');
    // Only one side sheet at a time on mobile.
    if (willShow) other?.classList.remove('mobile-visible');
    sidebar.classList.toggle('mobile-visible', willShow);
    toggleSidebarBackdrop(!!document.querySelector('.game-sidebar.mobile-visible'));
    // Scroll chat to bottom when opening chat sidebar
    if (willShow) {
      requestAnimationFrame(() => {
        const chatContainer = document.getElementById('operative-chat-messages');
        if (chatContainer) chatContainer.scrollTop = chatContainer.scrollHeight;
      });
    }
  } else {
    sidebar.classList.toggle('collapsed');
  }
}

function toggleSidebarBackdrop(show) {
  let backdrop = document.querySelector('.sidebar-backdrop');
  if (!backdrop && show) {
    backdrop = document.createElement('div');
    backdrop.className = 'sidebar-backdrop';
    document.body.appendChild(backdrop);
  }
  if (backdrop) {
    backdrop.classList.toggle('visible', show);
  }
}

function closeMobileSidebars() {
  document.querySelectorAll('.game-sidebar').forEach(sb => {
    sb.classList.remove('mobile-visible');
  });
  toggleSidebarBackdrop(false);
}

/* =========================
   Mobile Swipe Sidebars
   - Swipe right: open Clue History + Game Log (left sidebar)
   - Swipe left: open Operative chat (right sidebar)
   - Supports partial swipe (drag) with snap open/close
========================= */
function initMobileSidebarSwipes() {
  // Only relevant on touch devices / mobile layout.
  if (!('ontouchstart' in window)) return;

  const left = document.querySelector('.game-sidebar-left');
  const right = document.querySelector('.game-sidebar-right');
  const backdrop = document.getElementById('sidebar-backdrop') || document.querySelector('.sidebar-backdrop');
  const container = document.getElementById('game-board-container') || document.getElementById('game-board') || document.body;
  if (!left || !right || !container) return;

  let active = null;

  const isMobileLayout = () => window.innerWidth <= 1024;

  const setBackdrop = (progress) => {
    confirmBackdrop(true);
    if (!backdrop) return;
    backdrop.classList.add('visible');
    backdrop.style.transition = 'none';
    backdrop.style.opacity = String(Math.max(0, Math.min(1, progress)));
  };

  const clearBackdropStyles = () => {
    if (!backdrop) return;
    backdrop.style.transition = '';
    backdrop.style.opacity = '';
  };

  const confirmBackdrop = (show) => {
    // Reuse existing helper if available.
    if (typeof toggleSidebarBackdrop === 'function') {
      toggleSidebarBackdrop(show);
    } else if (backdrop) {
      backdrop.classList.toggle('visible', show);
    }
  };

  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  const prepareDrag = (sb) => {
    sb.style.transition = 'none';
    sb.style.willChange = 'transform, opacity';
    sb.style.pointerEvents = 'auto';
    sb.style.visibility = 'visible';
  };

  const clearDrag = (sb) => {
    sb.style.transition = '';
    sb.style.willChange = '';
    sb.style.transform = '';
    sb.style.opacity = '';
  };

  const setLeftTransform = (x, progress) => {
    prepareDrag(left);
    left.classList.add('mobile-visible');
    right.classList.remove('mobile-visible');
    left.style.transform = `translateX(${x}px)`;
    left.style.opacity = String(progress);
    setBackdrop(progress * 0.98);
  };

  const setRightTransform = (x, progress) => {
    prepareDrag(right);
    right.classList.add('mobile-visible');
    left.classList.remove('mobile-visible');
    right.style.transform = `translateX(${x}px)`;
    right.style.opacity = String(progress);
    setBackdrop(progress * 0.98);
  };

  const finish = (side, open) => {
    if (side === 'left') {
      if (open) {
        left.classList.add('mobile-visible');
      } else {
        left.classList.remove('mobile-visible');
      }
      clearDrag(left);
    } else {
      if (open) {
        right.classList.add('mobile-visible');
      } else {
        right.classList.remove('mobile-visible');
      }
      clearDrag(right);
    }

    clearBackdropStyles();
    confirmBackdrop(!!document.querySelector('.game-sidebar.mobile-visible'));
    active = null;
  };

  const isInteractiveTarget = (t) => {
    if (!t) return false;
    const el = (typeof t.closest === 'function')
      ? t
      : (t.parentElement || null);
    if (!el) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') return true;
    return !!el.closest?.('button, input, textarea, select, a, .operative-chat-form, .clue-form-expanded, .tag-legend-items, .gamelog-tabs, .gamelog-tab-btn, .gamelog-entries');
  };

  const onStart = (e) => {
    if (!isMobileLayout()) return;
    if (!e.touches || e.touches.length !== 1) return;

    // If a finger starts on an input/button, don't hijack.
    if (isInteractiveTarget(e.target)) return;

    const touch = e.touches[0];
    const leftOpen = left.classList.contains('mobile-visible');
    const rightOpen = right.classList.contains('mobile-visible');

    active = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastT: performance.now(),
      dragging: false,
      side: null,
      mode: null, // 'open' | 'close'
      leftOpen,
      rightOpen,
    };
  };

  const onMove = (e) => {
    if (!active || !isMobileLayout()) return;
    if (!e.touches || e.touches.length !== 1) return;

    const t = e.touches[0];
    const dx = t.clientX - active.startX;
    const dy = t.clientY - active.startY;

    // Decide if this is a horizontal swipe.
    if (!active.dragging) {
      if (Math.abs(dx) < 12) return;
      if (Math.abs(dx) < Math.abs(dy) * 1.2) return;

      // Determine side + mode.
      const leftIsOpen = left.classList.contains('mobile-visible');
      const rightIsOpen = right.classList.contains('mobile-visible');

      if (leftIsOpen && dx < 0) {
        active.side = 'left';
        active.mode = 'close';
      } else if (rightIsOpen && dx > 0) {
        active.side = 'right';
        active.mode = 'close';
      } else {
        // Swipe-open only for the left sidebar (history/log).
        // Team chat on the right is opened via its button only.
        if (dx > 0) {
          active.side = 'left';
          active.mode = 'open';
        } else {
          active = null;
          return;
        }
      }

      active.dragging = true;
    }

    // Prevent vertical scroll while dragging a side sheet.
    if (active.dragging) e.preventDefault();

    const width = (active.side === 'left' ? left : right).getBoundingClientRect().width;
    const gutter = 16;

    if (active.side === 'left') {
      const closedX = -(width + gutter);
      let x;
      if (active.mode === 'open') {
        x = clamp(closedX + dx, closedX, 0);
      } else {
        // close: dx will be negative to move toward closed
        x = clamp(dx, closedX, 0);
      }
      const progress = 1 - Math.abs(x) / Math.abs(closedX);
      setLeftTransform(x, clamp(progress, 0, 1));
    } else {
      const closedX = (width + gutter);
      let x;
      if (active.mode === 'open') {
        x = clamp(closedX + dx, 0, closedX);
      } else {
        // close: dx will be positive to move toward closed
        x = clamp(dx, 0, closedX);
      }
      const progress = 1 - Math.abs(x) / Math.abs(closedX);
      setRightTransform(x, clamp(progress, 0, 1));
    }

    active.lastX = t.clientX;
    active.lastT = performance.now();
  };

  const onEnd = () => {
    if (!active) return;

    if (!active.dragging) {
      active = null;
      return;
    }

    const side = active.side;
    const sb = side === 'left' ? left : right;
    const width = sb.getBoundingClientRect().width;
    const gutter = 16;

    // Read current inline transform if present
    const tr = sb.style.transform || '';
    let x = 0;
    const m = tr.match(/translateX\(([-0-9.]+)px\)/);
    if (m) x = parseFloat(m[1]) || 0;

    const closedX = side === 'left' ? -(width + gutter) : (width + gutter);
    const progress = 1 - Math.abs(x) / Math.abs(closedX);

    // Snap threshold
    const shouldOpen = progress > 0.35;
    finish(side, shouldOpen);
  };

  // Attach with {passive:false} so we can preventDefault during drag.
  container.addEventListener('touchstart', onStart, { passive: true });
  container.addEventListener('touchmove', onMove, { passive: false });
  container.addEventListener('touchend', onEnd, { passive: true });
  container.addEventListener('touchcancel', onEnd, { passive: true });

  // Also allow dragging directly on the side sheet to close.
  [left, right].forEach((sb) => {
    sb.addEventListener('touchstart', onStart, { passive: true });
    sb.addEventListener('touchmove', onMove, { passive: false });
    sb.addEventListener('touchend', onEnd, { passive: true });
    sb.addEventListener('touchcancel', onEnd, { passive: true });
  });
}


/* =========================
   Mobile Players Popup
========================= */
function openPlayersPopup() {
  const popup = document.getElementById('players-popup');
  if (!popup) return;
  renderPlayersPopup();
  popup.style.display = 'block';
  // trigger CSS transition
  void popup.offsetWidth;
  popup.classList.add('visible');
}

function closePlayersPopup() {
  const popup = document.getElementById('players-popup');
  if (!popup) return;
  popup.classList.remove('visible');
  setTimeout(() => {
    if (!popup.classList.contains('visible')) popup.style.display = 'none';
  }, 180);
}

function renderPlayersPopup() {
  if (!currentGame) return;
  const redEl = document.getElementById('players-popup-red');
  const blueEl = document.getElementById('players-popup-blue');
  if (!redEl || !blueEl) return;

  const myId = (typeof getUserId === 'function') ? String(getUserId() || '').trim() : '';

  const render = (players, container, team) => {
    const list = Array.isArray(players) ? players : [];
    if (list.length === 0) {
      container.innerHTML = `<div class="players-popup-item empty">—</div>`;
      return;
    }

    container.innerHTML = list.map(p => {
      const pid = String(p?.odId || p?.userId || '').trim();
      const isMe = !!(myId && pid && pid === myId);
      const rawName = String(p?.name || '—');
      const displayName = p?.isAI ? `AI ${rawName}` : rawName;
      const name = escapeHtml(displayName);
      const role = isSpymasterPlayerForTeam(p, team, currentGame) ? 'Spy' : 'Op';
      const attrs = pid
        ? `class="players-popup-item ${team} ${isMe ? 'is-me' : ''} profile-link" data-profile-type="player" data-profile-id="${escapeHtml(pid)}"`
        : `class="players-popup-item ${team} ${isMe ? 'is-me' : ''}"`;
      return `<div ${attrs}><span class="pp-name">${name}</span><span class="pp-role">${role}</span></div>`;
    }).join('');
  };

  render(currentGame.redPlayers, redEl, 'red');
  render(currentGame.bluePlayers, blueEl, 'blue');
}

/* =========================
   Clue Announcement Animation
========================= */
function showClueAnimation(word, number, teamColor) {
  // Remove any existing overlay
  const existing = document.querySelector('.clue-announcement-overlay');
  if (existing) existing.remove();

  const body = document.body;
  const isLight = body.classList.contains('light-mode');
  const isCozy = body.classList.contains('cozy-mode');
  const isOg = body.classList.contains('og-mode');
  // Dark mode is the default (no explicit class).
  const isDark = !isLight && !isCozy && !isOg;

  const isRed = teamColor === 'red';
  const teamClass = isRed ? 'team-red' : 'team-blue';

  const overlay = document.createElement('div');
  overlay.className = `clue-announcement-overlay ${teamClass} ${isLight ? 'clue-variant-light' : isCozy ? 'clue-variant-cozy' : isOg ? 'clue-variant-og' : 'clue-variant-dark'}`;

  const safeWord = escapeHtml(String(word));
  const safeNum = escapeHtml(String(number != null ? number : '0'));

  if (isDark) {
    // Dark mode keeps the dramatic black card + blurred backdrop.
    overlay.innerHTML = `
      <div class="clue-announcement-backdrop"></div>
      <div class="clue-announcement-card ${teamClass}">
        <div class="clue-announcement-glow ${teamClass}"></div>
        <div class="clue-announcement-label">${isRed ? 'Red' : 'Blue'} Spymaster</div>
        <div class="clue-announcement-word">${safeWord}</div>
        <div class="clue-announcement-divider ${teamClass}"></div>
        <div class="clue-announcement-number-row">
          <span class="clue-announcement-for">for</span>
          <span class="clue-announcement-number ${teamClass}">${safeNum}</span>
        </div>
      </div>
    `;
  } else if (isLight) {
    // Light mode: clean typography + drawn underline + badge (no box / no blur).
    overlay.innerHTML = `
      <div class="clue-light-container ${teamClass}">
        <div class="clue-light-label">${isRed ? 'RED' : 'BLUE'} SPYMASTER</div>
        <div class="clue-light-word">${safeWord}</div>
        <div class="clue-light-row">
          <span class="clue-light-for">for</span>
          <span class="clue-light-num">${safeNum}</span>
        </div>
        <div class="clue-light-underline ${teamClass}"></div>
      </div>
    `;
  } else if (isCozy) {
    // Cozy mode: hand-drawn scribble ring + warm bounce (no box / no blur).
    overlay.innerHTML = `
      <div class="clue-cozy-container ${teamClass}">
        <svg class="clue-cozy-scribble" viewBox="0 0 220 220" aria-hidden="true">
          <path class="clue-cozy-path" d="M110,14 C58,14 18,54 18,106 C18,166 58,206 114,206 C170,206 205,168 204,110 C203,52 164,14 110,14 Z" />
          <path class="clue-cozy-path2" d="M110,24 C62,24 28,60 28,106 C28,158 62,196 114,196 C162,196 194,162 194,112 C194,62 158,24 110,24 Z" />
        </svg>
        <div class="clue-cozy-label">${isRed ? 'Red' : 'Blue'} spymaster</div>
        <div class="clue-cozy-word">${safeWord}</div>
        <div class="clue-cozy-pill">
          <span class="clue-cozy-for">for</span>
          <span class="clue-cozy-num">${safeNum}</span>
        </div>
      </div>
    `;
  } else {
    // OG mode: neon scanline + glitch word + rotating emblem (no box / no blur).
    overlay.innerHTML = `
      <div class="clue-announcement-backdrop clue-og-backdrop"></div>
      <div class="clue-og-container ${teamClass}">
        <div class="clue-og-scan" aria-hidden="true"></div>
        <div class="clue-og-label">${isRed ? 'RED' : 'BLUE'} SPYMASTER</div>
        <div class="clue-og-word" data-text="${safeWord}">${safeWord}</div>
        <div class="clue-og-meta">
          <span class="clue-og-for">FOR</span>
          <span class="clue-og-emblem" aria-hidden="true"></span>
          <span class="clue-og-num">${safeNum}</span>
        </div>
      </div>
    `;
  }

  document.body.appendChild(overlay);

  // Dismiss on click
  overlay.addEventListener('click', () => {
    overlay.classList.add('clue-announcement-dismissing');
    setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 650);
  });

  // Auto-dismiss duration matches the style-specific animation length.
  let autoDismissMs = 5500; // dark mode default
  if (isLight) autoDismissMs = 3800;
  else if (isCozy) autoDismissMs = 4800;
  else if (isOg) autoDismissMs = 4400;

  setTimeout(() => {
    if (overlay.parentNode) {
      overlay.classList.add('clue-announcement-dismissing');
      setTimeout(() => { if (overlay.parentNode) overlay.remove(); }, 800);
    }
  }, autoDismissMs);
}


/* =========================
   Card Selection + Confirm (mobile-friendly)
   - Tap card: select/deselect (shows checkmark)
   - Tap checkmark: confirm the guess
========================= */
const _originalHandleCardClick = handleCardClick;

function canCurrentUserGuess() {
  const myTeamColor = getMyTeamColor();
  const isMyTurn = myTeamColor && currentGame?.currentTeam === myTeamColor;
  return !!(
    isMyTurn &&
    currentGame?.currentPhase === 'operatives' &&
    !isCurrentUserSpymaster() &&
    !currentGame?.winner
  );
}

function handleCardSelect(cardIndex) {
  if (_processingGuess) return;
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;

  if (canCurrentUserStackClueTargets()) {
    toggleClueTargetSelection(idx);
    return;
  }

  if (!canCurrentUserGuess()) return;

  // Toggle selection
  if (pendingCardSelection === idx) {
    clearPendingCardSelection();
  } else {
    setPendingCardSelection(idx);
  }
}

async function handleCardConfirm(evt, cardIndex) {
  // Prevent parent click handlers from also firing.
  try { evt?.stopPropagation?.(); } catch (_) {}
  try { evt?.preventDefault?.(); } catch (_) {}

  if (_processingGuess) return;
  if (!canCurrentUserGuess()) return;
  const idx = Number(cardIndex);
  if (!Number.isInteger(idx) || idx < 0) return;
  const now = Date.now();
  if (_lastCardConfirmIndex === idx && (now - _lastCardConfirmAt) < 240) return;
  _lastCardConfirmIndex = idx;
  _lastCardConfirmAt = now;

  // Force selection to this card, then confirm. This avoids no-op states
  // when rapid re-renders temporarily drop the pending-select class.
  if (pendingCardSelection !== idx) {
    setPendingCardSelection(idx);
  }

  const cardEl = document.querySelector(`.game-card[data-index="${idx}"]`);
  const runPhysicalConfirmAnim = !!(cardEl && isOgLikeStyleActive());
  const cardTypeRaw = String(currentGame?.cards?.[idx]?.type || '').toLowerCase();
  const confirmBackType = normalizeConfirmBackType(cardTypeRaw);
  // Drop pending-selection outline immediately when confirm starts.
  clearPendingCardSelection();
  if (runPhysicalConfirmAnim) {
    // Local OG/Cozy confirm already animates this guess, so don't replay it on snapshot.
    _localConfirmAnimUntil = Date.now() + CARD_CONFIRM_ANIM_MS;
    markRevealAnimationSuppressed(idx);
    applyConfirmAnimationClasses(cardEl, confirmBackType);
  } else {
    cardEl?.classList.add('confirming-guess');
  }
  const lockGuard = setTimeout(() => { _processingGuess = false; }, 10000);
  let confirmCommitted = false;

  try {
    if (runPhysicalConfirmAnim) {
      await new Promise((resolve) => setTimeout(resolve, CARD_CONFIRM_ANIM_MS));
    }
    const guessCommitted = await _originalHandleCardClick(idx);
    confirmCommitted = !!guessCommitted;
  } finally {
    clearTimeout(lockGuard);
    _localConfirmAnimUntil = 0;
    if (runPhysicalConfirmAnim && confirmCommitted && cardEl?.isConnected && !cardEl.classList.contains('revealed')) {
      // Keep the card on its back face until the reveal snapshot lands.
      cardEl.classList.remove('confirm-animate');
      cardEl.classList.add('confirm-hold');
      const holdStartedAt = Date.now();
      const maxHoldMs = 5000;
      const releaseHoldWhenReady = () => {
        if (!cardEl.isConnected) return;
        if (cardEl.classList.contains('revealed')) {
          clearConfirmAnimationClasses(cardEl);
          return;
        }
        if ((Date.now() - holdStartedAt) >= maxHoldMs) {
          clearConfirmAnimationClasses(cardEl);
          return;
        }
        // Keep the hold if Firestore has already marked the card revealed but
        // this DOM node has not been re-rendered yet. Releasing here causes a
        // one-frame front-face flash before the snapshot render swaps DOM.
        const liveIsRevealed = !!currentGame?.cards?.[idx]?.revealed;
        if (liveIsRevealed) {
          window.setTimeout(releaseHoldWhenReady, 40);
          return;
        }
        window.setTimeout(releaseHoldWhenReady, 120);
      };
      window.setTimeout(releaseHoldWhenReady, 120);
    } else {
      clearConfirmAnimationClasses(cardEl);
    }
  }
}

// Expose for compatibility (legacy calls / debugging hooks).
window.handleCardSelect = handleCardSelect;
window.handleCardConfirm = handleCardConfirm;


/* =========================
   Clue History Tracking
========================= */
// Helper to add clue to history when given
async function addClueToHistory(gameId, team, word, number) {
  if (!gameId) return;

  if (isLocalPracticeGameId(gameId)) {
    mutateLocalPracticeGame(gameId, (draft) => {
      draft.clueHistory = Array.isArray(draft.clueHistory) ? [...draft.clueHistory] : [];
      draft.clueHistory.push({
        team,
        word,
        number,
        targets: [],
        targetWords: [],
        results: [],
        timestamp: new Date().toISOString()
      });
      draft.updatedAtMs = Date.now();
    });
    return;
  }

  const clueEntry = {
    team,
    word,
    number,
    targets: [],
    targetWords: [],
    results: [],
    timestamp: firebase.firestore.FieldValue.serverTimestamp()
  };

  try {
    await db.collection('games').doc(gameId).update({
      clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry)
    });
  } catch (e) {
    console.error('Failed to add clue to history:', e);
  }
}

// Helper to append a guess result to the latest clue entry
async function addGuessToClueHistory(gameId, team, clueWord, clueNumber, guess) {
  if (!gameId || !team || !clueWord) return;

  if (isLocalPracticeGameId(gameId)) {
    mutateLocalPracticeGame(gameId, (draft) => {
      appendGuessToClueHistoryLocal(draft, team, clueWord, clueNumber, guess);
      draft.updatedAtMs = Date.now();
    });
    return;
  }

  const gameRef = db.collection('games').doc(gameId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(gameRef);
      if (!snap.exists) return;
      const data = snap.data() || {};
      const history = Array.isArray(data.clueHistory) ? [...data.clueHistory] : [];

      // Find the most recent matching clue entry (search from end)
      let idx = -1;
      for (let i = history.length - 1; i >= 0; i--) {
        const c = history[i];
        if (!c) continue;
        if (String(c.team) === String(team) && String(c.word) === String(clueWord) && Number(c.number) === Number(clueNumber)) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return;

      const entry = { ...history[idx] };
      const results = Array.isArray(entry.results) ? [...entry.results] : [];

      // Dedup: skip if this word was already recorded as a guess for this clue
      const guessWord = String(guess.word || '').toUpperCase();
      if (guessWord && results.some(r => String(r.word || '').toUpperCase() === guessWord)) return;

      results.push(guess);
      entry.results = results;
      history[idx] = entry;

      tx.update(gameRef, { clueHistory: history });
    });
  } catch (e) {
    console.error('Failed to append guess to clue history:', e);
  }
}

// Cleanup on game exit
function cleanupAdvancedFeatures() {
  stopGameTimer();
  try { syncTeamConsidering(null); } catch (_) {}
  try { void clearLiveClueDraftOwnership({ silent: true }); } catch (_) {}
  if (_clueDraftSyncTimer) {
    clearTimeout(_clueDraftSyncTimer);
    _clueDraftSyncTimer = null;
  }
  _lastSentClueDraftSig = '';
  _clueChallengeActionBusy = false;

  if (operativeChatUnsub) {
    operativeChatUnsub();
    operativeChatUnsub = null;
  }
  resetOgChatUnreadState();

  cardTags = {};
  pendingCardSelection = null;
  _pendingSelectionContextKey = null;
  _pendingSelectAnimIndex = null;
  revealedPeekCardIndex = null;
  activeTagMode = null;
  setActiveTagMode(null);
  closeMobileSidebars();
}

// Hook into leave game
const originalLeaveQuickGame = window.leaveQuickGame;
if (originalLeaveQuickGame) {
  window.leaveQuickGame = function() {
    cleanupAdvancedFeatures();
    return originalLeaveQuickGame.apply(this, arguments);
  };
}

/* =========================
   AI PLAYER INTEGRATION
   - +AI modal logic
   - Lobby rendering with AI status colors
   - Game loop hooks
========================= */

// ─── +AI: add an Autonomous AI directly (no mode popup) ────────────────────
async function addAIAutonomous(team, seatRole) {
  try {
    const statusEl = document.getElementById('quick-lobby-status');

    const currentCount = typeof countAIsOnTeam === 'function' ? countAIsOnTeam(team) : 0;
    const max = window.AI_CONFIG?.maxAIsPerTeam || 4;
    if (currentCount >= max) {
      if (statusEl) statusEl.textContent = `Maximum ${max} AIs per team reached.`;
      return;
    }

    if (statusEl) statusEl.textContent = 'Adding AI…';
    const ai = await addAIPlayer(team, seatRole, 'autonomous');
    if (!ai) {
      if (statusEl) statusEl.textContent = 'Failed to add AI.';
      return;
    }

    if (statusEl) {
      if (ai.statusColor === 'green') statusEl.textContent = `AI ${ai.name} joined (ready).`;
      else if (ai.statusColor === 'yellow') statusEl.textContent = `AI ${ai.name} joined (partial).`;
      else if (ai.statusColor === 'red') statusEl.textContent = `AI ${ai.name} joined (error).`;
      else statusEl.textContent = `AI ${ai.name} joined.`;
      setTimeout(() => { try { if (statusEl.textContent?.includes('AI')) statusEl.textContent = ''; } catch (_) {} }, 2500);
    }
  } catch (e) {
    console.error('Add AI failed:', e);
    const statusEl = document.getElementById('quick-lobby-status');
    if (statusEl) statusEl.textContent = 'Failed to add AI.';
  }
}

window.addAIAutonomous = addAIAutonomous;

// ─── Enhanced Lobby Rendering with AI Players ────────────────────────────────

// Override renderTeamList to show AI status indicators
const _origRenderQuickLobby = renderQuickLobby;

function renderQuickLobbyWithAI(game) {
  // Call original render first
  _origRenderQuickLobby(game);

  if (!game) return;

  // Re-render player lists to include AI status indicators
  // Refresh AI list from the live game doc so every client can see AIs (even if they didn't add them)
  if (window.syncAIPlayersFromGame) window.syncAIPlayersFromGame(currentGame);

  const aiPlayersList = window.aiPlayers || [];
  if (aiPlayersList.length === 0) return;

  // Enhance each AI player in the DOM with status colors and badges
  const allLists = [
    'quick-red-spymaster-list', 'quick-red-operative-list',
    'quick-blue-spymaster-list', 'quick-blue-operative-list'
  ];

  for (const listId of allLists) {
    const listEl = document.getElementById(listId);
    if (!listEl) continue;

    const playerEls = listEl.querySelectorAll('.quick-player');
    playerEls.forEach(el => {
      const nameEl = el.querySelector('.quick-player-name');
      if (!nameEl) return;

      // Find AI by name match
      const nameText = (nameEl.textContent || '').replace(/\s*\(you\)\s*/, '').trim();
      const ai = aiPlayersList.find(a => a.name === nameText);
      if (!ai) return;

      // Add AI class
      el.classList.add('ai-player');

      // Add status color indicator
      if (ai.statusColor && ai.statusColor !== 'none') {
        el.classList.add(`ai-status-${ai.statusColor}`);
      }

      // Add AI badge (helper mode removed; all AIs are autonomous)
      const existingBadge = el.querySelector('.ai-badge');
      if (!existingBadge) {
        const badge = document.createElement('span');
        badge.className = 'ai-badge ai-badge-autonomous';
        badge.textContent = 'AI';
        badge.title = 'AI Autonomous - plays independently';
        el.appendChild(badge);
      }

      // Add remove button
      const existingRemove = el.querySelector('.ai-remove-btn');
      if (!existingRemove) {
        const removeBtn = document.createElement('button');
        removeBtn.className = 'ai-remove-btn';
        removeBtn.type = 'button';
        removeBtn.title = 'Remove AI';
        removeBtn.textContent = '×';
        removeBtn.onclick = (e) => {
          e.stopPropagation();
          removeAIPlayer(ai.id);
        };
        el.appendChild(removeBtn);
      }

      // Keep the READY/NOT READY badge and tint it by AI health.
      const badgeEl = el.querySelector('.quick-player-badge');
      if (badgeEl) {
        badgeEl.classList.remove('ai-ready-green', 'ai-ready-yellow', 'ai-ready-red', 'ai-ready-none');
        if (ai.statusColor === 'green') {
          badgeEl.classList.add('ai-ready-green');
        } else if (ai.statusColor === 'yellow') {
          badgeEl.classList.add('ai-ready-yellow');
        } else if (ai.statusColor === 'red') {
          badgeEl.classList.add('ai-ready-red');
        } else {
          badgeEl.classList.add('ai-ready-none');
        }
      }

    });
  }
}

// Replace the global renderQuickLobby
renderQuickLobby = renderQuickLobbyWithAI;

// ─── Hook into Game Start ────────────────────────────────────────────────────

// Watch for game phase changes to start/stop AI loop
let lastObservedPhase = null;

const _origRenderGame = renderGame;
renderGame = function renderGameWithAI() {
  _origRenderGame();

  if (!currentGame) return;

  if (isCurrentLocalPracticeGame()) {
    try { window.stopAIGameLoop?.(); } catch (_) {}
    maybeStartLocalPracticeAI();
    lastObservedPhase = currentGame.currentPhase || null;
    return;
  } else {
    stopLocalPracticeAI();
  }

  // Ensure AI list is synced even on spectator/observer clients (prevents a chicken-and-egg where
  // the AI loop never starts because aiPlayers hasn't been populated locally yet).
  try { window.syncAIPlayersFromGame?.(currentGame); } catch (_) {}
  const hasAIsInDoc = !!(
    (Array.isArray(currentGame?.redPlayers) && currentGame.redPlayers.some(p => p && p.isAI)) ||
    (Array.isArray(currentGame?.bluePlayers) && currentGame.bluePlayers.some(p => p && p.isAI))
  );

  const aiPlayersList = window.aiPlayers || [];
  if (aiPlayersList.length === 0 && !hasAIsInDoc) return;

  const phase = currentGame.currentPhase;

  // Game just started (transitioned from waiting/role-selection to active play)
  if (phase !== lastObservedPhase) {
    if ((phase === 'spymaster' || phase === 'operatives') && !lastObservedPhase?.match?.(/^(spymaster|operatives)$/)) {
      // Game started or resumed - kick off AI loop
      startAIGameLoop();
      // Send game start chat from autonomous AIs
      if (lastObservedPhase === 'role-selection' || lastObservedPhase === 'waiting') {
        aiGameStartChat();
      }
    }

    if (phase === 'ended' || currentGame.winner) {
      // Game ended - stop AI loop
      stopAIGameLoop();
    }

    lastObservedPhase = phase;
  }

  // Render AI indicators in topbar player names
  renderAIIndicatorsInTopbar();

  // Render AI indicators in chat messages
  renderAIChatIndicators();
};

function renderAIIndicatorsInTopbar() {
  const aiPlayersList = window.aiPlayers || [];
  if (!aiPlayersList.length) return;

  const topbarBtns = document.querySelectorAll('.topbar-player');
  topbarBtns.forEach(btn => {
    const name = (btn.textContent || '').trim();
    const ai = aiPlayersList.find(a => a.name === name);
    if (ai && !btn.classList.contains('ai-topbar-player')) {
      btn.classList.add('ai-topbar-player');
    }
  });
}

function renderAIChatIndicators() {
  const aiPlayersList = window.aiPlayers || [];
  if (!aiPlayersList.length) return;

  const chatMsgs = document.querySelectorAll('.chat-message');
  chatMsgs.forEach(msg => {
    const senderEl = msg.querySelector('.chat-sender');
    if (!senderEl) return;
    const senderName = (senderEl.textContent || '').trim();
    const ai = aiPlayersList.find(a => a.name === senderName);
    if (ai && !senderEl.classList.contains('ai-chat-sender')) {
      senderEl.classList.add('ai-chat-sender');
    }
  });
}

// ─── Hook into Leave/Cleanup ────────────────────────────────────────────────

const _origCleanupAdvanced = cleanupAdvancedFeatures;
cleanupAdvancedFeatures = function() {
  _origCleanupAdvanced();
  // Cleanup AI
  if (typeof cleanupAllAI === 'function') cleanupAllAI();
  if (typeof removeAllAIs === 'function') removeAllAIs();
  lastObservedPhase = null;
};

// ─── Prevent AI removal by inactivity checker ───────────────────────────────
// AI players are always "active" since they're local.
// Also override getPresenceStatus so AI odIds always report 'online'.
if (typeof window.getPresenceStatus === 'function') {
  const _origGetPresenceStatus = window.getPresenceStatus;
  window.getPresenceStatus = function(p) {
    const odId = p?.odId || p?.id || '';
    const aiList = window.aiPlayers || [];
    if (aiList.some(a => a.odId === odId)) return 'online';
    return _origGetPresenceStatus(p);
  };
}

const _origIsActive = typeof window._aiPatchedIsActive !== 'undefined';
if (!_origIsActive) {
  window._aiPatchedIsActive = true;
  // Override the inactivity checker to always consider AI players active
  const origCheckAndRemove = checkAndRemoveInactiveLobbyPlayers;
  checkAndRemoveInactiveLobbyPlayers = async function(game) {
    // Before running, mark all AI odIds as active in presence
    // This prevents AI players from being removed as "inactive"
    const aiList = window.aiPlayers || [];
    if (aiList.length === 0) return origCheckAndRemove(game);

    // Ensure presenceCache exists and inject AI players as "active"
    if (!window.presenceCache) window.presenceCache = [];
    const presenceData = window.presenceCache;
    const aiPresenceEntries = [];
    for (const ai of aiList) {
      if (!presenceData.some(p => (p.odId || p.id) === ai.odId)) {
        const entry = { odId: ai.odId, name: ai.name, lastSeen: { toMillis: () => Date.now() } };
        presenceData.push(entry);
        aiPresenceEntries.push(entry);
      }
    }

    await origCheckAndRemove(game);

    // Clean up injected entries
    for (const entry of aiPresenceEntries) {
      const idx = presenceData.indexOf(entry);
      if (idx !== -1) presenceData.splice(idx, 1);
    }
  };
}
