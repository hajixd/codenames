const MAX_TEAMS = 6;

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  updateUI();
  initForm();
});

// Tab switching (mobile)
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  // Set initial active panel
  document.getElementById('panel-home').classList.add('active');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;

      // Update tabs
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      // Update panels
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

// Get/save teams
function getTeams() {
  const data = localStorage.getItem('codenames-teams');
  return data ? JSON.parse(data) : [];
}

function saveTeams(teams) {
  localStorage.setItem('codenames-teams', JSON.stringify(teams));
}

// Update all UI elements
function updateUI() {
  const teams = getTeams();
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
  if (count >= MAX_TEAMS) {
    const form = document.getElementById('register-form');
    const closedMsg = document.getElementById('closed-msg');
    const submitBtn = document.getElementById('submit-btn');

    if (form) form.style.display = 'none';
    if (closedMsg) closedMsg.style.display = 'flex';
    if (submitBtn) submitBtn.disabled = true;
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
function handleSubmit() {
  const teams = getTeams();

  if (teams.length >= MAX_TEAMS) {
    alert('Tournament full!');
    return;
  }

  const errorBox = document.getElementById('error-box');
  const errorList = document.getElementById('error-list');

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
  } else if (teams.find(t => t.teamName.toLowerCase() === teamName.toLowerCase())) {
    errors.push('Team name taken');
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

  // Save team
  teams.push({
    id: Date.now().toString(),
    teamName,
    players,
    registeredAt: new Date().toISOString()
  });

  saveTeams(teams);

  // Reset form
  document.getElementById('register-form').reset();

  // Update UI
  updateUI();

  // Switch to teams tab on mobile
  const teamsTab = document.querySelector('[data-panel="panel-teams"]');
  if (teamsTab && window.innerWidth <= 768) {
    teamsTab.click();
  }
}

// Escape HTML
function esc(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
