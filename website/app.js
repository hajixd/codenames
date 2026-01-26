const MAX_TEAMS = 6;

function getTeams() {
  const teams = localStorage.getItem('codenames-teams');
  return teams ? JSON.parse(teams) : [];
}

function saveTeams(teams) {
  localStorage.setItem('codenames-teams', JSON.stringify(teams));
}

function updateTeamsCount() {
  const teams = getTeams();
  const count = teams.length;
  const spotsLeft = MAX_TEAMS - count;

  document.querySelectorAll('#teams-count').forEach(el => {
    el.textContent = count;
  });

  const spotsEl = document.getElementById('spots-left');
  if (spotsEl) spotsEl.textContent = spotsLeft;

  const registerBtn = document.getElementById('register-btn');
  if (registerBtn && count >= MAX_TEAMS) {
    registerBtn.textContent = 'Tournament Full';
    registerBtn.classList.add('disabled');
  }
}

function checkRegistrationStatus() {
  const teams = getTeams();

  if (teams.length >= MAX_TEAMS) {
    const formContainer = document.getElementById('form-container');
    const closedBox = document.getElementById('closed-box');
    if (formContainer) formContainer.style.display = 'none';
    if (closedBox) closedBox.style.display = 'block';
  }
}

function displayTeamsPreview() {
  const teams = getTeams();
  const container = document.getElementById('teams-preview');

  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-slot">No teams registered yet</div>';
    return;
  }

  let html = '';
  teams.forEach((team, i) => {
    html += `
      <div class="team-row">
        <span class="name">${escapeHtml(team.teamName)}</span>
        <span class="slot">Slot ${i + 1}</span>
      </div>
    `;
  });

  container.innerHTML = html;
}

function handleFormSubmit() {
  const teams = getTeams();

  if (teams.length >= MAX_TEAMS) {
    alert('Tournament is full!');
    window.location.href = '/teams.html';
    return;
  }

  const errorBox = document.getElementById('error-box');
  const errorList = document.getElementById('error-list');

  const teamName = document.getElementById('teamName').value.trim();
  const players = [
    {
      name: document.getElementById('player0-name').value.trim(),
      discord: document.getElementById('player0-discord').value.trim()
    },
    {
      name: document.getElementById('player1-name').value.trim(),
      discord: document.getElementById('player1-discord').value.trim()
    },
    {
      name: document.getElementById('player2-name').value.trim(),
      discord: document.getElementById('player2-discord').value.trim()
    }
  ];

  const errors = [];

  if (!teamName) {
    errors.push('Team name required');
  } else if (teams.find(t => t.teamName.toLowerCase() === teamName.toLowerCase())) {
    errors.push('Team name already taken');
  }

  players.forEach((p, i) => {
    if (!p.name) errors.push(`Player ${i + 1} name required`);
    if (!p.discord) errors.push(`Player ${i + 1} Discord required`);
  });

  const discords = players.map(p => p.discord.toLowerCase());
  if (new Set(discords).size !== discords.length) {
    errors.push('Duplicate Discord usernames');
  }

  if (errors.length > 0) {
    errorList.innerHTML = errors.map(e => `<li>${e}</li>`).join('');
    errorBox.style.display = 'block';
    return;
  }

  errorBox.style.display = 'none';

  const team = {
    id: Date.now().toString(),
    teamName,
    players,
    registeredAt: new Date().toISOString()
  };

  teams.push(team);
  saveTeams(teams);
  window.location.href = '/teams.html';
}

function displayTeams() {
  const teams = getTeams();
  const container = document.getElementById('teams-container');

  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = `
      <div class="no-teams">
        <p>No teams registered yet</p>
        <a href="/register.html" class="btn-register">Register First Team</a>
      </div>
    `;
    return;
  }

  let html = '<div class="teams-grid">';

  teams.forEach((team, i) => {
    html += `
      <div class="team-card">
        <div class="team-card-header">
          <h3>${escapeHtml(team.teamName)}</h3>
          <span class="team-card-slot">#${i + 1}</span>
        </div>
        <div class="team-card-players">
          ${team.players.map(p => `
            <div class="player-row">
              <span class="name">${escapeHtml(p.name)}</span>
              <span class="discord">@${escapeHtml(p.discord)}</span>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  html += '</div>';
  container.innerHTML = html;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
