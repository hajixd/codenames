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
let currentGame = null;
let gameUnsub = null;
let challengesUnsub = null;

// Load words on init
document.addEventListener('DOMContentLoaded', async () => {
  await loadWords();
  initGameUI();
  listenToChallenges();
});

/* =========================
   Word Bank
========================= */
async function loadWords() {
  try {
    const res = await fetch('words.json');
    const data = await res.json();
    wordsBank = data.standard || [];
  } catch (e) {
    console.error('Failed to load words:', e);
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

function getRandomWords(count) {
  const shuffled = [...wordsBank].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

/* =========================
   Key Card Generation
========================= */
function generateKeyCard(firstTeam) {
  // firstTeam gets 9 cards, other team gets 8
  // 7 neutral, 1 assassin
  const types = [];

  const first = firstTeam === 'red' ? 'red' : 'blue';
  const second = firstTeam === 'red' ? 'blue' : 'red';

  for (let i = 0; i < FIRST_TEAM_CARDS; i++) types.push(first);
  for (let i = 0; i < SECOND_TEAM_CARDS; i++) types.push(second);
  for (let i = 0; i < NEUTRAL_CARDS; i++) types.push('neutral');
  for (let i = 0; i < ASSASSIN_CARDS; i++) types.push('assassin');

  // Shuffle
  return types.sort(() => Math.random() - 0.5);
}

/* =========================
   Game UI Initialization
========================= */
function initGameUI() {
  // Role selection
  document.getElementById('role-spymaster')?.addEventListener('click', () => selectRole('spymaster'));
  document.getElementById('role-operative')?.addEventListener('click', () => selectRole('operative'));

  // Clue form
  document.getElementById('clue-form')?.addEventListener('submit', handleClueSubmit);

  // End turn button
  document.getElementById('end-turn-btn')?.addEventListener('click', handleEndTurn);

  // Leave game
  document.getElementById('leave-game-btn')?.addEventListener('click', handleLeaveGame);

  // Rejoin game
  document.getElementById('rejoin-game-btn')?.addEventListener('click', rejoinCurrentGame);

  // Initial render
  renderGameLobby();
}

/* =========================
   Challenge System
========================= */
function listenToChallenges() {
  if (challengesUnsub) challengesUnsub();

  challengesUnsub = db.collection('challenges')
    .orderBy('createdAt', 'desc')
    .onSnapshot((snapshot) => {
      renderGameLobby();
    }, (err) => {
      console.error('Challenges listener error:', err);
    });
}

async function renderGameLobby() {
  const myTeam = getMyTeam();
  const statusEl = document.getElementById('game-team-status');
  const challengesSec = document.getElementById('challenges-section');
  const challengeTeamsSec = document.getElementById('challenge-teams-section');
  const pendingSec = document.getElementById('pending-challenges-section');
  const activeBanner = document.getElementById('game-active-banner');

  if (!statusEl) return;

  // Check if user is on a team
  if (!myTeam) {
    statusEl.innerHTML = '<div class="hint">You need to be on a team to play.</div>';
    if (challengesSec) challengesSec.style.display = 'none';
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
    if (pendingSec) pendingSec.style.display = 'none';
    if (activeBanner) activeBanner.style.display = 'none';
    return;
  }

  // Show team status
  statusEl.innerHTML = `
    <div class="team-info">
      <span class="team-color-dot" style="--dot-color: ${myTeam.color || '#3b82f6'}"></span>
      <span class="team-name">${escapeHtml(myTeam.teamName || 'My Team')}</span>
    </div>
  `;

  // Check for active game
  const activeGame = await getActiveGameForTeam(myTeam.id);
  if (activeGame) {
    if (activeBanner) {
      activeBanner.style.display = 'flex';
      const teamsText = document.getElementById('game-banner-teams');
      if (teamsText) {
        teamsText.textContent = `${activeGame.redTeamName} vs ${activeGame.blueTeamName}`;
      }
    }
    if (challengesSec) challengesSec.style.display = 'none';
    if (challengeTeamsSec) challengeTeamsSec.style.display = 'none';
    if (pendingSec) pendingSec.style.display = 'none';
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
            <span class="challenge-team-name">${escapeHtml(c.fromTeamName || 'Unknown Team')}</span>
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
            <span class="challenge-team-name">${escapeHtml(c.toTeamName || 'Unknown Team')}</span>
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
            <span class="team-color-dot" style="--dot-color: ${t.color || '#3b82f6'}"></span>
            <span class="challenge-team-name">${escapeHtml(t.teamName || 'Team')}</span>
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
    renderGameLobby();
  } catch (e) {
    console.error('Failed to send challenge:', e);
  }
}

async function cancelChallenge(challengeId) {
  try {
    await db.collection('challenges').doc(challengeId).delete();
    renderGameLobby();
  } catch (e) {
    console.error('Failed to cancel challenge:', e);
  }
}

async function declineChallenge(challengeId) {
  try {
    await db.collection('challenges').doc(challengeId).delete();
    renderGameLobby();
  } catch (e) {
    console.error('Failed to decline challenge:', e);
  }
}

async function acceptChallenge(challengeId) {
  const myTeam = getMyTeam();
  if (!myTeam) return;

  try {
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

    renderGameLobby();
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
  const words = getRandomWords(BOARD_SIZE);
  const keyCard = generateKeyCard(firstTeam);

  const cards = words.map((word, i) => ({
    word,
    type: keyCard[i],
    revealed: false
  }));

  const gameData = {
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
  startGameListener(docRef.id);

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
    startGameListener(activeGame.id);
  }
}

/* =========================
   Game Listener
========================= */
function startGameListener(gameId) {
  if (gameUnsub) gameUnsub();

  gameUnsub = db.collection('games').doc(gameId).onSnapshot((snap) => {
    if (!snap.exists) {
      currentGame = null;
      showGameLobby();
      return;
    }

    currentGame = { id: snap.id, ...snap.data() };
    renderGame();
  }, (err) => {
    console.error('Game listener error:', err);
  });
}

function stopGameListener() {
  if (gameUnsub) gameUnsub();
  gameUnsub = null;
  currentGame = null;
}

/* =========================
   Game Rendering
========================= */
function showGameLobby() {
  document.getElementById('game-lobby').style.display = 'block';
  document.getElementById('game-board-container').style.display = 'none';
  renderGameLobby();
}

function showGameBoard() {
  document.getElementById('game-lobby').style.display = 'none';
  document.getElementById('game-board-container').style.display = 'block';
}

function renderGame() {
  if (!currentGame) {
    showGameLobby();
    return;
  }

  showGameBoard();

  const myTeam = getMyTeam();
  const myTeamColor = getMyTeamColor();
  const isSpymaster = isCurrentUserSpymaster();

  // Update header
  document.getElementById('game-red-team').textContent = currentGame.redTeamName || 'Red Team';
  document.getElementById('game-blue-team').textContent = currentGame.blueTeamName || 'Blue Team';
  document.getElementById('game-red-left').textContent = currentGame.redCardsLeft;
  document.getElementById('game-blue-left').textContent = currentGame.blueCardsLeft;

  // Update turn display
  const turnTeamEl = document.getElementById('game-turn-team');
  const turnRoleEl = document.getElementById('game-turn-role');

  if (currentGame.winner) {
    turnTeamEl.textContent = currentGame.winner === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
    turnTeamEl.className = `turn-team ${currentGame.winner}`;
    turnRoleEl.textContent = 'WINS!';
  } else {
    turnTeamEl.textContent = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
    turnTeamEl.className = `turn-team ${currentGame.currentTeam}`;
    turnRoleEl.textContent = currentGame.currentPhase === 'spymaster' ? '(Spymaster)' : '(Operatives)';
  }

  // Role selection
  const roleSelectionEl = document.getElementById('role-selection');
  if (currentGame.currentPhase === 'role-selection' && myTeamColor) {
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

  // Clue area
  renderClueArea(isSpymaster, myTeamColor);

  // Game log
  renderGameLog();

  // Check for game end
  if (currentGame.winner) {
    showGameEndOverlay();
  }
}

function renderBoard(isSpymaster) {
  const boardEl = document.getElementById('game-board');
  if (!boardEl || !currentGame?.cards) return;

  const myTeamColor = getMyTeamColor();
  const isMyTurn = currentGame.currentTeam === myTeamColor;
  const canGuess = isMyTurn && currentGame.currentPhase === 'operatives' && !isSpymaster && !currentGame.winner;

  boardEl.innerHTML = currentGame.cards.map((card, i) => {
    const classes = ['game-card'];

    if (card.revealed) {
      classes.push('revealed');
      classes.push(`card-${card.type}`);
    } else if (isSpymaster) {
      classes.push('spymaster-view');
      classes.push(`card-${card.type}`);
      classes.push('disabled');
    } else if (!canGuess) {
      classes.push('disabled');
    }

    const clickHandler = canGuess && !card.revealed ? `onclick="handleCardClick(${i})"` : '';

    return `
      <div class="${classes.join(' ')}" ${clickHandler}>
        <span class="card-word">${escapeHtml(card.word)}</span>
      </div>
    `;
  }).join('');
}

function renderClueArea(isSpymaster, myTeamColor) {
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

  const isMyTurn = currentGame.currentTeam === myTeamColor;

  if (currentGame.currentPhase === 'role-selection') {
    waitingEl.style.display = 'block';
    document.getElementById('waiting-for').textContent = 'all teams to select roles';
    return;
  }

  if (currentGame.currentPhase === 'spymaster') {
    if (isMyTurn && isSpymaster) {
      // Show clue input
      clueFormEl.style.display = 'flex';
    } else {
      // Show waiting message
      waitingEl.style.display = 'block';
      const waitingTeam = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
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
      document.getElementById('guesses-left').textContent = `(${currentGame.guessesRemaining} guesses left)`;
    }

    if (isMyTurn && !isSpymaster) {
      // Show end turn button
      operativeActionsEl.style.display = 'flex';
    } else if (!isMyTurn) {
      waitingEl.style.display = 'block';
      const waitingTeam = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
      document.getElementById('waiting-for').textContent = `${waitingTeam}'s Operatives`;
    }
  }
}

function renderGameLog() {
  const logEl = document.getElementById('game-log-entries');
  if (!logEl || !currentGame?.log) return;

  logEl.innerHTML = currentGame.log.map(entry => {
    return `<div class="log-entry">${entry}</div>`;
  }).join('');

  // Auto-scroll to bottom
  const container = document.getElementById('game-log');
  if (container) container.scrollTop = container.scrollHeight;
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
    statusEl.textContent = `Spymaster: ${mySpymaster}`;
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

  if (willHaveRedSpymaster && willHaveBlueSpymaster) {
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

  try {
    await db.collection('games').doc(currentGame.id).update({
      currentClue: { word, number },
      guessesRemaining: number + 1, // Can guess number + 1 times
      currentPhase: 'operatives',
      log: firebase.firestore.FieldValue.arrayUnion(`${teamName} Spymaster: "${word}" for ${number}`),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    wordInput.value = '';
    numInput.value = '';
  } catch (e) {
    console.error('Failed to give clue:', e);
  }
}

/* =========================
   Card Guessing
========================= */
async function handleCardClick(cardIndex) {
  if (!currentGame || currentGame.currentPhase !== 'operatives') return;
  if (currentGame.winner) return;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return;
  if (isCurrentUserSpymaster()) return;

  const card = currentGame.cards[cardIndex];
  if (!card || card.revealed) return;

  // Reveal the card
  const updatedCards = [...currentGame.cards];
  updatedCards[cardIndex] = { ...card, revealed: true };

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
  const updates = {
    cards: updatedCards,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  };

  let logEntry = `${teamName} guessed "${card.word}" - `;
  let endTurn = false;
  let winner = null;

  // Determine result
  if (card.type === 'assassin') {
    // Game over - other team wins
    winner = currentGame.currentTeam === 'red' ? 'blue' : 'red';
    logEntry += 'ASSASSIN! Game over.';
  } else if (card.type === currentGame.currentTeam) {
    // Correct guess
    logEntry += 'Correct!';

    // Update cards left
    if (currentGame.currentTeam === 'red') {
      updates.redCardsLeft = currentGame.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = currentGame.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }

    // Decrease guesses remaining
    updates.guessesRemaining = currentGame.guessesRemaining - 1;
    if (updates.guessesRemaining <= 0 && !winner) {
      endTurn = true;
    }
  } else if (card.type === 'neutral') {
    // Neutral - end turn
    logEntry += 'Neutral. Turn ends.';
    endTurn = true;
  } else {
    // Other team's card - end turn and give them a point
    logEntry += `Wrong! (${card.type === 'red' ? currentGame.redTeamName : currentGame.blueTeamName}'s card)`;

    if (card.type === 'red') {
      updates.redCardsLeft = currentGame.redCardsLeft - 1;
      if (updates.redCardsLeft === 0) winner = 'red';
    } else {
      updates.blueCardsLeft = currentGame.blueCardsLeft - 1;
      if (updates.blueCardsLeft === 0) winner = 'blue';
    }

    endTurn = true;
  }

  updates.log = firebase.firestore.FieldValue.arrayUnion(logEntry);

  if (winner) {
    updates.winner = winner;
    updates.currentPhase = 'ended';
    const winnerName = winner === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;
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
  } catch (e) {
    console.error('Failed to reveal card:', e);
  }
}

async function handleEndTurn() {
  if (!currentGame || currentGame.currentPhase !== 'operatives') return;
  if (currentGame.winner) return;

  const myTeamColor = getMyTeamColor();
  if (currentGame.currentTeam !== myTeamColor) return;

  const teamName = currentGame.currentTeam === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;

  try {
    await db.collection('games').doc(currentGame.id).update({
      currentTeam: currentGame.currentTeam === 'red' ? 'blue' : 'red',
      currentPhase: 'spymaster',
      currentClue: null,
      guessesRemaining: 0,
      log: firebase.firestore.FieldValue.arrayUnion(`${teamName} ended their turn.`),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) {
    console.error('Failed to end turn:', e);
  }
}

/* =========================
   Game End
========================= */
function showGameEndOverlay() {
  // Remove existing overlay if any
  const existing = document.querySelector('.game-end-overlay');
  if (existing) existing.remove();

  if (!currentGame?.winner) return;

  const myTeamColor = getMyTeamColor();
  const isWinner = currentGame.winner === myTeamColor;
  const winnerName = currentGame.winner === 'red' ? currentGame.redTeamName : currentGame.blueTeamName;

  const overlay = document.createElement('div');
  overlay.className = 'game-end-overlay';
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

// Update badge when challenges change
const originalListenToChallenges = listenToChallenges;
listenToChallenges = function() {
  if (challengesUnsub) challengesUnsub();

  challengesUnsub = db.collection('challenges')
    .orderBy('createdAt', 'desc')
    .onSnapshot((snapshot) => {
      renderGameLobby();
      updateGameTabBadge();
    }, (err) => {
      console.error('Challenges listener error:', err);
    });
};

// Call badge update on init
setTimeout(updateGameTabBadge, 1000);
