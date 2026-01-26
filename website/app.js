const MAX_TEAMS = 6;

// Firebase config
const firebaseConfig = {
  apiKey: "AIzaSyCX_g7RxQsIatEhAnZgeXHedFsxhi8M2m8",
  authDomain: "codenames-tournament.firebaseapp.com",
  projectId: "codenames-tournament",
  storageBucket: "codenames-tournament.firebasestorage.app",
  messagingSenderId: "199881649305",
  appId: "1:199881649305:web:b907e2832cf7d9d4151c08"
};

// Initialize Firebase
firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initForm();
  listenToTeams(); // Real-time listener
});

// Tab switching (mobile)
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  document.getElementById('panel-home').classList.add('active');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      panels.forEach(p => p.classList.remove('active'));
      document.getElementById(panelId).classList.add('active');
    });
  });
}

// Form handling
function initForm() {
  const form = document.getElementById('register-form');
  if (form) {
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      handleSubmit();
    });
  }
}

// Real-time listener for teams
function listenToTeams() {
  db.collection('teams')
    .orderBy('registeredAt', 'asc')
    .onSnapshot((snapshot) => {
      const teams = [];
      snapshot.forEach(doc => {
        teams.push({ id: doc.id, ...doc.data() });
      });
      updateUI(teams);
    }, (error) => {
      console.error('Error listening to teams:', error);
      // Fallback to localStorage if Firebase fails
      const localTeams = JSON.parse(localStorage.getItem('codenames-teams') || '[]');
      updateUI(localTeams);
    });
}

// Update all UI elements
function updateUI(teams) {
  const count = teams.length;
  const spots = MAX_TEAMS - count;

  // Update spots
  const spotsEl = document.getElementById('spots-left');
  if (spotsEl) spotsEl.textContent = spots;

  // Update players count
  const playersEl = document.getElementById('players-count');
  if (playersEl) playersEl.textContent = count * 3;

  // Update team count header
  const countHeader = document.getElementById('team-count-header');
  if (countHeader) countHeader.textContent = count;

  // Check if full
  const form = document.getElementById('register-form');
  const closedMsg = document.getElementById('closed-msg');
  const submitBtn = document.getElementById('submit-btn');

  if (count >= MAX_TEAMS) {
    if (form) form.style.display = 'none';
    if (closedMsg) closedMsg.style.display = 'flex';
    if (submitBtn) submitBtn.disabled = true;
  } else {
    if (form) form.style.display = 'block';
    if (closedMsg) closedMsg.style.display = 'none';
    if (submitBtn) submitBtn.disabled = false;
  }

  // Render teams list
  renderTeams(teams);
}

// Render teams
function renderTeams(teams) {
  const container = document.getElementById('teams-list');
  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state">No teams yet</div>';
    return;
  }

  let html = '';
  teams.forEach((team, i) => {
    html += `
      <div class="team-card">
        <div class="team-card-header">
          <h3>${esc(team.teamName)}</h3>
          <span class="team-slot">#${i + 1}</span>
        </div>
        <div class="team-players">
          ${team.players.map(p => `
            <div class="player-row">
              <span>${esc(p.name)}</span>
              <span class="discord">@${esc(p.discord)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Handle form submit
async function handleSubmit() {
  const submitBtn = document.getElementById('submit-btn');
  const errorBox = document.getElementById('error-box');
  const errorList = document.getElementById('error-list');

  // Get current team count
  const snapshot = await db.collection('teams').get();
  if (snapshot.size >= MAX_TEAMS) {
    alert('Tournament full!');
    return;
  }

  const teamName = document.getElementById('teamName').value.trim();
  const players = [
    { name: document.getElementById('p0-name').value.trim(), discord: document.getElementById('p0-discord').value.trim() },
    { name: document.getElementById('p1-name').value.trim(), discord: document.getElementById('p1-discord').value.trim() },
    { name: document.getElementById('p2-name').value.trim(), discord: document.getElementById('p2-discord').value.trim() }
  ];

  // Validate
  const errors = [];

  if (!teamName) {
    errors.push('Team name required');
  } else {
    // Check for duplicate team name
    const existing = await db.collection('teams').where('teamNameLower', '==', teamName.toLowerCase()).get();
    if (!existing.empty) {
      errors.push('Team name taken');
    }
  }

  players.forEach((p, i) => {
    if (!p.name) errors.push(`Player ${i+1} name required`);
    if (!p.discord) errors.push(`Player ${i+1} Discord required`);
  });

  const discords = players.map(p => p.discord.toLowerCase()).filter(d => d);
  if (new Set(discords).size !== discords.length) {
    errors.push('Duplicate Discord usernames');
  }

  if (errors.length) {
    errorList.innerHTML = errors.map(e => `<li>${e}</li>`).join('');
    errorBox.style.display = 'block';
    return;
  }

  errorBox.style.display = 'none';
  submitBtn.disabled = true;
  submitBtn.textContent = 'Registering...';

  try {
    // Save to Firebase
    await db.collection('teams').add({
      teamName,
      teamNameLower: teamName.toLowerCase(),
      players,
      registeredAt: firebase.firestore.FieldValue.serverTimestamp()
    });

    // Reset form
    document.getElementById('register-form').reset();

    // Switch to teams tab on mobile
    const teamsTab = document.querySelector('[data-panel="panel-teams"]');
    if (teamsTab && window.innerWidth <= 768) {
      teamsTab.click();
    }
  } catch (error) {
    console.error('Error registering team:', error);
    alert('Error registering. Please try again.');
  }

  submitBtn.disabled = false;
  submitBtn.textContent = 'Register';
}

// Escape HTML
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
