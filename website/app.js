/*
  Codenames Teams UI
  - Home: set name + see teams left
  - Teams: list teams, click to view members + request to join
  - My Team: create team, rename (creator), kick (creator), requests (creator)
*/

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

firebase.initializeApp(firebaseConfig);
const db = firebase.firestore();

const LS_USER_ID = 'ct_userId_v1';
const LS_USER_NAME = 'ct_userName_v1';

let teamsCache = [];
let openTeamId = null;

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initName();
  initTeamModal();
  initCreateTeamModal();
  initMyTeamControls();
  listenToTeams();
});

/* =========================
   Tabs
========================= */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;
      tabs.forEach(t => t.classList.toggle('active', t === tab));
      panels.forEach(p => p.classList.toggle('active', p.id === panelId));
    });
  });
}

/* =========================
   User identity (device-local)
========================= */
function getUserId() {
  let id = safeLSGet(LS_USER_ID);
  if (!id) {
    id = (crypto?.randomUUID?.() || ('u_' + Math.random().toString(16).slice(2) + Date.now().toString(16)));
    safeLSSet(LS_USER_ID, id);
  }
  return id;
}

function getUserName() {
  return (safeLSGet(LS_USER_NAME) || '').trim();
}

function setUserName(name) {
  safeLSSet(LS_USER_NAME, (name || '').trim());
  refreshNameUI();
  // If user is a member/creator, update their stored display name in their team doc (best-effort)
  const st = computeUserState(teamsCache);
  if (st?.team && st?.teamId) {
    // Only update accepted member entry; we avoid touching pending requests (name is shown from request itself)
    updateMemberName(st.teamId, getUserId(), getUserName());
  }
}

function initName() {
  // Home form
  const form = document.getElementById('name-form');
  const input = document.getElementById('name-input');
  const hint = document.getElementById('name-hint');

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = (input?.value || '').trim();
    if (!v) {
      if (hint) hint.textContent = 'Please enter a name.';
      return;
    }
    if (hint) hint.textContent = '';
    setUserName(v);
  });

  // Double-click editing (works on desktop + mobile)
  wireInlineEdit({
    displayEl: document.getElementById('name-saved-display'),
    inputEl: document.getElementById('name-saved-input'),
    getValue: () => getUserName(),
    onCommit: (v) => setUserName(v),
  });

  wireInlineEdit({
    displayEl: document.getElementById('user-name-display'),
    inputEl: document.getElementById('user-name-input'),
    getValue: () => getUserName(),
    onCommit: (v) => setUserName(v),
  });

  refreshNameUI();
}

function refreshNameUI() {
  const name = getUserName();
  const cardForm = document.getElementById('name-form');
  const saved = document.getElementById('name-saved');
  const savedDisplay = document.getElementById('name-saved-display');
  const headerDisplay = document.getElementById('user-name-display');

  if (savedDisplay) savedDisplay.textContent = name || '—';
  if (headerDisplay) headerDisplay.textContent = name || '—';

  if (cardForm && saved) {
    cardForm.style.display = name ? 'none' : 'block';
    saved.style.display = name ? 'block' : 'none';
  }

  // Also update UI that depends on name (join buttons etc)
  renderTeams(teamsCache);
  renderMyTeam(teamsCache);
}

/* =========================
   Real-time data
========================= */
function listenToTeams() {
  db.collection('teams')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      teamsCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      updateHomeStats(teamsCache);
      renderTeams(teamsCache);
      renderMyTeam(teamsCache);
      // If a modal is open, refresh its contents
      if (openTeamId) openTeamModal(openTeamId);
    }, (err) => {
      console.error('Team listener error:', err);
      setHint('teams-hint', 'Error loading teams.');
    });
}

function updateHomeStats(teams) {
  const teamCount = teams.length;
  const spots = Math.max(0, MAX_TEAMS - teamCount);
  const players = teams.reduce((sum, t) => sum + getMembers(t).length, 0);

  setText('spots-left', spots);
  setText('players-count', players);
  setText('team-count', teamCount);
  setText('team-count-pill', `${teamCount}/${MAX_TEAMS}`);
}

/* =========================
   State helpers
========================= */
function getMembers(team) {
  return Array.isArray(team.members) ? team.members : [];
}

function getPending(team) {
  return Array.isArray(team.pending) ? team.pending : [];
}

function findUserInMembers(team, userId) {
  return getMembers(team).find(m => m?.userId === userId);
}

function findUserInPending(team, userId) {
  return getPending(team).find(r => r?.userId === userId);
}

function computeUserState(teams) {
  const userId = getUserId();
  let team = null;
  let pendingTeam = null;
  for (const t of teams) {
    if (findUserInMembers(t, userId)) team = t;
    if (findUserInPending(t, userId)) pendingTeam = t;
  }
  const isCreator = !!(team && team.creatorUserId && team.creatorUserId === userId);
  return {
    userId,
    name: getUserName(),
    team,
    teamId: team?.id || null,
    isCreator,
    pendingTeam,
    pendingTeamId: pendingTeam?.id || null,
  };
}

/* =========================
   Teams page
========================= */
function renderTeams(teams) {
  const container = document.getElementById('teams-list');
  if (!container) return;

  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state">No teams yet</div>';
    return;
  }

  const st = computeUserState(teams);

  container.innerHTML = teams.map((t, idx) => {
    const members = getMembers(t);
    const pending = getPending(t);
    const full = members.length >= TEAM_SIZE;
    const myBadge = st.teamId === t.id ? '<span class="meta pill">my team</span>' : '';
    const pendingBadge = st.pendingTeamId === t.id ? '<span class="meta pill pending">requested</span>' : '';
    return `
      <button class="team-card clickable" type="button" data-open-team="${esc(t.id)}">
        <div class="team-summary no-details">
          <div class="team-left">
            <div class="team-rank">#${idx + 1}</div>
            <div class="team-name-wrap">
              <span class="team-name">${esc(t.teamName || 'Unnamed')}</span>
            </div>
          </div>
          <div class="team-right">
            <span class="meta">${members.length}/${TEAM_SIZE}</span>
            ${pending.length ? `<span class="meta pill pending">${pending.length} pending</span>` : ''}
            ${myBadge}${pendingBadge}
            ${full ? '<span class="meta pill">full</span>' : ''}
          </div>
        </div>
      </button>
    `;
  }).join('');

  container.querySelectorAll('[data-open-team]')?.forEach(btn => {
    btn.addEventListener('click', () => {
      const teamId = btn.getAttribute('data-open-team');
      if (teamId) openTeamModal(teamId);
    });
  });
}

/* =========================
   Team modal (view + request)
========================= */
function initTeamModal() {
  const closeBtn = document.getElementById('team-modal-close');
  const modal = document.getElementById('team-modal');
  closeBtn?.addEventListener('click', closeTeamModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeTeamModal();
  });

  document.getElementById('team-modal-join')?.addEventListener('click', async () => {
    if (!openTeamId) return;
    await requestToJoin(openTeamId);
  });
}

function openTeamModal(teamId) {
  openTeamId = teamId;
  const modal = document.getElementById('team-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderTeamModal(teamId);
}

function closeTeamModal() {
  openTeamId = null;
  const modal = document.getElementById('team-modal');
  if (modal) modal.style.display = 'none';
  setHint('team-modal-hint', '');
}

function renderTeamModal(teamId) {
  const team = teamsCache.find(t => t.id === teamId);
  if (!team) return;

  setText('team-modal-title', team.teamName || 'Team');

  const membersEl = document.getElementById('team-modal-members');
  const members = getMembers(team);
  if (membersEl) {
    membersEl.innerHTML = members.length
      ? members.map(m => `
          <div class="player-row">
            <div class="player-left">
              <span class="player-name">${esc(m.name || '—')}</span>
            </div>
          </div>
        `).join('')
      : '<div class="empty-state">No members yet</div>';
  }

  const st = computeUserState(teamsCache);
  const joinBtn = document.getElementById('team-modal-join');
  const full = members.length >= TEAM_SIZE;
  const iAmMember = st.teamId === teamId;
  const iAmPendingHere = st.pendingTeamId === teamId;
  const iAmBusy = !!(st.teamId || st.pendingTeamId);
  const noName = !st.name;

  let label = 'Request to join';
  let disabled = false;
  let hint = '';

  if (noName) {
    disabled = true;
    hint = 'Set your name on Home first.';
  } else if (iAmMember) {
    disabled = true;
    label = 'You are on this team';
  } else if (iAmPendingHere) {
    disabled = true;
    label = 'Request sent';
  } else if (iAmBusy) {
    disabled = true;
    hint = 'You are already on a team (or have a pending request).';
  } else if (full) {
    disabled = true;
    label = 'Team full';
  }

  if (joinBtn) {
    joinBtn.disabled = disabled;
    joinBtn.classList.toggle('disabled', disabled);
    joinBtn.textContent = label;
  }
  setHint('team-modal-hint', hint);
}

async function requestToJoin(teamId) {
  const st = computeUserState(teamsCache);
  if (!st.name) {
    setHint('team-modal-hint', 'Set your name on Home first.');
    return;
  }
  if (st.teamId || st.pendingTeamId) {
    setHint('team-modal-hint', 'You are already on a team (or have a pending request).');
    return;
  }

  setHint('team-modal-hint', 'Sending…');

  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      const pending = getPending(t);
      if (members.length >= TEAM_SIZE) throw new Error('Team is full.');
      if (pending.some(r => r.userId === st.userId)) return;
      tx.update(ref, {
        pending: pending.concat([{ userId: st.userId, name: st.name, requestedAt: firebase.firestore.FieldValue.serverTimestamp() }])
      });
    });
    setHint('team-modal-hint', 'Request sent.');
  } catch (e) {
    console.error(e);
    setHint('team-modal-hint', e?.message || 'Could not send request.');
  }
}

/* =========================
   My Team page
========================= */
function initMyTeamControls() {
  document.getElementById('open-create-team')?.addEventListener('click', () => {
    openCreateTeamModal();
  });

  // Rename team (creator)
  wireInlineEdit({
    displayEl: document.getElementById('myteam-name'),
    inputEl: document.getElementById('myteam-name-input'),
    getValue: () => {
      const st = computeUserState(teamsCache);
      return st?.team?.teamName || '';
    },
    onCommit: async (v) => {
      const st = computeUserState(teamsCache);
      if (!st.isCreator || !st.teamId) return;
      await db.collection('teams').doc(st.teamId).update({ teamName: v });
    }
  });
}

function renderMyTeam(teams) {
  const st = computeUserState(teams);
  const createBtn = document.getElementById('open-create-team');
  const card = document.getElementById('myteam-card');
  const membersEl = document.getElementById('myteam-members');
  const actionsEl = document.getElementById('myteam-actions');
  const requestsBox = document.getElementById('myteam-requests');
  const requestsList = document.getElementById('myteam-requests-list');
  const sub = document.getElementById('myteam-subtitle');

  const hasTeam = !!st.teamId;
  if (createBtn) {
    const disableCreate = !st.name || hasTeam || !!st.pendingTeamId || teams.length >= MAX_TEAMS;
    createBtn.disabled = disableCreate;
    createBtn.classList.toggle('disabled', disableCreate);
  }
  if (sub) {
    if (!st.name) sub.textContent = 'Set your name first (Home tab).';
    else if (hasTeam) sub.textContent = st.isCreator ? 'Double click the team name to rename. You can kick teammates and manage requests.' : 'You are on a team.';
    else sub.textContent = 'Create a team or request to join one from the Teams tab.';
  }

  if (!card) return;

  if (!hasTeam) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  setText('myteam-name', st.team.teamName || 'Unnamed');
  setText('myteam-size', `${getMembers(st.team).length}/${TEAM_SIZE}`);

  // Members list
  const members = getMembers(st.team);
  if (membersEl) {
    membersEl.innerHTML = members.map(m => {
      const isMe = m.userId === st.userId;
      const isOwner = st.team.creatorUserId === m.userId;
      const canKick = st.isCreator && !isOwner;
      return `
        <div class="player-row">
          <div class="player-left">
            <span class="player-name">${esc(m.name || '—')}${isOwner ? ' <span class="pill">creator</span>' : ''}${isMe ? ' <span class="pill">you</span>' : ''}</span>
          </div>
          ${canKick ? `<button class="icon-btn danger" type="button" data-kick="${esc(m.userId)}" title="Kick">×</button>` : ''}
        </div>
      `;
    }).join('');

    membersEl.querySelectorAll('[data-kick]')?.forEach(btn => {
      btn.addEventListener('click', () => {
        const uid = btn.getAttribute('data-kick');
        if (uid) kickMember(st.teamId, uid);
      });
    });
  }

  // Actions
  if (actionsEl) {
    const requestsBtn = (st.isCreator)
      ? `<button class="btn small" type="button" id="toggle-requests">Requests (${getPending(st.team).length})</button>`
      : '';
    actionsEl.innerHTML = `${requestsBtn}`;

    actionsEl.querySelector('#toggle-requests')?.addEventListener('click', () => {
      if (!requestsBox) return;
      const isOpen = requestsBox.style.display !== 'none';
      requestsBox.style.display = isOpen ? 'none' : 'block';
    });
  }

  // Requests (creator)
  if (requestsBox && requestsList) {
    if (!st.isCreator) {
      requestsBox.style.display = 'none';
      requestsList.innerHTML = '';
    } else {
      const pending = getPending(st.team);
      requestsList.innerHTML = pending.length
        ? pending.map(r => {
            return `
              <div class="request-row">
                <div class="player-left">
                  <span class="player-name">${esc(r.name || '—')}</span>
                </div>
                <div class="request-actions">
                  <button class="btn primary small" type="button" data-accept="${esc(r.userId)}">Accept</button>
                  <button class="btn danger small" type="button" data-decline="${esc(r.userId)}">Decline</button>
                </div>
              </div>
            `;
          }).join('')
        : '<div class="empty-state">No requests</div>';

      requestsList.querySelectorAll('[data-accept]')?.forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.getAttribute('data-accept');
          if (uid) acceptRequest(st.teamId, uid);
        });
      });
      requestsList.querySelectorAll('[data-decline]')?.forEach(btn => {
        btn.addEventListener('click', () => {
          const uid = btn.getAttribute('data-decline');
          if (uid) declineRequest(st.teamId, uid);
        });
      });
    }
  }
}

/* =========================
   Create team
========================= */
function initCreateTeamModal() {
  const modal = document.getElementById('create-team-modal');
  document.getElementById('create-team-close')?.addEventListener('click', closeCreateTeamModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeCreateTeamModal();
  });

  document.getElementById('create-team-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await handleCreateTeam();
  });
}

function openCreateTeamModal() {
  setHint('create-team-hint', '');
  const modal = document.getElementById('create-team-modal');
  if (modal) modal.style.display = 'flex';
  const input = document.getElementById('create-teamName');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function closeCreateTeamModal() {
  const modal = document.getElementById('create-team-modal');
  if (modal) modal.style.display = 'none';
}

async function handleCreateTeam() {
  const st = computeUserState(teamsCache);
  if (!st.name) {
    setHint('create-team-hint', 'Set your name on Home first.');
    return;
  }
  if (st.teamId || st.pendingTeamId) {
    setHint('create-team-hint', 'You are already on a team (or have a pending request).');
    return;
  }
  if (teamsCache.length >= MAX_TEAMS) {
    setHint('create-team-hint', 'No team slots left.');
    return;
  }

  const nameInput = document.getElementById('create-teamName');
  const teamName = (nameInput?.value || '').trim();
  if (!teamName) {
    setHint('create-team-hint', 'Enter a team name.');
    return;
  }

  setHint('create-team-hint', 'Creating…');

  try {
    await db.collection('teams').add({
      teamName,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      creatorUserId: st.userId,
      creatorName: st.name,
      members: [{ userId: st.userId, name: st.name }],
      pending: []
    });

    setHint('create-team-hint', 'Created!');
    closeCreateTeamModal();
    // Switch to My Team tab
    activatePanel('panel-myteam');
  } catch (e) {
    console.error(e);
    setHint('create-team-hint', 'Could not create team.');
  }
}

/* =========================
   Team management actions
========================= */
async function acceptRequest(teamId, userId) {
  const st = computeUserState(teamsCache);
  if (!st.isCreator || st.teamId !== teamId) return;

  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      const pending = getPending(t);
      if (members.length >= TEAM_SIZE) throw new Error('Team is full.');

      const req = pending.find(r => r.userId === userId);
      if (!req) return;

      const newPending = pending.filter(r => r.userId !== userId);
      const newMembers = members.concat([{ userId: req.userId, name: req.name || '—' }]);
      tx.update(ref, { pending: newPending, members: newMembers });
    });
  } catch (e) {
    console.error(e);
    setHint('teams-hint', e?.message || 'Could not accept request.');
  }
}

async function declineRequest(teamId, userId) {
  const st = computeUserState(teamsCache);
  if (!st.isCreator || st.teamId !== teamId) return;

  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const pending = getPending(t);
      tx.update(ref, { pending: pending.filter(r => r.userId !== userId) });
    });
  } catch (e) {
    console.error(e);
  }
}

async function kickMember(teamId, userId) {
  const st = computeUserState(teamsCache);
  if (!st.isCreator || st.teamId !== teamId) return;
  if (userId === st.userId) return;

  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      tx.update(ref, { members: members.filter(m => m.userId !== userId) });
    });
  } catch (e) {
    console.error(e);
  }
}

async function updateMemberName(teamId, userId, name) {
  if (!teamId || !userId || !name) return;
  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) return;
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      const idx = members.findIndex(m => m.userId === userId);
      if (idx === -1) return;
      const updated = members.slice();
      updated[idx] = { ...updated[idx], name };
      tx.update(ref, { members: updated });
      // keep creatorName in sync if creator updated
      if (t.creatorUserId === userId) {
        tx.update(ref, { creatorName: name });
      }
    });
  } catch (e) {
    // best-effort
    console.warn('Could not update member name', e);
  }
}

/* =========================
   Inline editing helper
========================= */
function wireInlineEdit({ displayEl, inputEl, getValue, onCommit }) {
  if (!displayEl || !inputEl) return;

  const startEdit = () => {
    const val = (getValue?.() || '').trim();
    inputEl.value = val;
    displayEl.style.display = 'none';
    inputEl.style.display = 'block';
    inputEl.focus();
    inputEl.select();
  };

  const stopEdit = async (commit) => {
    const next = (inputEl.value || '').trim();
    inputEl.style.display = 'none';
    displayEl.style.display = 'block';
    if (commit && next) {
      try { await onCommit?.(next); } catch (_) {}
    }
    // Always refresh display text from source of truth
    displayEl.textContent = (getValue?.() || '').trim() || '—';
  };

  // Double-click desktop
  displayEl.addEventListener('dblclick', startEdit);

  // Double-tap mobile fallback
  let lastTap = 0;
  displayEl.addEventListener('touchend', () => {
    const now = Date.now();
    if (now - lastTap < 350) startEdit();
    lastTap = now;
  }, { passive: true });

  inputEl.addEventListener('blur', () => stopEdit(true));
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); stopEdit(true); }
    if (e.key === 'Escape') { e.preventDefault(); stopEdit(false); }
  });
}

/* =========================
   Small DOM helpers
========================= */
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = String(value);
}

function setHint(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '';
}

function activatePanel(panelId) {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const tab = Array.from(tabs).find(t => t.dataset.panel === panelId);
  if (tab) {
    tabs.forEach(t => t.classList.toggle('active', t === tab));
    panels.forEach(p => p.classList.toggle('active', p.id === panelId));
  }
}

function esc(s) {
  return String(s || '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function safeLSGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function safeLSSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}
