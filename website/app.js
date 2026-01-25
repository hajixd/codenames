// Get teams from localStorage
function getTeams() {
  const teams = localStorage.getItem('codenames-teams');
  return teams ? JSON.parse(teams) : [];
}

// Save teams to localStorage
function saveTeams(teams) {
  localStorage.setItem('codenames-teams', JSON.stringify(teams));
}

// Update teams count in navbar
function updateTeamsCount() {
  const teams = getTeams();
  const countElements = document.querySelectorAll('#teams-count');
  countElements.forEach(el => {
    if (el) el.textContent = teams.length;
  });
  
  // Update stat on home page
  const teamsStat = document.getElementById('teams-stat');
  if (teamsStat) {
    teamsStat.textContent = teams.length;
  }
}

// Validate email format
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// Handle form submission
function handleFormSubmit() {
  const form = document.getElementById('register-form');
  const errorBox = document.getElementById('error-box');
  const errorList = document.getElementById('error-list');
  
  // Get form values
  const teamName = document.getElementById('teamName').value.trim();
  const players = [
    {
      name: document.getElementById('player0-name').value.trim(),
      email: document.getElementById('player0-email').value.trim()
    },
    {
      name: document.getElementById('player1-name').value.trim(),
      email: document.getElementById('player1-email').value.trim()
    },
    {
      name: document.getElementById('player2-name').value.trim(),
      email: document.getElementById('player2-email').value.trim()
    }
  ];
  
  // Validate form
  const errors = [];
  
  if (!teamName) {
    errors.push('Team name is required');
  }
  
  players.forEach((player, index) => {
    if (!player.name) {
      errors.push(`Player ${index + 1} name is required`);
    }
    if (!player.email) {
      errors.push(`Player ${index + 1} email is required`);
    } else if (!isValidEmail(player.email)) {
      errors.push(`Player ${index + 1} email is invalid`);
    }
  });
  
  // Check for duplicate emails
  const emails = players.map(p => p.email.toLowerCase());
  const uniqueEmails = new Set(emails);
  if (uniqueEmails.size !== emails.length) {
    errors.push('Each player must have a unique email address');
  }
  
  // Show errors if any
  if (errors.length > 0) {
    errorList.innerHTML = errors.map(error => `<li>${error}</li>`).join('');
    errorBox.style.display = 'block';
    return;
  }
  
  // Hide errors
  errorBox.style.display = 'none';
  
  // Create team object
  const team = {
    id: Date.now().toString(),
    teamName: teamName,
    players: players,
    registeredAt: new Date().toISOString()
  };
  
  // Save team
  const teams = getTeams();
  teams.push(team);
  saveTeams(teams);
  
  // Reset form
  form.reset();
  
  // Redirect to teams page
  window.location.href = '/teams.html';
}

// Display teams on teams page
function displayTeams() {
  const teams = getTeams();
  const container = document.getElementById('teams-container');
  
  if (!container) return;
  
  if (teams.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎯</div>
        <h2>No teams registered yet</h2>
        <p>Be the first to register your team for the tournament!</p>
        <a href="/register.html" class="btn btn-primary">Register Your Team</a>
      </div>
    `;
    return;
  }
  
  // Display teams
  let html = '<div class="teams-grid">';
  
  teams.forEach(team => {
    const date = new Date(team.registeredAt);
    const formattedDate = date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
    
    html += `
      <div class="team-card">
        <div class="team-header">
          <h2>${escapeHtml(team.teamName)}</h2>
          <span class="team-id">#${team.id.slice(-6)}</span>
        </div>
        <div class="team-players">
          <h3>Players:</h3>
          <ul>
            ${team.players.map(player => `
              <li>
                <span class="player-name">${escapeHtml(player.name)}</span>
                <span class="player-email">${escapeHtml(player.email)}</span>
              </li>
            `).join('')}
          </ul>
        </div>
        <div class="team-footer">
          <span class="team-date">Registered: ${formattedDate}</span>
        </div>
      </div>
    `;
  });
  
  html += '</div>';
  
  // Add summary
  html += `
    <div class="teams-summary">
      <div class="summary-card">
        <div class="summary-number">${teams.length}</div>
        <div class="summary-label">Total Teams</div>
      </div>
      <div class="summary-card">
        <div class="summary-number">${teams.length * 3}</div>
        <div class="summary-label">Total Players</div>
      </div>
    </div>
  `;
  
  container.innerHTML = html;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
