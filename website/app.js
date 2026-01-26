const MAX_TEAMS = 6;
const TEAM_SIZE = 3;

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

let teamsCache = [];
let manageUnsub = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initForms();
  listenToTeams();
});

/* =========================
   Tabs
========================= */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  // default
  const defaultPanel = 'panel-home';
  document.getElementById(defaultPanel)?.classList.add('active');
  document.querySelector(`.tab[data-panel="${defaultPanel}"]`)?.classList.add('active');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;

      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      panels.forEach(p => p.classList.remove('active'));
      document.getElementById(panelId)?.classList.add('active');
    });
  });
}

/* =========================
   Real-time data
========================= */
function listenToTeams() {
  db.collection('teams')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      teamsCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      updateUI(teamsCache);
      renderTeams(teamsCache);
      populateTeamSelects(teamsCache);
    }, (err) => {
      console.error('Team listener error:', err);
    });
}

function updateUI(teams) {
  const teamCount = teams.length;
  const spots = Math.max(0, MAX_TEAMS - teamCount);
  const players = teams.reduce((sum, t) => sum + (getMembers(t).length), 0);

  // Spots left (team spots)
  const spotsEl = document.getElementById('spots-left');
  if (spotsEl) spotsEl.textContent = spots;

  // Player count (accepted members)
  const playersEl = document.getElementById('players-count');
  if (playersEl) playersEl.textContent = players;

  // Team count header
  const countHeader = document.getElementById('team-count-header');
  if (countHeader) countHeader.textContent = teamCount;
}

function populateTeamSelects(teams) {
  const joinSel = document.getElementById('join-teamSelect');
  const manageSel = document.getElementById('manage-teamSelect');

  const opts = ['<option value="">Select a team…</option>']
    .concat(teams.map(t => {
      const members = getMembers(t).length;
      const pending = Array.isArray(t.pendingDiscords) ? t.pendingDiscords.length : 0;
      const label = `${esc(t.teamName)} (${members}/${TEAM_SIZE}${pending ? ` • ${pending} pending` : ''})`;
      return `<option value="${t.id}">${label}</option>`;
    }))
    .join('');

  if (joinSel) joinSel.innerHTML = opts;
  if (manageSel) manageSel.innerHTML = opts;
}

/* =========================
   Rendering
========================= */
function getMembers(team) {
  if (Array.isArray(team.members)) return team.members;
  if (Array.isArray(team.players)) return team.players;
  return [];
}

function renderTeams(teams) {
  const container = document.getElementById('teams-list');
  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state">No teams yet</div>';
    return;
  }

  const html = teams.map((team, i) => {
    const members = getMembers(team);
    const pendingCount = Array.isArray(team.pendingDiscords) ? team.pendingDiscords.length : 0;

    const memberRows = members.length
      ? members.map(m => `
          <div class="player-row">
            <span>${esc(m.name || '')}</span>
            <span class="discord">@${esc(m.discord || '')}</span>
          </div>
        `).join('')
      : '<div class="empty-state">No accepted members yet</div>';

    return `
      <div class="team-card">
        <details class="team-details">
          <summary class="team-summary">
            <div class="team-left">
              <div class="team-rank">#${i + 1}</div>
              <div class="team-name">${esc(team.teamName || 'Unnamed')}</div>
            </div>
            <div class="team-right">
              <span class="meta">${members.length}/${TEAM_SIZE}</span>
              ${pendingCount ? `<span class="meta pill pending">${pendingCount} pending</span>` : ''}
            </div>
          </summary>

          <div class="team-body">
            <div class="team-section-title">Members</div>
            <div class="players-list">${memberRows}</div>
            ${pendingCount ? `<div class="team-footnote">${pendingCount} join request${pendingCount === 1 ? '' : 's'} waiting for creator approval.</div>` : ''}
          </div>
        </details>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

/* =========================
   Forms
========================= */
function initForms() {
  document.getElementById('create-team-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleCreateTeam();
  });

  document.getElementById('join-team-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    handleJoinRequest();
  });

  document.getElementById('manage-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    loadManageRequests();
  });

  // Accept/decline delegation
  document.getElementById('manage-area')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const teamId = btn.dataset.teamId;
    const reqId = btn.dataset.reqId;

    if (!teamId || !reqId) return;

    if (action === 'accept') acceptRequest(teamId, reqId);
    if (action === 'decline') declineRequest(teamId, reqId);
  });
}

async function handleCreateTeam() {
  const btn = document.getElementById('create-btn');
  const hint = document.getElementById('create-hint');

  const teamName = document.getElementById('create-teamName')?.value.trim() || '';
  const name = document.getElementById('create-name')?.value.trim() || '';
  const discordRaw = document.getElementById('create-discord')?.value.trim() || '';
  const discord = sanitizeDiscord(discordRaw);
  const discordLower = discord.toLowerCase();

  hint.textContent = '';

  const errors = [];
  if (!teamName) errors.push('Team name required');
  if (!name) errors.push('Your name required');
  if (!discord) errors.push('Discord required');

  if (teamsCache.length >= MAX_TEAMS) {
    errors.push('Tournament is full (no more team slots).');
  }

  if (errors.length) {
    hint.textContent = errors.join(' ');
    hint.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Creating…';

  try {
    // Unique team name
    const existing = await db.collection('teams')
      .where('teamNameLower', '==', teamName.toLowerCase())
      .get();

    if (!existing.empty) {
      hint.textContent = 'Team name taken.';
      hint.classList.add('error');
      return;
    }
    // Discord uniqueness (local cache)
    if (isDiscordTaken(discordLower)) {
      hint.textContent = 'That Discord handle is already on a team or pending on another team.';
      hint.classList.add('error');
      return;
    }

    await db.collection('teams').add({
      teamName,
      teamNameLower: teamName.toLowerCase(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      creatorName: name,
      creatorDiscord: discord,
      creatorDiscordLower: discordLower,
      members: [
        { name, discord, joinedAt: firebase.firestore.FieldValue.serverTimestamp() }
      ],
      memberDiscords: [discordLower],
      pendingDiscords: [],
      allDiscords: [discordLower]
    });

    // reset form
    document.getElementById('create-team-form')?.reset();
    hint.textContent = 'Team created! Tell friends to request to join.';
    hint.classList.remove('error');
    hint.classList.add('ok');

  } catch (err) {
    console.error('Create team error:', err);
    hint.textContent = 'Error creating team. Please try again.';
    hint.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create team';
  }
}

async function handleJoinRequest() {
  const btn = document.getElementById('join-btn');
  const hint = document.getElementById('join-hint');

  const teamId = document.getElementById('join-teamSelect')?.value || '';
  const name = document.getElementById('join-name')?.value.trim() || '';
  const discordRaw = document.getElementById('join-discord')?.value.trim() || '';
  const discord = sanitizeDiscord(discordRaw);
  const discordLower = discord.toLowerCase();

  hint.textContent = '';

  const errors = [];
  if (!teamId) errors.push('Choose a team');
  if (!name) errors.push('Your name required');
  if (!discord) errors.push('Discord required');

  if (errors.length) {
    hint.textContent = errors.join(' ');
    hint.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Sending…';

  try {
    // Discord uniqueness (local cache)
    if (isDiscordTaken(discordLower)) {
      hint.textContent = 'That Discord handle is already on a team or pending on another team.';
      hint.classList.add('error');
      return;
    }

    const teamRef = db.collection('teams').doc(teamId);
    const reqRef = teamRef.collection('requests').doc(discordLower);

    await db.runTransaction(async (tx) => {
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists) throw new Error('Team not found');

      const team = teamSnap.data();
      const members = getMembers(team);
      const pending = Array.isArray(team.pendingDiscords) ? team.pendingDiscords : [];

      if (members.length >= TEAM_SIZE) throw new Error('That team is full');
      if (pending.includes(discordLower)) throw new Error('You already requested to join this team');

      // Add request
      tx.set(reqRef, {
        name,
        discord,
        discordLower,
        status: 'pending',
        requestedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });

      tx.update(teamRef, {
        pendingDiscords: firebase.firestore.FieldValue.arrayUnion(discordLower),
        allDiscords: firebase.firestore.FieldValue.arrayUnion(discordLower)
      });
    });

    document.getElementById('join-team-form')?.reset();
    hint.textContent = 'Request sent! The team creator can accept it in “Manage join requests”.';
    hint.classList.remove('error');
    hint.classList.add('ok');

  } catch (err) {
    console.error('Join request error:', err);
    hint.textContent = (err && err.message) ? err.message : 'Error sending request.';
    hint.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Send request';
  }
}

async function loadManageRequests() {
  const btn = document.getElementById('manage-btn');
  const hint = document.getElementById('manage-hint');
  const area = document.getElementById('manage-area');

  const teamId = document.getElementById('manage-teamSelect')?.value || '';
  const discordRaw = document.getElementById('manage-discord')?.value.trim() || '';
  const discord = sanitizeDiscord(discordRaw);
  const discordLower = discord.toLowerCase();

  hint.textContent = '';
  area.innerHTML = '';

  if (!teamId || !discord) {
    hint.textContent = 'Choose a team and enter the creator Discord.';
    hint.classList.add('error');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Loading…';

  try {
    const teamRef = db.collection('teams').doc(teamId);
    const teamSnap = await teamRef.get();
    if (!teamSnap.exists) throw new Error('Team not found');

    const team = teamSnap.data();
    if ((team.creatorDiscordLower || '').toLowerCase() !== discordLower) {
      throw new Error('Creator Discord does not match this team.');
    }

    // Subscribe to pending requests
    if (manageUnsub) manageUnsub();
    manageUnsub = teamRef.collection('requests')
      .where('status', '==', 'pending')
      .orderBy('requestedAt', 'asc')
      .onSnapshot((snap) => {
        renderManageArea(teamId, team, snap.docs.map(d => ({ id: d.id, ...d.data() })));
      });

    hint.textContent = 'Loaded. Accept requests below.';
    hint.classList.remove('error');
    hint.classList.add('ok');

  } catch (err) {
    console.error('Manage load error:', err);
    hint.textContent = (err && err.message) ? err.message : 'Error loading requests.';
    hint.classList.add('error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load requests';
  }
}

function renderManageArea(teamId, teamData, requests) {
  const area = document.getElementById('manage-area');
  if (!area) return;

  const team = teamsCache.find(t => t.id === teamId) || teamData;
  const members = getMembers(team);
  const spotsLeft = Math.max(0, TEAM_SIZE - members.length);

  if (!requests.length) {
    area.innerHTML = `
      <div class="manage-card">
        <div class="manage-title">Pending requests</div>
        <div class="empty-state">No pending requests.</div>
      </div>
    `;
    return;
  }

  const rows = requests.map(r => `
    <div class="req-row">
      <div class="req-left">
        <div class="req-name">${esc(r.name || '')}</div>
        <div class="req-discord">@${esc(r.discord || '')}</div>
      </div>
      <div class="req-actions">
        <button class="btn small primary" data-action="accept" data-team-id="${teamId}" data-req-id="${esc(r.discordLower || r.id)}" ${spotsLeft <= 0 ? 'disabled' : ''}>
          Accept
        </button>
        <button class="btn small" data-action="decline" data-team-id="${teamId}" data-req-id="${esc(r.discordLower || r.id)}">
          Decline
        </button>
      </div>
    </div>
  `).join('');

  area.innerHTML = `
    <div class="manage-card">
      <div class="manage-title">Pending requests <span class="meta">${requests.length}</span></div>
      <div class="manage-sub">Spots left: <strong>${spotsLeft}</strong></div>
      <div class="req-list">${rows}</div>
      ${spotsLeft <= 0 ? `<div class="team-footnote">Team is full. Decline requests to free up spots.</div>` : ''}
    </div>
  `;
}

async function acceptRequest(teamId, reqId) {
  const hint = document.getElementById('manage-hint');
  hint.textContent = '';

  const teamRef = db.collection('teams').doc(teamId);
  const reqRef = teamRef.collection('requests').doc(reqId);

  try {
    await db.runTransaction(async (tx) => {
      const [teamSnap, reqSnap] = await Promise.all([tx.get(teamRef), tx.get(reqRef)]);
      if (!teamSnap.exists) throw new Error('Team not found');
      if (!reqSnap.exists) throw new Error('Request not found');

      const team = teamSnap.data();
      const req = reqSnap.data();

      if (req.status !== 'pending') throw new Error('Request already handled');

      const members = getMembers(team);
      const pendingDiscords = Array.isArray(team.pendingDiscords) ? team.pendingDiscords : [];
      const memberDiscords = Array.isArray(team.memberDiscords) ? team.memberDiscords : [];

      if (members.length >= TEAM_SIZE) throw new Error('Team is full');
      if (!pendingDiscords.includes(reqId)) throw new Error('Request not pending on this team');

      const newMember = { name: req.name, discord: req.discord, joinedAt: firebase.firestore.FieldValue.serverTimestamp() };

      tx.update(reqRef, {
        status: 'accepted',
        handledAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      tx.update(teamRef, {
        members: members.concat([newMember]),
        pendingDiscords: firebase.firestore.FieldValue.arrayRemove(reqId),
        memberDiscords: firebase.firestore.FieldValue.arrayUnion(reqId)
      });
    });

    hint.textContent = 'Accepted.';
    hint.classList.remove('error');
    hint.classList.add('ok');
  } catch (err) {
    console.error('Accept error:', err);
    hint.textContent = (err && err.message) ? err.message : 'Error accepting request.';
    hint.classList.add('error');
  }
}

async function declineRequest(teamId, reqId) {
  const hint = document.getElementById('manage-hint');
  hint.textContent = '';

  const teamRef = db.collection('teams').doc(teamId);
  const reqRef = teamRef.collection('requests').doc(reqId);

  try {
    await db.runTransaction(async (tx) => {
      const [teamSnap, reqSnap] = await Promise.all([tx.get(teamRef), tx.get(reqRef)]);
      if (!teamSnap.exists) throw new Error('Team not found');
      if (!reqSnap.exists) throw new Error('Request not found');

      const req = reqSnap.data();
      if (req.status !== 'pending') throw new Error('Request already handled');

      tx.update(reqRef, {
        status: 'declined',
        handledAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      tx.update(teamRef, {
        pendingDiscords: firebase.firestore.FieldValue.arrayRemove(reqId),
        allDiscords: firebase.firestore.FieldValue.arrayRemove(reqId)
      });
    });

    hint.textContent = 'Declined.';
    hint.classList.remove('error');
    hint.classList.add('ok');
  } catch (err) {
    console.error('Decline error:', err);
    hint.textContent = (err && err.message) ? err.message : 'Error declining request.';
    hint.classList.add('error');
  }
}

/* =========================
   Helpers
========================= */

function isDiscordTaken(discordLower) {
  if (!discordLower) return false;

  for (const t of teamsCache) {
    const all = getTeamDiscords(t);
    if (all.has(discordLower)) return true;
  }
  return false;
}

function getTeamDiscords(team) {
  const s = new Set();

  const addArr = (arr) => {
    if (!Array.isArray(arr)) return;
    arr.forEach(v => {
      if (typeof v === 'string' && v.trim()) s.add(v.toLowerCase());
    });
  };

  addArr(team.allDiscords);
  addArr(team.memberDiscords);
  addArr(team.pendingDiscords);

  const members = Array.isArray(team.members) ? team.members : (Array.isArray(team.players) ? team.players : []);
  members.forEach(m => {
    const d = (m.discord || m.Discord || '').toString().trim().replace(/^@+/, '').toLowerCase();
    if (d) s.add(d);
  });

  return s;
}

function sanitizeDiscord(input) {
  if (!input) return '';
  return input.trim().replace(/^@+/, '').replace(/\s+/g, '');
}

// Escape HTML
function esc(str) {
  const div = document.createElement('div');
  div.textContent = String(str ?? '');
  return div.innerHTML;
}
