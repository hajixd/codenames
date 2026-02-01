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
// Expose current game phase for presence (app.js)
window.getCurrentGamePhase = () => (currentGame && currentGame.currentPhase) ? currentGame.currentPhase : null;

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
let quickLobbyUnsub = null;
let quickLobbyGame = null;
let quickAutoJoinedSpectator = false;

// Quick Play settings / negotiation
function readQuickSettingsFromUI() {
  const blackCards = parseInt(document.getElementById('qp-black-cards')?.value || '1', 10);
  const clueTimerSeconds = parseInt(document.getElementById('qp-clue-timer')?.value || '0', 10);
  const guessTimerSeconds = parseInt(document.getElementById('qp-guess-timer')?.value || '0', 10);
  const deckId = String(document.getElementById('qp-deck')?.value || 'standard');
  return {
    blackCards: Number.isFinite(blackCards) ? blackCards : 1,
    clueTimerSeconds: Number.isFinite(clueTimerSeconds) ? clueTimerSeconds : 0,
    guessTimerSeconds: Number.isFinite(guessTimerSeconds) ? guessTimerSeconds : 0,
    deckId: normalizeDeckId(deckId),
  };
}

function getQuickSettings(game) {
  const base = game?.quickSettings || null;
  if (base && typeof base === 'object') {
    return {
      blackCards: Number.isFinite(+base.blackCards) ? +base.blackCards : 1,
      clueTimerSeconds: Number.isFinite(+base.clueTimerSeconds) ? +base.clueTimerSeconds : 0,
      guessTimerSeconds: Number.isFinite(+base.guessTimerSeconds) ? +base.guessTimerSeconds : 0,
      deckId: normalizeDeckId(base.deckId || 'standard'),
    };
  }
  return {
    blackCards: 1,
    clueTimerSeconds: 0,
    guessTimerSeconds: 0,
    deckId: 'standard',
  };
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
  const s = settings || { blackCards: 1, clueTimerSeconds: 0, guessTimerSeconds: 0, deckId: 'standard' };
  const d = getDeckMeta(s.deckId || 'standard');
  return `Deck: ${d.label} · Assassin: ${s.blackCards} · Clue: ${formatSeconds(s.clueTimerSeconds)} · Guess: ${formatSeconds(s.guessTimerSeconds)}`;
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

  // End turn button
  document.getElementById('end-turn-btn')?.addEventListener('click', handleEndTurn);

  // Leave game
  document.getElementById('leave-game-btn')?.addEventListener('click', handleLeaveGame);

  // End game (manual)
  document.getElementById('end-game-btn')?.addEventListener('click', handleEndGame);

  // Popover toggles
  setupGamePopovers();

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

  if (blackCardsEl) blackCardsEl.value = String(s.blackCards ?? 1);
  if (clueTimerEl) clueTimerEl.value = String(s.clueTimerSeconds ?? 0);
  if (guessTimerEl) guessTimerEl.value = String(s.guessTimerSeconds ?? 0);
  setQuickDeckSelectionUI(s.deckId || 'standard');

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
    applyBtn.textContent = !myTeam ? 'Join a team to apply' : 'Apply';
  }
  if (modalStatus) {
    modalStatus.textContent = !myTeam
      ? 'Join Red or Blue to change Quick Play settings.'
      : 'Changes apply immediately (no agreement step).';
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
      if (role !== 'red' && role !== 'blue') throw new Error('Join Red or Blue to change settings.');

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
  if (quickLobbyUnsub) quickLobbyUnsub();
  quickLobbyUnsub = null;
  quickLobbyGame = null;
  renderQuickLobby(null);
}

async function startQuickLobbyListener() {
  if (quickLobbyUnsub) return;
  await ensureQuickPlayGameExists();
  quickLobbyUnsub = db.collection('games').doc(QUICKPLAY_DOC_ID).onSnapshot((snap) => {
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

    // If a Quick Play game is in-progress, jump into it if you're a participant.
    if (quickLobbyGame.currentPhase && quickLobbyGame.currentPhase !== 'waiting' && quickLobbyGame.winner == null) {
      const odId = getUserId();
      const inRed = (quickLobbyGame.redPlayers || []).some(p => p.odId === odId);
      const inBlue = (quickLobbyGame.bluePlayers || []).some(p => p.odId === odId);
      if (inRed || inBlue) {
        spectatorMode = false;
        spectatingGameId = null;
        startGameListener(quickLobbyGame.id, { spectator: false });
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
}

// Game inactivity timeout: end games that have been inactive for 30+ minutes
const GAME_INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
let lastInactiveGameCheck = 0;

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

      // Reset the game (end due to inactivity)
      const uiSettings = readQuickSettingsFromUI();
      const newGameData = buildQuickPlayGameData(uiSettings);
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
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();

      const total = (g.redPlayers?.length || 0) + (g.bluePlayers?.length || 0) + (g.spectators?.length || 0);
      if (total !== 0) return;
      if (!g.currentPhase || g.currentPhase === 'waiting') return;

      const uiSettings = readQuickSettingsFromUI();
      const newGameData = buildQuickPlayGameData(uiSettings);
      tx.set(ref, {
        ...newGameData,
        log: ['Previous game ended because all players left.']
      });
    });
  } catch (e) {
    console.warn('Failed to end empty Quick Play game:', e);
  }
}

function buildQuickPlayGameData(settings = { blackCards: 1, clueTimerSeconds: 0, guessTimerSeconds: 0 }) {
  const firstTeam = 'red';
  const words = getRandomWords(BOARD_SIZE, settings.deckId);
  const keyCard = generateKeyCard(firstTeam, settings.blackCards);

  const cards = words.map((word, i) => ({
    word,
    type: keyCard[i],
    revealed: false,
    // Shared, non-revealing team marks (used by operatives to coordinate).
    // Stored per card so they sync across all clients.
    marks: { red: false, blue: false },
  }));

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
    currentTeam: firstTeam,
    currentPhase: 'waiting',
    redSpymaster: null,
    blueSpymaster: null,
    redCardsLeft: FIRST_TEAM_CARDS,
    blueCardsLeft: SECOND_TEAM_CARDS,
    currentClue: null,
    guessesRemaining: 0,
    quickSettings: {
      blackCards: settings.blackCards,
      clueTimerSeconds: settings.clueTimerSeconds,
      guessTimerSeconds: settings.guessTimerSeconds,
      deckId: normalizeDeckId(settings.deckId || 'standard'),
    },
    log: [],
    winner: null,
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };
}

async function ensureQuickPlayGameExists() {
  const uiSettings = readQuickSettingsFromUI();
  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  const snap = await ref.get();

  if (!snap.exists) {
    await ref.set(buildQuickPlayGameData(uiSettings));
    return;
  }

  const g = snap.data();
  const shouldReset = !!g.winner || g.currentPhase === 'ended' || !Array.isArray(g.cards) || g.cards.length !== BOARD_SIZE;
  if (shouldReset) {
    await ref.set(buildQuickPlayGameData(uiSettings));
    return;
  }

  // Backfill settings fields if this doc predates the settings system.
  const updates = {};
  if (!g.quickSettings) {
    updates.quickSettings = {
      blackCards: 1,
      clueTimerSeconds: 0,
      guessTimerSeconds: 0,
      deckId: 'standard',
    };
  }
  // Remove legacy negotiation fields if present.
  if (typeof g.settingsAccepted !== 'undefined') updates.settingsAccepted = firebase.firestore.FieldValue.delete();
  if (typeof g.settingsPending !== 'undefined') updates.settingsPending = firebase.firestore.FieldValue.delete();
  if (typeof g.activeJoinOn === 'undefined') updates.activeJoinOn = true;
  if (Object.keys(updates).length) {
    await ref.update({ ...updates, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
  }
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

      // If a game is already in progress, do not allow new joins unless Active Join is enabled.
      if (game.currentPhase && game.currentPhase !== 'waiting' && game.winner == null && !activeJoinOn) {
        throw new Error('Quick Play is in progress. Please wait for the next game.');
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
      if (team !== 'red' && team !== 'blue') throw new Error('Join Red or Blue first.');
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

function bothTeamsFullyReady(game) {
  const red = Array.isArray(game.redPlayers) ? game.redPlayers : [];
  const blue = Array.isArray(game.bluePlayers) ? game.bluePlayers : [];
  if (red.length === 0 || blue.length === 0) return false;
  // Require each team to have at least 1 spymaster and 1 operative (AIs count)
  const hasRoles = (players) => {
    let hasSpy = false;
    let hasOp = false;
    for (const p of players) {
      const r = String(p?.role || 'operative');
      if (r === 'spymaster') hasSpy = true;
      else hasOp = true;
    }
    return hasSpy && hasOp;
  };
  if (!hasRoles(red) || !hasRoles(blue)) return false;
  return red.every(p => p.ready) && blue.every(p => p.ready);
}

async function maybeAutoStartQuickPlay(game) {
  if (!game || game.currentPhase !== 'waiting' || game.winner != null) return;
  if (!bothTeamsFullyReady(game)) return;

  const ref = db.collection('games').doc(QUICKPLAY_DOC_ID);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const g = snap.data();
      if (g.currentPhase !== 'waiting' || g.winner != null) return;
      if (!bothTeamsFullyReady(g)) return;

      const s = getQuickSettings(g);
      const firstTeam = 'red';
      // Use the Quick Play deck settings (s), not an undefined variable.
      const words = getRandomWords(BOARD_SIZE, s.deckId);
      const keyCard = generateKeyCard(firstTeam, s.blackCards);
      const cards = words.map((word, i) => ({
        word,
        type: keyCard[i],
        revealed: false
      }));

      // If players pre-selected Spymaster in the lobby, pre-assign them.
      const redPlayers = Array.isArray(g.redPlayers) ? g.redPlayers : [];
      const bluePlayers = Array.isArray(g.bluePlayers) ? g.bluePlayers : [];
      const redSpy = redPlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const blueSpy = bluePlayers.find(p => String(p?.role || 'operative') === 'spymaster')?.name || null;
      const startPhase = (redSpy && blueSpy) ? 'spymaster' : 'role-selection';

      tx.update(ref, {
        cards,
        currentTeam: firstTeam,
        currentPhase: startPhase,
        redSpymaster: redSpy,
        blueSpymaster: blueSpy,
        redCardsLeft: FIRST_TEAM_CARDS,
        blueCardsLeft: SECOND_TEAM_CARDS,
        currentClue: null,
        guessesRemaining: 0,
        winner: null,
        log: firebase.firestore.FieldValue.arrayUnion('All players ready. Starting game…'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    // Play game start sound
    if (window.playSound) window.playSound('gameStart');
  } catch (e) {
    console.error('Auto-start Quick Play failed:', e);
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
      return `
        <div class="quick-player ${ready ? 'ready' : ''}">
          <span class="quick-player-name ${playerId ? 'profile-link' : ''}" ${playerId ? `data-profile-type="player" data-profile-id="${escapeHtml(playerId)}"` : ''}>${escapeHtml(displayPlayerName(p))}${isYou ? ' <span class="quick-you">(you)</span>' : ''}</span>
          <span class="quick-player-badge">${ready ? 'READY' : 'NOT READY'}</span>
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

  // Update team status indicators
  const redStatus = document.getElementById('quick-red-status');
  const blueStatus = document.getElementById('quick-blue-status');

  const renderTeamStatus = (team, players) => {
    const chips = [];
    const allReady = teamIsFullyReady(game, team);

    // Ready status (more prominent when all ready)
    if (players.length > 0) {
      if (allReady) {
        chips.push('<span class="quick-status-chip all-ready">All Ready</span>');
      }
    }

    return chips.join('');
  };

  if (redStatus) redStatus.innerHTML = renderTeamStatus('red', red);
  if (blueStatus) blueStatus.innerHTML = renderTeamStatus('blue', blue);

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
  } else {
    const rolesOk =
      (redSplit.spymasters.length > 0 && redSplit.operatives.length > 0) &&
      (blueSplit.spymasters.length > 0 && blueSplit.operatives.length > 0);

    if (bothTeamsFullyReady(game)) {
      status.textContent = 'Everyone is ready — starting…';
    } else if ((red.length > 0 && blue.length > 0) && !rolesOk) {
      status.textContent = 'To start, each team needs 1 Spymaster and 1 Operative.';
    } else {
      status.textContent = '';
    }
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
  return raw;
}

function truncateTeamNameGame(name, maxLen = 20) {
  const str = String(name || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
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
      .filter(g => g.currentPhase && g.currentPhase !== 'waiting')
      .slice(0, 10);

    if (activeGames.length === 0) {
      section.style.display = 'none';
      return;
    }

    section.style.display = 'block';

    const activeHtml = activeGames.map(g => {
      const redName = escapeHtml(truncateTeamNameGame(g.redTeamName || 'Red Team'));
      const blueName = escapeHtml(truncateTeamNameGame(g.blueTeamName || 'Blue Team'));
      const status = escapeHtml(describeGameStatus(g));

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
            <span class="challenge-meta">${status}</span>
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
    await renderActiveGamesList(null, null);
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
        teamsText.textContent = `${truncateTeamNameGame(activeGame.redTeamName)} vs ${truncateTeamNameGame(activeGame.blueTeamName)}`;
      }
    }
    if (challengesSec) challengesSec.style.display = 'none';
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
    if (pendingSec) pendingSec.style.display = 'none';

    // Still show active games list (for spectating other matches)
    await renderActiveGamesList(myTeam, activeGame.id);
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
  await renderActiveGamesList(myTeam, null);
}

async function renderActiveGamesList(myTeam, myActiveGameId) {
  const activeGamesSec = document.getElementById('active-games-section');
  const list = document.getElementById('active-games-list');
  if (!activeGamesSec || !list) return;

  const games = await getActiveGames(25);
  if (!games.length) {
    activeGamesSec.style.display = 'none';
    return;
  }

  activeGamesSec.style.display = 'block';

  list.innerHTML = games.map(g => {
    const redName = escapeHtml(truncateTeamNameGame(g.redTeamName || 'Red Team'));
    const blueName = escapeHtml(truncateTeamNameGame(g.blueTeamName || 'Blue Team'));
    const status = escapeHtml(describeGameStatus(g));

    const isMyGame = !!(myTeam && (g.redTeamId === myTeam.id || g.blueTeamId === myTeam.id));
    const primaryLabel = isMyGame ? (myActiveGameId === g.id ? 'Rejoin' : 'Join') : 'Spectate';
    const primaryAction = isMyGame ? `joinGame('${g.id}')` : `spectateGame('${g.id}')`;

    return `
      <div class="challenge-row">
        <div class="challenge-info">
          <span class="challenge-team-name">${redName} vs ${blueName}</span>
          <span class="challenge-meta">${status}</span>
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
  if (game.type === 'quick') return false;
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
    games = games.filter(g => g.currentPhase && g.currentPhase !== 'waiting');

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
    revealed: false,
    marks: { red: false, blue: false },
  }));

  const gameData = {
    type: 'tournament',
    redTeamId,
    redTeamName,
    blueTeamId,
    blueTeamName,
    cards,
    currentTeam: firstTeam,
    currentPhase: 'role-selection', // role-selection, spymaster, operatives, ended
    redSpymaster: null,
    blueSpymaster: null,
    redCardsLeft: FIRST_TEAM_CARDS,
    blueCardsLeft: SECOND_TEAM_CARDS,
    currentClue: null,
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

  spectatorMode = !!options.spectator;
  spectatingGameId = spectatorMode ? gameId : null;

  // Persist last active game (device-local) for refresh resume.
  try {
    if (typeof safeLSSet === 'function') {
      safeLSSet(LS_ACTIVE_GAME_ID, String(gameId || ''));
      safeLSSet(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
    } else {
      localStorage.setItem(LS_ACTIVE_GAME_ID, String(gameId || ''));
      localStorage.setItem(LS_ACTIVE_GAME_SPECTATOR, spectatorMode ? '1' : '0');
    }
  } catch (_) {}

  gameUnsub = db.collection('games').doc(gameId).onSnapshot((snap) => {
    if (!snap.exists) {
      currentGame = null;
      showGameLobby();
      try { window.bumpPresence?.(); } catch (_) {}
      return;
    }

    currentGame = { id: snap.id, ...snap.data() };
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

    renderGame();
  }, (err) => {
    console.error('Game listener error:', err);
  });
}

// Allows app.js to show a live Quick Play game behind the 3-button chooser.
// - spectator=true: view-only background (default)
// - spectator=false: interactive rejoin (only if you're already a participant)
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
  if (gameUnsub) gameUnsub();
  gameUnsub = null;
  currentGame = null;
  spectatorMode = false;
  spectatingGameId = null;

  // Hide in-game controls in settings once we are out of a game.
  updateSettingsInGameActions(false);

  // Ensure mobile layout returns to normal (showing tabs, etc.)
  document.body.classList.remove('in-game');

  // Clear resume info when the user intentionally leaves the game.
  try {
    localStorage.removeItem(LS_ACTIVE_GAME_ID);
    localStorage.removeItem(LS_ACTIVE_GAME_SPECTATOR);
  } catch (_) {}
}

/* =========================
   Game Rendering
========================= */
function showGameLobby() {
  updateSettingsInGameActions(false);
  document.body.classList.remove('in-game');
  // Go back to mode selection
  showModeSelect();
}

function showGameBoard() {
  document.getElementById('play-mode-select').style.display = 'none';
  document.getElementById('quick-play-lobby').style.display = 'none';
  document.getElementById('tournament-lobby').style.display = 'none';
  document.getElementById('game-board-container').style.display = 'flex';
  document.getElementById('panel-game').classList.add('game-active');
  document.body.classList.add('in-game');
}

// Settings modal: show/hide in-game actions when a user is inside a game.
function updateSettingsInGameActions(isInGame) {
  const section = document.getElementById('settings-in-game-actions');
  if (!section) return;

  section.style.display = isInGame ? 'block' : 'none';

  const leaveBtn = document.getElementById('leave-game-btn');
  const endBtn = document.getElementById('end-game-btn');

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
    leaveBtn.disabled = !isInGame;
  }

  if (endBtn) {
    endBtn.disabled = !canEnd;
    endBtn.title = canEnd ? '' : (spectator ? 'Spectators cannot end tournament games' : 'Only spymasters can end tournament games');
  }
}

function renderGame() {
  if (!currentGame) {
    showGameLobby();
    return;
  }

  showGameBoard();

  // Settings: show in-game actions whenever a user is actively in a game.
  updateSettingsInGameActions(true);

  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isSpymaster = !spectator && isCurrentUserSpymaster();

  // Leave button label
  const leaveBtn = document.getElementById('leave-game-btn');
  if (leaveBtn) leaveBtn.textContent = spectator ? 'Stop Spectating' : 'Leave Game';

  const endBtn = document.getElementById('end-game-btn');
  if (endBtn) {
    // Keep the action visible in settings.
    // Tournament: spymaster only. Quick Play: anyone can end.
    const isQuick = currentGame.type === 'quick';
    endBtn.disabled = isQuick ? false : (!!spectator || !isSpymaster);
    endBtn.title = endBtn.disabled
      ? 'Only your team\'s spymaster can end tournament games'
      : 'End the game for everyone';
  }

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

  document.getElementById('game-red-left').textContent = currentGame.redCardsLeft;
  document.getElementById('game-blue-left').textContent = currentGame.blueCardsLeft;
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
    const mySpymaster = myTeamColor === 'red' ? currentGame.redSpymaster : currentGame.blueSpymaster;
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
  }

  // Render advanced features
  renderAdvancedFeatures();
}

// Advanced features rendering hook
function renderAdvancedFeatures() {
  if (!currentGame) return;

  // Clear pending selection if you can't currently guess
  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);
  const canGuessNow = isMyTurn && currentGame.currentPhase === 'operatives' && !isCurrentUserSpymaster() && !currentGame.winner;
  if (!canGuessNow) {
    pendingCardSelection = null;
  }

  // Load tags from localStorage for this game
  loadTagsFromLocal();

  // Render advanced UI
  renderCardTags();
  renderClueHistory();
  renderTeamRoster();
  updateChatPrivacyBadge();

  // Show/hide tag legend based on role
  const tagLegend = document.getElementById('card-tag-legend');
  if (tagLegend) {
    const isSpymaster = isCurrentUserSpymaster();
    const isSpectator = isSpectating();
    tagLegend.style.display = (!isSpymaster && !isSpectator && !currentGame?.winner) ? 'flex' : 'none';
  }

  // Initialize operative chat
  initOperativeChat();

  // Handle timer if present
  if (currentGame?.timerEnd) {
    startGameTimer(currentGame.timerEnd, currentGame.currentPhase);
  } else {
    stopGameTimer();
  }
}

function renderBoard(isSpymaster) {
  const boardEl = document.getElementById('game-board');
  if (!boardEl || !currentGame?.cards) return;

  const myTeamColor = getMyTeamColor();
  const spectator = isSpectating();
  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);
  const canGuess = isMyTurn && currentGame.currentPhase === 'operatives' && !isSpymaster && !currentGame.winner;

  boardEl.innerHTML = currentGame.cards.map((card, i) => {
    const classes = ['game-card'];

    if (card.revealed) {
      classes.push('revealed');
      classes.push(`card-${card.type}`);
    } else if (isSpymaster && !spectator) {
      classes.push('spymaster-view');
      classes.push(`card-${card.type}`);
      classes.push('disabled');
    } else if (!canGuess) {
      classes.push('disabled');
    }

    // Pending selection highlight
    if (!card.revealed && pendingCardSelection === i) {
      classes.push('pending-select');
    }

    // Allow clicking for guessing or tagging (if not revealed)
    const canClick = !card.revealed && !isSpymaster;
    const clickHandler = canClick ? `onclick="handleCardClick(${i})"` : '';

    const marks = card.marks || { red: false, blue: false };
    const showMark = !!(myTeamColor && !spectator && marks[myTeamColor] && !card.revealed);

    return `
      <div class="${classes.join(' ')}" ${clickHandler} data-index="${i}">
        <div class="card-checkmark" aria-hidden="true">✓</div>
        ${showMark ? '<div class="card-mark" aria-label="Marked">✓</div>' : ''}
        <span class="card-word">${escapeHtml(card.word)}</span>
      </div>
    `;
  }).join('');

  // Re-render tags and votes after board re-renders
  setTimeout(() => {
    renderCardTags();
    attachCardMarkHandlers();
  }, 10);
}

// Right-click (or trackpad two-finger click) to toggle a shared team mark on an unrevealed card.
function attachCardMarkHandlers() {
  const boardEl = document.getElementById('game-board');
  if (!boardEl) return;

  const spectator = isSpectating();
  const myTeamColor = getMyTeamColor();
  if (spectator || !myTeamColor) return;

  boardEl.querySelectorAll('.game-card').forEach((el) => {
    el.oncontextmenu = async (e) => {
      try { e.preventDefault(); } catch (_) {}
      if (!currentGame || currentGame.winner) return;
      const idx = Number(el.dataset.index);
      if (!Number.isInteger(idx)) return;
      const card = currentGame.cards?.[idx];
      if (!card || card.revealed) return;
      await toggleTeamMark(idx);
    };
  });
}

async function toggleTeamMark(cardIndex) {
  if (!currentGame?.id) return;
  if (isSpectating()) return;
  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return;

  const card = currentGame.cards?.[cardIndex];
  if (!card || card.revealed) return;

  const updatedCards = [...currentGame.cards];
  const marks = { ...(card.marks || { red: false, blue: false }) };
  const next = !marks[myTeamColor];
  marks[myTeamColor] = next;
  updatedCards[cardIndex] = { ...card, marks };

  const actor = getUserName() || 'Someone';
  const action = next ? 'marked' : 'unmarked';
  const logEntry = `${actor} ${action} "${card.word}".`;

  try {
    await db.collection('games').doc(currentGame.id).update({
      cards: updatedCards,
      log: firebase.firestore.FieldValue.arrayUnion(logEntry),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('Failed to toggle mark:', e);
  }
}

function renderClueArea(isSpymaster, myTeamColor, spectator) {
  const currentClueEl = document.getElementById('current-clue');
  const clueFormEl = document.getElementById('clue-form');
  const operativeActionsEl = document.getElementById('operative-actions');
  const waitingEl = document.getElementById('waiting-message');

  // Hide all first
  currentClueEl.style.display = 'none';
  clueFormEl.style.display = 'none';
  operativeActionsEl.style.display = 'none';
  waitingEl.style.display = 'none';

  if (currentGame.winner) return;

  const isMyTurn = !spectator && myTeamColor && (currentGame.currentTeam === myTeamColor);

  // Quick Play waiting phase
  if (currentGame.currentPhase === 'waiting') {
    const redCount = (currentGame.redPlayers || []).length;
    const blueCount = (currentGame.bluePlayers || []).length;
    const hasPlayers = redCount > 0 && blueCount > 0;

    waitingEl.style.display = 'block';
    const waitingFor = document.getElementById('waiting-for');

    if (!myTeamColor) {
      waitingFor.textContent = 'players to join.';
    } else if (!hasPlayers) {
      waitingFor.textContent = 'at least 1 player on each team.';
    } else {
      // Show start button
      waitingFor.innerHTML = `
        <span>Ready to start!</span>
        <button class="btn primary small" style="margin-left: 12px;" onclick="startQuickGame('${currentGame.id}')">Start Game</button>
      `;
    }
    return;
  }

  if (currentGame.currentPhase === 'role-selection') {
    waitingEl.style.display = 'block';
    document.getElementById('waiting-for').textContent = 'all teams to select roles';
    return;
  }

  if (currentGame.currentPhase === 'spymaster') {
    if (!spectator && isMyTurn && isSpymaster) {
      // Show clue input
      clueFormEl.style.display = 'flex';
    } else {
      // Show waiting message
      waitingEl.style.display = 'block';
      const waitingTeam = truncateTeamNameGame(currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName);
      document.getElementById('waiting-for').textContent = `${waitingTeam}'s Spymaster`;
    }
    return;
  }

  if (currentGame.currentPhase === 'operatives') {
    // Show current clue
    if (currentGame.currentClue) {
      currentClueEl.style.display = 'flex';
      document.getElementById('clue-word').textContent = currentGame.currentClue.word;
      document.getElementById('clue-number').textContent = currentGame.currentClue.number;
      const gr = Number(currentGame.guessesRemaining);
      document.getElementById('guesses-left').textContent = (gr === -1)
        ? '(∞ guesses)'
        : `(${gr} guesses left)`;
    }

    if (!spectator && isMyTurn && !isSpymaster) {
      // Show end turn button
      operativeActionsEl.style.display = 'flex';
    } else if (!isMyTurn) {
      waitingEl.style.display = 'block';
      const waitingTeam = truncateTeamNameGame(currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName);
      document.getElementById('waiting-for').textContent = `${waitingTeam}'s Operatives`;
    }
  }
}

function renderGameLog() {
  const popoverEl = document.getElementById('game-log-entries');
  const sidebarEl = document.getElementById('game-log-entries-sidebar');
  if ((!popoverEl && !sidebarEl) || !currentGame?.log) return;

  const html = currentGame.log.map(entry => {
    return `<div class="log-entry">${entry}</div>`;
  }).join('');

  if (popoverEl) popoverEl.innerHTML = html;
  if (sidebarEl) sidebarEl.innerHTML = html;

  // Auto-scroll to bottom (popover container + sidebar scroller)
  const popover = document.getElementById('game-log');
  if (popover) popover.scrollTop = popover.scrollHeight;
  if (sidebarEl) sidebarEl.scrollTop = sidebarEl.scrollHeight;
}

function updateRoleButtons() {
  const spymasterBtn = document.getElementById('role-spymaster');
  const operativeBtn = document.getElementById('role-operative');
  const statusEl = document.getElementById('role-status');

  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return;

  const mySpymaster = myTeamColor === 'red' ? currentGame.redSpymaster : currentGame.blueSpymaster;

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

  // NEW: require at least one operative (someone besides the spymaster) on each team.
  const redRoster = Array.isArray(currentGame.redPlayers) ? currentGame.redPlayers : [];
  const blueRoster = Array.isArray(currentGame.bluePlayers) ? currentGame.bluePlayers : [];
  const hasOperative = (roster, spyName) => {
    const s = String(spyName || '').trim();
    if (!s) return false;
    return roster.some(p => String(p?.name || '').trim() && String(p?.name || '').trim() !== s);
  };

  if (willHaveRedSpymaster && willHaveBlueSpymaster &&
      hasOperative(redRoster, willHaveRedSpymaster) &&
      hasOperative(blueRoster, willHaveBlueSpymaster)) {
    updates.currentPhase = 'spymaster';
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

  const wordInput = document.getElementById('clue-input');
  const numInput = document.getElementById('clue-num-input');

  const word = (wordInput.value || '').trim().toUpperCase();
  const number = parseInt(numInput.value, 10);

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

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
  const actor = getUserName() || 'Someone';

  try {
    // Add clue to history
    const clueEntry = {
      team: currentGame.currentTeam,
      word: word,
      number: number,
      results: [],
      timestamp: new Date().toISOString()
    };

    await db.collection('games').doc(currentGame.id).update({
      currentClue: { word, number },
      // Unlimited guesses (operatives can keep guessing until they end turn or miss)
      guessesRemaining: -1,
      currentPhase: 'operatives',
      log: firebase.firestore.FieldValue.arrayUnion(`${actor} (Spymaster) gave clue "${word}" ×${number}`),
      clueHistory: firebase.firestore.FieldValue.arrayUnion(clueEntry),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    wordInput.value = '';
    numInput.value = '';

    // Play clue given sound
    if (window.playSound) window.playSound('clueGiven');
  } catch (e) {
    console.error('Failed to give clue:', e);
  }
}

/* =========================
   Card Guessing
========================= */
async function handleCardClick(cardIndex) {
  // Clear any pending selection as soon as a guess is being processed
  pendingCardSelection = null;
  if (!currentGame || currentGame.currentPhase !== 'operatives') return;
  if (isSpectating()) return;
  if (currentGame.winner) return;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return;
  if (isCurrentUserSpymaster()) return;

  const card = currentGame.cards[cardIndex];
  if (!card || card.revealed) return;

  // Capture current clue for history logging
  const clueWordAtGuess = currentGame.currentClue?.word || null;
  const clueNumberAtGuess = (currentGame.currentClue && typeof currentGame.currentClue.number !== 'undefined') ? currentGame.currentClue.number : null;
  const guessByName = getUserName() || 'Someone';

  // Reveal the card
  const updatedCards = [...currentGame.cards];
  updatedCards[cardIndex] = { ...card, revealed: true };

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
  const updates = {
    cards: updatedCards,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  let logEntry = `${guessByName} guessed "${card.word}" - `;
  let endTurn = false;
  let winner = null;

  // Play card reveal sound
  if (window.playSound) window.playSound('cardReveal');

  // Determine result
  if (card.type === 'assassin') {
    // Game over - other team wins
    winner = currentGame.currentTeam === 'red' ? 'blue' : 'red';
    logEntry += 'ASSASSIN! Game over.';
    // Play assassin sound after a brief delay
    setTimeout(() => { if (window.playSound) window.playSound('cardAssassin'); }, 200);
  } else if (card.type === currentGame.currentTeam) {
    // Correct guess
    logEntry += 'Correct!';
    // Play correct sound
    setTimeout(() => { if (window.playSound) window.playSound('cardCorrect'); }, 200);

    // Update cards left
    if (currentGame.currentTeam === 'red') {
      updates.redCardsLeft = currentGame.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = currentGame.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }

    // Decrease guesses remaining (unless unlimited)
    if (Number(currentGame.guessesRemaining) !== -1) {
      updates.guessesRemaining = currentGame.guessesRemaining - 1;
      if (updates.guessesRemaining <= 0 && !winner) {
        endTurn = true;
      }
    }
  } else if (card.type === 'neutral') {
    // Neutral - end turn
    logEntry += 'Neutral. Turn ends.';
    endTurn = true;
    // Play wrong/neutral sound
    setTimeout(() => { if (window.playSound) window.playSound('cardWrong'); }, 200);
  } else {
    // Other team's card - end turn and give them a point
    logEntry += `Wrong! (${card.type === 'red' ? currentGame.redTeamName : currentGame.blueTeamName}'s card)`;
    // Play wrong sound
    setTimeout(() => { if (window.playSound) window.playSound('cardWrong'); }, 200);

    if (card.type === 'red') {
      updates.redCardsLeft = currentGame.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = currentGame.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }

    endTurn = true;
  }

  const guessResult = {
    word: card.word,
    result: (card.type === 'assassin') ? 'assassin' : (card.type === currentGame.currentTeam ? 'correct' : (card.type === 'neutral' ? 'neutral' : 'wrong')),
    type: card.type,
    by: guessByName,
    timestamp: new Date().toISOString()
  };

  updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);

  if (winner) {
    updates.winner = winner;
    updates.currentPhase = 'ended';
    const winnerName = truncateTeamNameGame(winner === 'red' ? currentGame.redTeamName : currentGame.blueTeamName);
    updates.log = firebase.firestore.FieldValue.arrayUnion(`${winnerName} wins!`);
  } else if (endTurn) {
    // Switch teams
    updates.currentTeam = currentGame.currentTeam === 'red' ? 'blue' : 'red';
    updates.currentPhase = 'spymaster';
    updates.currentClue = null;
    updates.guessesRemaining = 0;
  }

  try {
    await db.collection('games').doc(currentGame.id).update(updates);

    // Append to clue history (guess order + outcome)
    if (clueWordAtGuess && clueNumberAtGuess !== null && clueNumberAtGuess !== undefined) {
      await addGuessToClueHistory(currentGame.id, currentGame.currentTeam, clueWordAtGuess, clueNumberAtGuess, guessResult);
    }
  } catch (e) {
    console.error('Failed to reveal card:', e);
  }
}

async function handleEndTurn() {
  if (!currentGame || currentGame.currentPhase !== 'operatives') return;
  if (isSpectating()) return;
  if (currentGame.winner) return;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return;

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
  const actor = getUserName() || 'Someone';

  // Play end turn sound
  if (window.playSound) window.playSound('endTurn');

  try {
    await db.collection('games').doc(currentGame.id).update({
      currentTeam: currentGame.currentTeam === 'red' ? 'blue' : 'red',
      currentPhase: 'spymaster',
      currentClue: null,
      guessesRemaining: 0,
      log: firebase.firestore.FieldValue.arrayUnion(`${actor} ended ${teamName}'s turn.`),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error('Failed to end turn:', e);
  }
}

async function handleEndGame() {
  if (!currentGame) return;

  const gameId = currentGame.id;
  const userName = getUserName() || 'Someone';

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
    const myTeamColor = getMyTeamColor();
    const isWinner = currentGame.winner === myTeamColor;
    const winnerName = truncateTeamNameGame(currentGame.winner === 'red' ? currentGame.redTeamName : currentGame.blueTeamName);

    // Play win or lose sound
    if (window.playSound) {
      setTimeout(() => {
        window.playSound(isWinner ? 'gameWin' : 'gameLose');
      }, 300);
    }

    overlay.innerHTML = `
      <div class="game-end-card">
        <div class="game-end-title ${isWinner ? 'win' : 'lose'}">${isWinner ? 'Victory!' : 'Defeat'}</div>
        <div class="game-end-subtitle">${escapeHtml(winnerName)} wins the game!</div>
        <div class="game-end-actions">
          <button class="btn primary" onclick="handleRematch()">Rematch</button>
          <button class="btn" onclick="handleLeaveGame()">Leave Game</button>
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
          <button class="btn primary" onclick="handleLeaveGame()">Back to Lobby</button>
        </div>
      </div>
    `;
  }

  document.body.appendChild(overlay);
}

async function handleRematch() {
  if (!currentGame) return;

  // Remove overlay
  const overlay = document.querySelector('.game-end-overlay');
  if (overlay) overlay.remove();

  // Create new game with same teams but swapped colors
  await createGame(
    currentGame.blueTeamId,
    currentGame.blueTeamName,
    currentGame.redTeamId,
    currentGame.redTeamName
  );
}

async function handleLeaveGame() {
  // Remove overlay
  const overlay = document.querySelector('.game-end-overlay');
  if (overlay) overlay.remove();

  stopGameListener();
  showGameLobby();
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

function getMyTeamColor() {
  if (!currentGame) return null;

  const odId = getUserId();

  // For Quick Play games, check player arrays
  if (currentGame.type === 'quick') {
    const inRed = (currentGame.redPlayers || []).some(p => p.odId === odId);
    const inBlue = (currentGame.bluePlayers || []).some(p => p.odId === odId);
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

  const userName = getUserName();
  if (!userName) return false;

  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return false;

  const mySpymaster = myTeamColor === 'red' ? currentGame.redSpymaster : currentGame.blueSpymaster;
  return mySpymaster === userName;
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
let pendingCardSelection = null; // cardIndex pending confirmation
let activeTagMode = null; // 'yes'|'maybe'|'no'|'clear'|null
let operativeChatUnsub = null;
let gameTimerInterval = null;
let gameTimerEnd = null;

// Initialize advanced features
function initAdvancedFeatures() {
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

  // Sidebar toggles
  document.getElementById('toggle-left-sidebar')?.addEventListener('click', toggleLeftSidebar);
  document.getElementById('toggle-right-sidebar')?.addEventListener('click', toggleRightSidebar);

  // Mobile: players popup
  document.getElementById('mobile-players-popup-btn')?.addEventListener('click', openPlayersPopup);
  document.getElementById('players-popup-close')?.addEventListener('click', closePlayersPopup);
  document.getElementById('players-popup-backdrop')?.addEventListener('click', closePlayersPopup);

  // Operative chat form
  document.getElementById('operative-chat-form')?.addEventListener('submit', handleOperativeChatSubmit);

  // Close sidebars on backdrop click
  document.addEventListener('click', (e) => {
    if (e.target.classList.contains('sidebar-backdrop')) {
      closeMobileSidebars();
    }
  });
}

// Call init on DOMContentLoaded
document.addEventListener('DOMContentLoaded', () => {
  initAdvancedFeatures();
});

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

function tagCard(cardIndex, tag) {
  if (tag === 'clear' || cardTags[cardIndex] === tag) {
    delete cardTags[cardIndex];
  } else {
    cardTags[cardIndex] = tag;
  }
  renderCardTags();
  saveTagsToLocal();
}

function clearAllTags() {
  cardTags = {};
  pendingCardSelection = null;
  pendingCardSelection = null;
  renderCardTags();
  saveTagsToLocal();
  setActiveTagMode(null);
}

function renderCardTags() {
  const cards = document.querySelectorAll('.game-card');
  cards.forEach((card, index) => {
    // Remove existing tag
    const existingTag = card.querySelector('.card-tag');
    if (existingTag) existingTag.remove();

    const tag = cardTags[index];
    if (tag && !card.classList.contains('revealed')) {
      const tagEl = document.createElement('div');
      tagEl.className = `card-tag tag-${tag}`;

      if (tag === 'yes') {
        tagEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      } else if (tag === 'maybe') {
        tagEl.innerHTML = '?';
      } else if (tag === 'no') {
        tagEl.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      }

      card.appendChild(tagEl);
    }
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

/* =========================
   Card Selection Confirmation
========================= */
function clearPendingCardSelection() {
  pendingCardSelection = null;
  updatePendingCardSelectionUI();
}

function setPendingCardSelection(cardIndex) {
  pendingCardSelection = cardIndex;
  updatePendingCardSelectionUI();
}

function updatePendingCardSelectionUI() {
  const cards = document.querySelectorAll('.game-card');
  cards.forEach((el) => el.classList.remove('pending-select'));
  if (pendingCardSelection === null || pendingCardSelection === undefined) return;
  const target = document.querySelector(`.game-card[data-index="${pendingCardSelection}"]`);
  if (target && !target.classList.contains('revealed')) {
    target.classList.add('pending-select');
  }
}

/* =========================
   Operative Team Chat
========================= */

function initOperativeChat() {
  if (!currentGame?.id) return;

  // Cleanup previous listener
  if (operativeChatUnsub) {
    operativeChatUnsub();
    operativeChatUnsub = null;
  }

  const myTeamColor = getMyTeamColor();
  if (!myTeamColor) return;

  // Listen to team chat subcollection
  operativeChatUnsub = db.collection('games').doc(currentGame.id)
    .collection(`${myTeamColor}Chat`)
    .orderBy('createdAt', 'asc')
    .limitToLast(50)
    .onSnapshot(snap => {
      renderOperativeChat(snap.docs.map(d => ({ id: d.id, ...d.data() })));
    }, err => console.error('Chat error:', err));
}

function renderOperativeChat(messages) {
  const container = document.getElementById('operative-chat-messages');
  if (!container) return;

  const odId = getUserId();

  if (!messages || messages.length === 0) {
    container.innerHTML = '<div class="chat-empty-state">No messages yet. Discuss with your team!</div>';
    return;
  }

  container.innerHTML = messages.map(msg => {
    const isMe = msg.senderId === odId;
    const time = msg.createdAt?.toDate?.() ? formatTime(msg.createdAt.toDate()) : '';
    const teamColor = getMyTeamColor();

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

  // Auto-scroll to bottom
  container.scrollTop = container.scrollHeight;
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

  if (history.length === 0) {
    container.innerHTML = '<div class="clue-history-empty">No clues given yet</div>';
    return;
  }

  container.innerHTML = history.map(clue => {
    const resultsHtml = (clue.results || []).map((r, idx) => {
      const res = (r.result || (r.correct ? 'correct' : (r.wrong ? 'wrong' : 'neutral')));
      let className = 'neutral';
      if (res === 'correct') className = 'correct';
      else if (res === 'wrong') className = 'wrong';
      else if (res === 'assassin') className = 'assassin';
      const word = String(r.word || '').trim();
      const label = `${idx + 1}. ${word}`;
      return `<span class="guess-chip ${className}">${escapeHtml(label)}</span>`;
    }).join('');

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

  if (!timerEl || !fillEl || !textEl) return;

  timerEl.style.display = 'flex';

  const totalDuration = gameTimerEnd - Date.now();

  gameTimerInterval = setInterval(() => {
    const remaining = Math.max(0, gameTimerEnd - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;

    textEl.textContent = `${minutes}:${secs.toString().padStart(2, '0')}`;

    const percent = (remaining / totalDuration) * 100;
    fillEl.style.width = `${percent}%`;

    // Warning states
    fillEl.classList.remove('warning', 'danger');
    textEl.classList.remove('warning', 'danger');

    if (seconds <= 10) {
      fillEl.classList.add('danger');
      textEl.classList.add('danger');
    } else if (seconds <= 30) {
      fillEl.classList.add('warning');
      textEl.classList.add('warning');
    }

    if (remaining <= 0) {
      stopGameTimer();
    }
  }, 100);
}

function stopGameTimer() {
  if (gameTimerInterval) {
    clearInterval(gameTimerInterval);
    gameTimerInterval = null;
  }
  gameTimerEnd = null;

  const timerEl = document.getElementById('game-timer');
  if (timerEl) timerEl.style.display = 'none';
}

/* =========================
   Team Roster
========================= */
function renderTeamRoster() {
  const redContainer = document.getElementById('roster-red-players');
  const blueContainer = document.getElementById('roster-blue-players');

  if (!redContainer || !blueContainer || !currentGame) return;

  const renderPlayers = (players, spymaster, isCurrentTeam) => {
    if (!players || players.length === 0) {
      return '<div class="roster-player"><span class="roster-player-name" style="color: var(--text-dim);">No players</span></div>';
    }

    return players.map(p => {
      const isSpymaster = p.name === spymaster;
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
    currentGame.redSpymaster,
    isRedTurn
  );

  blueContainer.innerHTML = renderPlayers(
    currentGame.bluePlayers,
    currentGame.blueSpymaster,
    isBlueTurn
  );
}


/* =========================
   Top Bar Team Names (Desktop)
========================= */
function renderTopbarTeamNames() {
  if (!currentGame) return;

  const redEl = document.getElementById('topbar-red-names');
  const blueEl = document.getElementById('topbar-blue-names');
  if (!redEl && !blueEl) return;

  const myId = (typeof getUserId === 'function') ? String(getUserId() || '').trim() : '';

  const render = (players, el, team) => {
    if (!el) return;

    const list = Array.isArray(players) ? players : [];
    const count = Math.max(1, list.length);

    // Horizontal layout: scale font size a bit as teams grow so names still fit.
    const size = count <= 3 ? 13 : (count <= 5 ? 12 : 11);
    // Spacing: fewer players => more breathing room. More players => tighter.
    // We drive this via CSS vars so the layout remains flexible with wrapping.
    const gapX = (count <= 1) ? 0
      : (count === 2) ? 18
      : (count === 3) ? 12
      : (count === 4) ? 8
      : (count === 5) ? 6
      : (count === 6) ? 5
      : 4;
    const gapY = (count <= 4) ? 4 : 3;

    // When teams are small, spread names across the available half to increase perceived distance.
    el.classList.toggle('spread', count === 2 || count === 3);
    el.classList.toggle('cols-2', false);
    el.style.setProperty('--topbar-name-size', `${size}px`);
    el.style.setProperty('--topbar-name-gap-x', `${gapX}px`);
    el.style.setProperty('--topbar-name-gap-y', `${gapY}px`);

    if (list.length === 0) {
      el.innerHTML = `<div class="topbar-player" style="color: var(--text-dim);">—</div>`;
      return;
    }

    el.innerHTML = list.map(p => {
      const pid = String(p?.odId || p?.userId || '').trim();
      const isMe = !!(myId && pid && pid === myId);
      const name = escapeHtml(String(p?.name || '—'));

      // Clickable names: reuse the existing profile popup system.
      const attrs = pid
        ? `class="topbar-player ${isMe ? 'is-me' : ''} profile-link" data-profile-type="player" data-profile-id="${escapeHtml(pid)}"`
        : `class="topbar-player ${isMe ? 'is-me' : ''}"`;

      // Use a button for better a11y + consistent click targets.
      return `<button type="button" ${attrs}>${name}</button>`;
    }).join('');
  };

  render(currentGame.redPlayers, redEl, 'red');
  render(currentGame.bluePlayers, blueEl, 'blue');
}

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
      const name = escapeHtml(String(p?.name || '—'));
      const role = (team === 'red' ? currentGame.redSpymaster : currentGame.blueSpymaster) === p?.name ? 'Spy' : 'Op';
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
   Enhanced Card Click Handler
========================= */
// Store original handleCardClick
const _originalHandleCardClick = handleCardClick;

// Create enhanced version
async function handleCardClickEnhanced(cardIndex) {
  // If in tag mode, tag the card instead of guessing
  if (activeTagMode) {
    tagCard(cardIndex, activeTagMode);
    return;
  }

  // Two-tap confirmation for guesses (no voting system)
  const myTeamColor = getMyTeamColor();
  const isMyTurn = myTeamColor && currentGame?.currentTeam === myTeamColor;
  const canGuess = isMyTurn && currentGame?.currentPhase === 'operatives' && !isCurrentUserSpymaster() && !currentGame?.winner;

  if (!canGuess) return;

  // First tap selects (shows checkmark). Second tap confirms.
  if (pendingCardSelection === cardIndex) {
    clearPendingCardSelection();
    await _originalHandleCardClick(cardIndex);
    return;
  }

  setPendingCardSelection(cardIndex);
}

// Replace global handleCardClick
window.handleCardClick = handleCardClickEnhanced;


/* =========================
   Clue History Tracking
========================= */
// Helper to add clue to history when given
async function addClueToHistory(gameId, team, word, number) {
  if (!gameId) return;

  const clueEntry = {
    team,
    word,
    number,
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
      // Dedupe: a revealed card can't be guessed twice, but multi-client updates
      // (or retries) can cause duplicate writes. If the word already exists in
      // this clue's results, ignore.
      const gWord = String(guess?.word || '').trim().toUpperCase();
      const already = results.some(r => String(r?.word || '').trim().toUpperCase() === gWord);
      if (!already) results.push(guess);
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

  if (operativeChatUnsub) {
    operativeChatUnsub();
    operativeChatUnsub = null;
  }

  cardTags = {};
  pendingCardSelection = null;
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

// ─── AI Modal ────────────────────────────────────────────────────────────────
let pendingAITeam = null;
let pendingAISeatRole = null;

function openAIModal(team, seatRole) {
  pendingAITeam = team;
  pendingAISeatRole = seatRole;

  const modal = document.getElementById('ai-mode-modal');
  if (!modal) return;

  const subtitle = document.getElementById('ai-mode-subtitle');
  const statusEl = document.getElementById('ai-mode-status');
  const teamLabel = team === 'red' ? 'Red' : 'Blue';
  const roleLabel = seatRole === 'spymaster' ? 'Spymaster' : 'Operative';

  if (subtitle) subtitle.textContent = `Adding AI ${roleLabel} to ${teamLabel} team`;
  if (statusEl) statusEl.textContent = '';

  // Helper mode not available for spymaster (helpers don't give clues)
  const helperBtn = document.getElementById('ai-mode-helper');
  if (helperBtn) {
    helperBtn.disabled = (seatRole === 'spymaster');
    helperBtn.title = (seatRole === 'spymaster') ? 'Helpers cannot be Spymasters' : '';
  }

  // Check max AI limit
  const currentCount = typeof countAIsOnTeam === 'function' ? countAIsOnTeam(team) : 0;
  const max = window.AI_CONFIG?.maxAIsPerTeam || 4;
  if (currentCount >= max) {
    if (statusEl) statusEl.textContent = `Maximum ${max} AIs per team reached.`;
  }

  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('modal-open');
  modal.setAttribute('aria-hidden', 'false');
}

function closeAIModal() {
  const modal = document.getElementById('ai-mode-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) modal.style.display = 'none';
  }, 200);
  modal.setAttribute('aria-hidden', 'true');
  pendingAITeam = null;
  pendingAISeatRole = null;
}

window.openAIModal = openAIModal;
window.closeAIModal = closeAIModal;

async function handleAIModeSelect(mode) {
  if (!pendingAITeam || !pendingAISeatRole) return;

  const statusEl = document.getElementById('ai-mode-status');

  // Check max
  const currentCount = typeof countAIsOnTeam === 'function' ? countAIsOnTeam(pendingAITeam) : 0;
  const max = window.AI_CONFIG?.maxAIsPerTeam || 4;
  if (currentCount >= max) {
    if (statusEl) statusEl.textContent = `Maximum ${max} AIs per team reached.`;
    return;
  }

  if (statusEl) statusEl.textContent = 'Adding AI player...';

  try {
    const ai = await addAIPlayer(pendingAITeam, pendingAISeatRole, mode);
    if (ai) {
      if (statusEl) {
        if (ai.statusColor === 'green') statusEl.textContent = `${ai.name} is ready!`;
        else if (ai.statusColor === 'yellow') statusEl.textContent = `${ai.name} connected but verification partial.`;
        else if (ai.statusColor === 'red') statusEl.textContent = `${ai.name} failed to connect. Check API.`;
        else statusEl.textContent = `${ai.name} added.`;
      }
      // Close modal after short delay
      setTimeout(closeAIModal, 800);
    }
  } catch (e) {
    console.error('Add AI failed:', e);
    if (statusEl) statusEl.textContent = 'Failed to add AI player.';
  }
}

// Wire up modal buttons
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('ai-mode-helper')?.addEventListener('click', () => handleAIModeSelect('helper'));
  document.getElementById('ai-mode-autonomous')?.addEventListener('click', () => handleAIModeSelect('autonomous'));
  document.getElementById('ai-mode-modal-close')?.addEventListener('click', closeAIModal);
  document.getElementById('ai-mode-modal-backdrop')?.addEventListener('click', closeAIModal);
});

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

      // Add AI mode badge
      const existingBadge = el.querySelector('.ai-badge');
      if (!existingBadge) {
        const badge = document.createElement('span');
        badge.className = `ai-badge ai-badge-${ai.mode}`;
        badge.textContent = ai.mode === 'helper' ? 'HELPER' : 'AUTO';
        badge.title = ai.mode === 'helper' ? 'AI Helper - chats only' : 'AI Autonomous - plays independently';
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

      // Replace the READY/NOT READY badge with AI status color
      const badgeEl = el.querySelector('.quick-player-badge');
      if (badgeEl) {
        if (ai.statusColor === 'green') {
          badgeEl.textContent = 'READY';
          badgeEl.classList.add('ai-ready-green');
        } else if (ai.statusColor === 'yellow') {
          badgeEl.textContent = 'PARTIAL';
          badgeEl.classList.add('ai-ready-yellow');
        } else if (ai.statusColor === 'red') {
          badgeEl.textContent = 'ERROR';
          badgeEl.classList.add('ai-ready-red');
        } else {
          badgeEl.textContent = 'CHECKING';
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
  const aiPlayersList = window.aiPlayers || [];
  if (aiPlayersList.length === 0) return;

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
