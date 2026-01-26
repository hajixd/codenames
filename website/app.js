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
let roleState = { mode: null, isCreator: false, creatorTeamId: null, memberTeamId: null, pendingTeamId: null };
let lastAppliedMode = null;

let manageUnsub = null;

const OWNER_TEAM_STORAGE = 'ownerTeamId';
const USER_DISCORD_STORAGE = 'userDiscord';
const USER_NAME_STORAGE = 'userName';
const FIRST_LOAD_CHOICE = 'firstLoadChoiceV1';
const USER_MODE_STORAGE = 'userModeV2';

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initForms();
  initFirstLoadChooser();
  initModeSwitcher();
  initRosterInlineEditing();
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
  setActivePanel(defaultPanel, { tabs, panels });

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;

      setActivePanel(panelId, { tabs, panels });
    });
  });
}

function setActivePanel(panelId, ctx) {
  const tabs = ctx?.tabs || document.querySelectorAll('.tab');
  const panels = ctx?.panels || document.querySelectorAll('.panel');
  tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === panelId));
  panels.forEach(p => p.classList.toggle('active', p.id === panelId));
}

/* =========================
   First-load chooser
========================= */
function initFirstLoadChooser() {
  const modal = document.getElementById('mode-modal');
  const btnCreate = document.getElementById('mode-create');
  const btnJoin = document.getElementById('mode-join');
  const btnSkip = document.getElementById('mode-skip');

  if (!modal || !btnCreate || !btnJoin || !btnSkip) return;

  // Show once per browser/device
  const alreadyChosen = safeLSGet(FIRST_LOAD_CHOICE) || safeLSGet(USER_MODE_STORAGE);
  if (!alreadyChosen) {
    modal.style.display = 'flex';
  }

  const close = () => { modal.style.display = 'none'; };

  const openAccordions = (mode) => {
    const c = document.getElementById('create-accordion');
    const j = document.getElementById('join-accordion');
    const m = document.getElementById('manage-accordion');
    if (mode === 'create') {
      if (c) c.open = true;
      if (j) j.open = false;
      // Keep manage visible but collapsed by default
      if (m) m.open = false;
      c?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    if (mode === 'join') {
      if (c) c.open = false;
      if (j) j.open = true;
      if (m) m.open = false;
      j?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  btnCreate.addEventListener('click', () => {
    safeLSSet(FIRST_LOAD_CHOICE, 'create');
    setUserMode('creator');
    applyModeUI('creator');
    close();
    setActivePanel('panel-register');
    // Wait a tick so the panel is visible before we scroll
    setTimeout(() => openAccordions('create'), 50);
  });

  btnJoin.addEventListener('click', () => {
    safeLSSet(FIRST_LOAD_CHOICE, 'join');
    setUserMode('joiner');
    applyModeUI('joiner');
    close();
    setActivePanel('panel-register');
    setTimeout(() => openAccordions('join'), 50);
  });

  btnSkip.addEventListener('click', () => {
    safeLSSet(FIRST_LOAD_CHOICE, 'skip');
    // default to joiner UI
    setUserMode('joiner');
    applyModeUI('joiner');
    close();
  });
}

function initModeSwitcher() {
  // Get all mode buttons (desktop + mobile)
  const creatorBtns = [
    document.getElementById('mode-set-creator-desktop'),
    document.getElementById('mode-set-creator-mobile')
  ].filter(Boolean);

  const joinerBtns = [
    document.getElementById('mode-set-joiner-desktop'),
    document.getElementById('mode-set-joiner-mobile')
  ].filter(Boolean);

  const handleCreatorClick = () => {
    setUserMode('creator');
    applyModeUI('creator');
    safeLSSet(FIRST_LOAD_CHOICE, 'create');
    setActivePanel('panel-register');
    const c = document.getElementById('create-accordion');
    const m = document.getElementById('manage-accordion');
    if (roleState.isCreator) {
      if (m) { m.open = true; m.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    } else {
      if (c) { c.open = true; c.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    }
  };

  const handleJoinerClick = () => {
    // Creators should not switch to joiner mode (it becomes confusing / unsafe)
    if (roleState.isCreator) return;
    setUserMode('joiner');
    applyModeUI('joiner');
    safeLSSet(FIRST_LOAD_CHOICE, 'join');
    setActivePanel('panel-register');
    const j = document.getElementById('join-accordion');
    if (j) { j.open = true; j.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  };

  creatorBtns.forEach(btn => btn.addEventListener('click', handleCreatorClick));
  joinerBtns.forEach(btn => btn.addEventListener('click', handleJoinerClick));
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
      computeRoleState(teamsCache);
      updateMyStatus(teamsCache);
      renderTeams(teamsCache);
      populateTeamSelects(teamsCache);
    }, (err) => {
      console.error('Team listener error:', err);
      // If index missing, show helpful message
      if (err.code === 'failed-precondition') {
        console.log('Create index at:', err.message);
      }
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

  const isCreator = !!(roleState && roleState.isCreator && roleState.creatorTeamId);
  const myTeamId = roleState ? roleState.creatorTeamId : null;

  const html = teams.map((team, i) => {
    const members = getMembers(team);
    const pendingCount = Array.isArray(team.pendingDiscords) ? team.pendingDiscords.length : 0;

    const isMyTeam = isCreator && myTeamId && team.id === myTeamId && isOwnerOf(team.id);

    const memberRows = members.length
      ? members.map(m => {
          const d = sanitizeDiscord(m.discord || '');
          const dl = d.toLowerCase();
          const creatorLower = String(team.creatorDiscordLower || '').toLowerCase();
          const isOwner = dl && (dl === creatorLower);
          const removeBtn = (isMyTeam && !isOwner)
            ? `<button class="icon-btn danger" type="button" title="Remove" aria-label="Remove member" data-action="kick" data-team-id="${team.id}" data-req-id="${esc(dl)}">×</button>`
            : '';
          return `
            <div class="player-row">
              <div class="player-left">
                <span class="player-name">${esc(m.name || '')}${isOwner ? ' <span class="pill">owner</span>' : ''}</span>
                <span class="discord">@${esc(d || '')}</span>
              </div>
              ${removeBtn}
            </div>
          `;
        }).join('')
      : '<div class="empty-state">No accepted members yet</div>';

    const ownerControls = isMyTeam ? `
      <div class="team-owner-controls">
        <div class="team-section-title">Owner Controls</div>
        <div class="owner-actions-row">
          <button class="btn danger small" type="button" data-action="delete-team" data-team-id="${team.id}" data-req-id="__">Delete Team</button>
        </div>
        <div class="small-note">Tip: double click the team name to rename it.</div>
      </div>
    ` : '';

    return `
      <div class="team-card ${isMyTeam ? 'my-team' : ''}">
        <details class="team-details">
          <summary class="team-summary">
            <div class="team-left">
              <div class="team-rank">#${i + 1}</div>
              <div class="team-name-wrap">
                <span class="team-name ${isMyTeam ? 'editable' : ''}" data-team-id="${team.id}">${esc(team.teamName || 'Unnamed')}</span>
                ${isMyTeam ? `<input class="team-name-input input" type="text" value="${esc(team.teamName || '')}" data-team-id="${team.id}" style="display:none;" />` : ''}
              </div>
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
            ${ownerControls}
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

  // Owner actions delegation (Manage / Requests / Settings)
  bindOwnerActions('manage-area');
  bindOwnerActions('requests-area');
  bindOwnerActions('settings-area');
  // Roster actions (kick/delete buttons)
  bindOwnerActions('teams-list');

  // Member actions (leave team / cancel request)
  document.getElementById('my-status')?.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const teamId = btn.dataset.teamId;
    const discordLower = btn.dataset.discordLower;
    if (!teamId || !discordLower) return;

    if (action === 'leave') leaveTeam(teamId, discordLower);
    if (action === 'cancel') cancelJoinRequest(teamId, discordLower);
    if (action === 'manage') {
      setActivePanel('panel-register');
      const m = document.getElementById('manage-accordion');
      if (m) {
        m.open = true;
        m.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
    if (action === 'join') {
      setActivePanel('panel-register');
      const j = document.getElementById('join-accordion');
      if (j) {
        j.open = true;
        j.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  });

  // Prefill known user info (stored on this device)
  const u = getStoredUser();
  if (u.discord) {
    const cd = document.getElementById('create-discord');
    const jd = document.getElementById('join-discord');
    if (cd && !cd.value) cd.value = '@' + u.discord;
    if (jd && !jd.value) jd.value = '@' + u.discord;
  }
  if (u.name) {
    const cn = document.getElementById('create-name');
    const jn = document.getElementById('join-name');
    if (cn && !cn.value) cn.value = u.name;
    if (jn && !jn.value) jn.value = u.name;
  }
}



function bindOwnerActions(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;

  el.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;

    const action = btn.dataset.action;
    const teamId = btn.dataset.teamId;
    const reqId = btn.dataset.reqId;
    const inputId = btn.dataset.inputId;

    if (!teamId) return;

    const panel = el.closest('.panel');
    const hintEl = panel ? panel.querySelector('.hint') : null;

    if (action === 'accept') acceptRequest(teamId, reqId, hintEl);
    if (action === 'decline') declineRequest(teamId, reqId, hintEl);
    if (action === 'kick') kickMember(teamId, reqId, hintEl);
    if (action === 'rename-team') renameTeam(teamId, inputId, hintEl);
    if (action === 'delete-team') deleteTeam(teamId, hintEl);
  });
}

function initRosterInlineEditing() {
  const container = document.getElementById('teams-list');
  if (!container) return;

  // Inline rename: double click team name (owner team only)
  container.addEventListener('dblclick', (e) => {
    const nameEl = e.target.closest('.team-name.editable');
    if (!nameEl) return;

    const teamId = nameEl.dataset.teamId;
    if (!teamId || !isOwnerOf(teamId)) return;

    const input = nameEl.parentElement?.querySelector('.team-name-input');
    if (!input) return;

    nameEl.style.display = 'none';
    input.style.display = '';
    input.value = (nameEl.textContent || '').trim();
    input.focus();
    input.select();
  });

  // Commit / cancel rename
  container.addEventListener('keydown', async (e) => {
    const input = e.target.closest('.team-name-input');
    if (!input) return;

    const teamId = input.dataset.teamId;
    const span = input.parentElement?.querySelector('.team-name');
    if (!teamId || !span) return;

    if (e.key === 'Escape') {
      input.style.display = 'none';
      span.style.display = '';
      span.focus?.();
      return;
    }

    if (e.key === 'Enter') {
      e.preventDefault();
      const newName = (input.value || '').trim();
      input.blur();
      await renameTeamTo(teamId, newName, document.getElementById('roster-hint'));
      input.style.display = 'none';
      span.style.display = '';
    }
  });

  container.addEventListener('blur', async (e) => {
    const input = e.target.closest('.team-name-input');
    if (!input) return;

    const teamId = input.dataset.teamId;
    const span = input.parentElement?.querySelector('.team-name');
    if (!teamId || !span) return;

    const newName = (input.value || '').trim();
    input.style.display = 'none';
    span.style.display = '';

    // Only submit if changed
    const oldName = (span.textContent || '').trim();
    if (newName && newName !== oldName) {
      await renameTeamTo(teamId, newName, document.getElementById('roster-hint'));
    }
  }, true);
}

async function renameTeamTo(teamId, newName, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  if (hint) hint.textContent = '';

  if (!isOwnerOf(teamId)) {
    if (hint) { hint.textContent = 'You are not the owner of this team.'; hint.classList.add('error'); }
    return;
  }

  const name = (newName || '').trim();
  if (!name) {
    if (hint) { hint.textContent = 'Team name cannot be empty.'; hint.classList.add('error'); }
    return;
  }

  const teamRef = db.collection('teams').doc(teamId);

  try {
    const existing = await db.collection('teams')
      .where('teamNameLower', '==', name.toLowerCase())
      .get();

    const conflicts = existing.docs.filter(d => d.id !== teamId);
    if (conflicts.length > 0) throw new Error('That team name is already taken.');

    await teamRef.update({ teamName: name, teamNameLower: name.toLowerCase() });

    if (hint) { hint.textContent = 'Team renamed.'; hint.classList.remove('error'); hint.classList.add('ok'); }
  } catch (err) {
    console.error('Rename error:', err);
    if (hint) { hint.textContent = err.message || 'Could not rename team.'; hint.classList.add('error'); }
  }
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

    const docRef = await db.collection('teams').add({
      teamName,
      teamNameLower: teamName.toLowerCase(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      creatorName: name,
      creatorDiscord: discord,
      creatorDiscordLower: discordLower,
      members: [
        { name, discord, joinedAt: new Date() }
      ],
      memberDiscords: [discordLower],
      pendingDiscords: [],
      allDiscords: [discordLower]
    });

    // Save this device as the owner
    if (docRef?.id) setOwnerTeamId(docRef.id);

    // Remember who you are on this device (used for status + leaving)
    setStoredUser({ name, discord });

    // You're now a creator on this device
    setUserMode('creator');
    applyModeUI('creator');

    // reset form
    document.getElementById('create-team-form')?.reset();

    hint.textContent = 'Team created! You can manage your team from this device.';
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

    // Remember who you are on this device (used for status + leaving)
    setStoredUser({ name, discord });

    // Keep joiner mode
    if (!roleState.isCreator) { setUserMode('joiner'); applyModeUI('joiner'); }

    document.getElementById('join-team-form')?.reset();
    hint.textContent = 'Request sent! The team owner will review your request.';
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

function autoLoadManagePanel(teamId) {
  if (!teamId || !isOwnerOf(teamId)) return;

  const team = teamsCache.find(t => t.id === teamId);
  if (!team) return;

  const teamRef = db.collection('teams').doc(teamId);

  // Unsubscribe from previous listener if any
  if (manageUnsub) manageUnsub();

  // Subscribe to pending requests
  manageUnsub = teamRef.collection('requests')
    .where('status', '==', 'pending')
    .orderBy('requestedAt', 'asc')
    .onSnapshot((snap) => {
      const freshTeam = teamsCache.find(t => t.id === teamId) || team;
      renderOwnerViews(teamId, freshTeam, snap.docs.map(d => ({ id: d.id, ...d.data() })));
    });
}

function renderOwnerViews(teamId, teamData, requests) {
  // Legacy manage accordion area (kept for back-compat)
  if (document.getElementById('manage-area')) {
    renderManageArea(teamId, teamData, requests);
  }

  const team = teamsCache.find(t => t.id === teamId) || teamData;
  if (!team) return;

  const reqMount = document.getElementById('requests-area');
  if (reqMount) reqMount.innerHTML = buildOwnerRequestsHTML(teamId, team, requests);

  const setMount = document.getElementById('settings-area');
  if (setMount) setMount.innerHTML = buildOwnerSettingsHTML(teamId, team, 'settings');
}

function renderManageArea(teamId, teamData, requests) {
  const area = document.getElementById('manage-area');
  if (!area) return;

  const team = teamsCache.find(t => t.id === teamId) || teamData;
  if (!team) return;

  // Remember active tab
  const activeTab = area.dataset.activeTab || 'requests';
  const requestsBadge = (requests && requests.length) ? `<span class=\"tab-badge\">${requests.length}</span>` : '';

  const tabsHtml = `
    <div class=\"manage-tabs\">
      <button class=\"manage-tab ${activeTab === 'requests' ? 'active' : ''}\" data-tab=\"requests\">Requests${requestsBadge}</button>
      <button class=\"manage-tab ${activeTab === 'settings' ? 'active' : ''}\" data-tab=\"settings\">Team Settings</button>
    </div>
  `;

  const requestsTab = `
    <div class=\"manage-tab-content ${activeTab === 'requests' ? 'active' : ''}\" data-tab-content=\"requests\">
      ${buildOwnerRequestsHTML(teamId, team, requests)}
    </div>
  `;

  const settingsTab = `
    <div class=\"manage-tab-content ${activeTab === 'settings' ? 'active' : ''}\" data-tab-content=\"settings\">
      ${buildOwnerSettingsHTML(teamId, team, 'manage')}
    </div>
  `;

  area.innerHTML = tabsHtml + requestsTab + settingsTab;
  area.dataset.activeTab = activeTab;

  // Add tab click handlers
  area.querySelectorAll('.manage-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;
      area.dataset.activeTab = tabName;

      area.querySelectorAll('.manage-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
      area.querySelectorAll('.manage-tab-content').forEach(c => c.classList.toggle('active', c.dataset.tabContent === tabName));
    });
  });
}

function buildOwnerRequestsHTML(teamId, team, requests) {
  const members = getMembers(team);
  const spotsLeft = Math.max(0, TEAM_SIZE - members.length);

  if (!Array.isArray(requests) || requests.length === 0) {
    return `
      <div class=\"tab-empty\">
        <div class=\"tab-empty-icon\">📭</div>
        <div class=\"tab-empty-text\">No pending requests</div>
        <div class=\"tab-empty-sub\">When someone requests to join, they'll appear here</div>
      </div>
    `;
  }

  const list = requests.map(r => {
    const disabled = spotsLeft <= 0 ? 'disabled' : '';
    const when = r.requestedAt?.toDate ? r.requestedAt.toDate() : null;
    const timeAgo = when ? formatTimeAgo(when) : '';
    return `
      <div class=\"req-row\">
        <div class=\"req-left\">
          <div class=\"req-name\">${esc(r.name || 'Player')}</div>
          <div class=\"req-meta\">@${esc(r.discord || r.discordLower || '')}${timeAgo ? ` • ${timeAgo}` : ''}</div>
        </div>
        <div class=\"req-actions\">
          <button class=\"btn small success\" type=\"button\" data-action=\"accept\" data-team-id=\"${teamId}\" data-req-id=\"${esc(r.discordLower)}\" ${disabled}>Accept</button>
          <button class=\"btn small danger\" type=\"button\" data-action=\"decline\" data-team-id=\"${teamId}\" data-req-id=\"${esc(r.discordLower)}\">Decline</button>
        </div>
      </div>
    `;
  }).join('');

  return `
    ${spotsLeft <= 0 ? `<div class=\"tab-warning\">Team is full — decline requests or remove a member to make space.</div>` : ''}
    <div class=\"req-list\">${list}</div>
  `;
}

function buildOwnerSettingsHTML(teamId, team, suffix) {
  const members = getMembers(team);
  const spotsLeft = Math.max(0, TEAM_SIZE - members.length);
  const creatorDiscordLower = String(team.creatorDiscordLower || '').toLowerCase();
  const inputId = `rename-input-${suffix}`;

  const memberRows = members.map(m => {
    const d = sanitizeDiscord(m.discord || '');
    const dl = d.toLowerCase();
    const isOwner = dl === creatorDiscordLower;
    return `
      <div class=\"member-row\">
        <div class=\"member-meta\">
          <div class=\"member-name\">${esc(m.name || 'Player')}${isOwner ? ' <span class=\\"pill\\">owner</span>' : ''}</div>
          <div class=\"member-discord\">@${esc(d || '—')}</div>
        </div>
        ${isOwner ? '' : `<button class=\"btn small danger\" type=\"button\" data-action=\"kick\" data-team-id=\"${teamId}\" data-req-id=\"${esc(dl)}\">Remove</button>`}
      </div>
    `;
  }).join('');

  return `
    <div class=\"settings-section\">
      <div class=\"settings-title\">Team Name</div>
      <div class=\"rename-form\">
        <input type=\"text\" id=\"${inputId}\" class=\"input\" value=\"${esc(team.teamName || '')}\" placeholder=\"Enter team name\">
        <button class=\"btn small primary\" type=\"button\" data-action=\"rename-team\" data-team-id=\"${teamId}\" data-req-id=\"__\" data-input-id=\"${inputId}\">Save</button>
      </div>
    </div>

    <div class=\"settings-section\">
      <div class=\"settings-title\">Members <span class=\"pill\">${members.length}/${TEAM_SIZE}</span></div>
      <div class=\"members-list\">${memberRows}</div>
      ${spotsLeft > 0 ? `<div class=\"small-note\">${spotsLeft} spot${spotsLeft === 1 ? '' : 's'} available</div>` : '<div class=\"small-note\" style=\"color: var(--gold);\">Team is full</div>'}
    </div>

    <div class=\"settings-section danger-section\">
      <div class=\"settings-title danger-title\">Danger Zone</div>
      <p class=\"danger-desc\">Once you delete your team, there is no going back. Please be certain.</p>
      <button class=\"btn danger\" type=\"button\" data-action=\"delete-team\" data-team-id=\"${teamId}\" data-req-id=\"__\">Delete Team</button>
    </div>
  `;
}


async function acceptRequest(teamId, reqId, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  hint.textContent = '';

  // Only owner can accept requests
  if (!isOwnerOf(teamId)) {
    hint.textContent = 'You are not the owner of this team.';
    hint.classList.add('error');
    return;
  }

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

async function declineRequest(teamId, reqId, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  hint.textContent = '';

  // Only owner can decline requests
  if (!isOwnerOf(teamId)) {
    hint.textContent = 'You are not the owner of this team.';
    hint.classList.add('error');
    return;
  }

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


function getUserMode() {
  const v = safeLSGet(USER_MODE_STORAGE);
  if (v === 'creator' || v === 'joiner') return v;
  // Back-compat with older first load choice
  const old = safeLSGet(FIRST_LOAD_CHOICE);
  if (old === 'create') return 'creator';
  if (old === 'join') return 'joiner';
  return null;
}

function setUserMode(mode) {
  if (mode !== 'creator' && mode !== 'joiner') mode = null;
  if (mode) safeLSSet(USER_MODE_STORAGE, mode);
}

function setModeIndicator(mode) {
  const text = mode === 'creator' ? 'Creator' : (mode === 'joiner' ? 'Joining' : '—');

  // Update labels
  const labelDesktop = document.getElementById('mode-label-desktop');
  const labelMobile = document.getElementById('mode-label-mobile');
  if (labelDesktop) labelDesktop.textContent = text;
  if (labelMobile) labelMobile.textContent = text;

  // Update button active states
  const creatorBtns = [
    document.getElementById('mode-set-creator-desktop'),
    document.getElementById('mode-set-creator-mobile')
  ];
  const joinerBtns = [
    document.getElementById('mode-set-joiner-desktop'),
    document.getElementById('mode-set-joiner-mobile')
  ];

  creatorBtns.forEach(btn => {
    if (btn) btn.classList.toggle('active', mode === 'creator');
  });
  joinerBtns.forEach(btn => {
    if (btn) btn.classList.toggle('active', mode === 'joiner');
  });
}

function applyModeUI(mode) {
  if (!mode) return;
  if (lastAppliedMode === mode) return;
  lastAppliedMode = mode;
  document.body.classList.toggle('mode-creator', mode === 'creator');
  document.body.classList.toggle('mode-joiner', mode === 'joiner');

  // Update tab label so it feels distinct
  const regDesktop = document.getElementById('tab-register-desktop');
  const regMobile = document.getElementById('tab-register-mobile');
  const label = mode === 'creator' ? 'Teams' : 'Join';
  if (regDesktop) regDesktop.textContent = label;
  if (regMobile) regMobile.querySelector('span') ? (regMobile.querySelector('span').textContent = label) : null;

  setModeIndicator(mode);

  updateOwnerNavVisibility();

  // Toggle accordions in register panel
  const createAcc = document.getElementById('create-accordion');
  const joinAcc = document.getElementById('join-accordion');
  const manageAcc = document.getElementById('manage-accordion');

  if (mode === 'creator') {
    if (joinAcc) joinAcc.style.display = 'none';
    if (manageAcc) manageAcc.style.display = '';
    if (createAcc) createAcc.style.display = '';
  } else {
    if (joinAcc) joinAcc.style.display = '';
    if (manageAcc) manageAcc.style.display = 'none';
    if (createAcc) createAcc.style.display = 'none';
  }
}



function updateOwnerNavVisibility() {
  const showOwner = !!(roleState && roleState.isCreator && roleState.creatorTeamId);

  document.querySelectorAll('.owner-only').forEach(el => {
    el.style.display = showOwner ? '' : 'none';
  });

  // Creators manage via Requests + Roster, so hide the register/my-team tab for them
  const regDesktop = document.getElementById('tab-register-desktop');
  const regMobile = document.getElementById('tab-register-mobile');
  const hideRegister = !!(roleState && roleState.isCreator);
  if (regDesktop) regDesktop.style.display = hideRegister ? 'none' : '';
  if (regMobile) regMobile.style.display = hideRegister ? 'none' : '';

  const active = document.querySelector('.panel.active');

  // If creator is on the now-hidden register panel, bounce to roster
  if (hideRegister && active && active.id === 'panel-register') {
    setActivePanel('panel-teams');
  }

  // If user is viewing owner panels but no longer owner, bounce to home
  if (!showOwner && active && active.id === 'panel-requests') {
    setActivePanel('panel-home');
  }
}
function computeRoleState(teams) {
  const u = getStoredUser();
  const memberTeam = u.discordLower ? teams.find(t => isMemberOfTeam(t, u.discordLower)) : null;
  const pendingTeam = (!memberTeam && u.discordLower) ? teams.find(t => isPendingOnTeam(t, u.discordLower)) : null;

  // Detect owner team via localStorage
  const ownerTeamId = getOwnerTeamId();
  let creatorTeam = ownerTeamId ? teams.find(t => t.id === ownerTeamId) : null;

  // Migration: check for old creator key hash in localStorage and migrate
  if (!creatorTeam) {
    for (const t of teams) {
      const oldHash = safeLSGet(`creatorKey:${t.id}:hash`);
      if (oldHash && t.creatorKeyHash && String(oldHash) === String(t.creatorKeyHash)) {
        // Migrate to new system
        setOwnerTeamId(t.id);
        creatorTeam = t;
        break;
      }
    }
  }

  roleState.isCreator = !!creatorTeam;
  roleState.creatorTeamId = creatorTeam ? creatorTeam.id : null;
  roleState.memberTeamId = memberTeam ? memberTeam.id : null;
  roleState.pendingTeamId = pendingTeam ? pendingTeam.id : null;

  // Choose a mode if one isn't set yet. Prefer creator if we can prove it.
  const storedMode = getUserMode();
  let mode = storedMode;

  if (!mode) {
    if (roleState.isCreator) mode = 'creator';
    else mode = 'joiner';
    setUserMode(mode);
  }

  // If you are definitely a creator, force creator UI (prevents confusing mix)
  if (roleState.isCreator) mode = 'creator';

  roleState.mode = mode;
  applyModeUI(mode);

  // When creator exists, hide create accordion (you already have a team)
  const createAcc = document.getElementById('create-accordion');
  if (createAcc) createAcc.style.display = roleState.isCreator ? 'none' : (mode === 'creator' ? '' : 'none');

  // When joiner is already on/pending, keep join accordion visible but collapsed
  const joinAcc = document.getElementById('join-accordion');
  if (joinAcc && mode === 'joiner') joinAcc.style.display = '';

  // Update mode switcher buttons (desktop + mobile)
  const creatorBtns = [
    document.getElementById('mode-set-creator-desktop'),
    document.getElementById('mode-set-creator-mobile')
  ];
  const joinerBtns = [
    document.getElementById('mode-set-joiner-desktop'),
    document.getElementById('mode-set-joiner-mobile')
  ];
  // Creators can't switch to joiner mode
  joinerBtns.forEach(btn => { if (btn) btn.disabled = roleState.isCreator; });
  creatorBtns.forEach(btn => { if (btn) btn.disabled = false; });

  // Auto-load management panel for owner
  if (roleState.isCreator && roleState.creatorTeamId) {
    autoLoadManagePanel(roleState.creatorTeamId);
  }

  updateOwnerNavVisibility();
}

function safeLSGet(key) {
  try { return localStorage.getItem(key) || ''; } catch (_) { return ''; }
}

function safeLSSet(key, value) {
  try { localStorage.setItem(key, String(value ?? '')); } catch (_) {}
}

// Simple device-based ownership helpers
function getOwnerTeamId() {
  return safeLSGet(OWNER_TEAM_STORAGE) || null;
}

function setOwnerTeamId(teamId) {
  if (teamId) safeLSSet(OWNER_TEAM_STORAGE, teamId);
}

function clearOwnerTeamId() {
  try { localStorage.removeItem(OWNER_TEAM_STORAGE); } catch (_) {}
}

function isOwnerOf(teamId) {
  return teamId && getOwnerTeamId() === teamId;
}

function getStoredUser() {
  const discord = sanitizeDiscord(safeLSGet(USER_DISCORD_STORAGE));
  const name = (safeLSGet(USER_NAME_STORAGE) || '').trim();
  return {
    discord,
    discordLower: discord ? discord.toLowerCase() : '',
    name
  };
}

function setStoredUser({ name, discord }) {
  const d = sanitizeDiscord(discord || '');
  if (d) safeLSSet(USER_DISCORD_STORAGE, d);
  if (name && String(name).trim()) safeLSSet(USER_NAME_STORAGE, String(name).trim());
}

function isMemberOfTeam(team, discordLower) {
  if (!discordLower) return false;
  const arr = Array.isArray(team.memberDiscords) ? team.memberDiscords : [];
  if (arr.map(s => String(s).toLowerCase()).includes(discordLower)) return true;
  const members = getMembers(team);
  return members.some(m => sanitizeDiscord(m.discord || '').toLowerCase() === discordLower);
}

function isPendingOnTeam(team, discordLower) {
  if (!discordLower) return false;
  const arr = Array.isArray(team.pendingDiscords) ? team.pendingDiscords : [];
  return arr.map(s => String(s).toLowerCase()).includes(discordLower);
}

function updateMyStatus(teams) {
  const box = document.getElementById('my-status');
  if (!box) return;

  const u = getStoredUser();
  if (!u.discordLower) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  const memberTeam = teams.find(t => isMemberOfTeam(t, u.discordLower));
  const pendingTeam = !memberTeam ? teams.find(t => isPendingOnTeam(t, u.discordLower)) : null;

  if (!memberTeam && !pendingTeam) {
    box.style.display = 'none';
    box.innerHTML = '';
    return;
  }

  box.style.display = '';

  if (memberTeam) {
    const isOwner = isOwnerOf(memberTeam.id);
    box.innerHTML = `
      <div class="status-row">
        <div>
          <div class="status-title">${isOwner ? 'You own' : 'You\'re on'} <b>${esc(memberTeam.teamName || 'this team')}</b></div>
          <div class="status-sub">Discord: @${esc(u.discord)}${isOwner ? ' • Manage your team below.' : ''}</div>
        </div>
        <div class="status-actions">
          ${isOwner ? `<button class="btn small primary" type="button" data-action="manage" data-team-id="${memberTeam.id}" data-discord-lower="${u.discordLower}">Manage team</button>` : `<button class="btn small" type="button" data-action="leave" data-team-id="${memberTeam.id}" data-discord-lower="${u.discordLower}">Leave team</button>`}
        </div>
      </div>
    `;
    return;
  }

  // Pending
  box.innerHTML = `
    <div class="status-row">
      <div>
        <div class="status-title">Join request pending</div>
        <div class="status-sub">Waiting for <b>${esc(pendingTeam.teamName || 'the team')}</b> to accept • Discord: @${esc(u.discord)}</div>
      </div>
      <div class="status-actions">
        <button class="btn small" type="button" data-action="cancel" data-team-id="${pendingTeam.id}" data-discord-lower="${u.discordLower}">Cancel request</button>
        <button class="btn small" type="button" data-action="join" data-team-id="${pendingTeam.id}" data-discord-lower="${u.discordLower}">View join form</button>
      </div>
    </div>
  `;
}

async function cancelJoinRequest(teamId, discordLower) {
  const hint = document.getElementById('join-hint');
  if (hint) hint.textContent = '';

  const teamRef = db.collection('teams').doc(teamId);
  const reqRef = teamRef.collection('requests').doc(discordLower);

  try {
    await db.runTransaction(async (tx) => {
      const [teamSnap, reqSnap] = await Promise.all([tx.get(teamRef), tx.get(reqRef)]);
      if (!teamSnap.exists) throw new Error('Team not found');
      if (!reqSnap.exists) throw new Error('Request not found');

      const team = teamSnap.data();
      const req = reqSnap.data();
      if (req.status !== 'pending') throw new Error('That request is no longer pending');

      tx.update(reqRef, {
        status: 'cancelled',
        handledAt: firebase.firestore.FieldValue.serverTimestamp()
      });

      tx.update(teamRef, {
        pendingDiscords: firebase.firestore.FieldValue.arrayRemove(discordLower),
        allDiscords: firebase.firestore.FieldValue.arrayRemove(discordLower)
      });
    });

    if (hint) {
      hint.textContent = 'Cancelled your join request.';
      hint.classList.remove('error');
      hint.classList.add('ok');
    }
  } catch (err) {
    console.error('Cancel request error:', err);
    if (hint) {
      hint.textContent = (err && err.message) ? err.message : 'Error cancelling request.';
      hint.classList.add('error');
    }
  }
}

async function leaveTeam(teamId, discordLower) {
  const hint = document.getElementById('join-hint') || document.getElementById('create-hint');
  if (hint) hint.textContent = '';

  const teamRef = db.collection('teams').doc(teamId);

  try {
    await db.runTransaction(async (tx) => {
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists) throw new Error('Team not found');
      const team = teamSnap.data();

      if ((team.creatorDiscordLower || '').toLowerCase() === discordLower) {
        throw new Error('Creators can\'t leave their own team (no delete flow yet).');
      }

      const members = getMembers(team);
      const filtered = members.filter(m => sanitizeDiscord(m.discord || '').toLowerCase() !== discordLower);
      if (filtered.length === members.length) throw new Error('You are not a member of this team');

      tx.update(teamRef, {
        members: filtered,
        memberDiscords: firebase.firestore.FieldValue.arrayRemove(discordLower),
        allDiscords: firebase.firestore.FieldValue.arrayRemove(discordLower)
      });
    });

    if (hint) {
      hint.textContent = 'You left the team.';
      hint.classList.remove('error');
      hint.classList.add('ok');
    }
  } catch (err) {
    console.error('Leave team error:', err);
    if (hint) {
      hint.textContent = (err && err.message) ? err.message : 'Error leaving team.';
      hint.classList.add('error');
    }
  }
}


async function kickMember(teamId, discordLower, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  if (hint) hint.textContent = '';

  // Only owner can kick members
  if (!isOwnerOf(teamId)) {
    if (hint) { hint.textContent = 'You are not the owner of this team.'; hint.classList.add('error'); }
    return;
  }

  const teamRef = db.collection('teams').doc(teamId);

  try {
    await db.runTransaction(async (tx) => {
      const teamSnap = await tx.get(teamRef);
      if (!teamSnap.exists) throw new Error('Team not found');
      const team = teamSnap.data();

      const creatorLower = String(team.creatorDiscordLower || '').toLowerCase();
      if (creatorLower === String(discordLower).toLowerCase()) {
        throw new Error('You can\'t remove the team creator.');
      }

      const members = getMembers(team);
      const filtered = members.filter(m => sanitizeDiscord(m.discord || '').toLowerCase() !== String(discordLower).toLowerCase());

      tx.update(teamRef, {
        members: filtered,
        memberDiscords: firebase.firestore.FieldValue.arrayRemove(String(discordLower).toLowerCase()),
        allDiscords: firebase.firestore.FieldValue.arrayRemove(String(discordLower).toLowerCase())
      });
    });

    if (hint) { hint.textContent = 'Removed member.'; hint.classList.remove('error'); hint.classList.add('ok'); }
  } catch (err) {
    console.error('Kick error:', err);
    if (hint) { hint.textContent = err.message || 'Could not remove member.'; hint.classList.add('error'); }
  }
}

async function deleteTeam(teamId, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  if (hint) hint.textContent = '';

  // Only owner can delete the team
  if (!isOwnerOf(teamId)) {
    if (hint) { hint.textContent = 'You are not the owner of this team.'; hint.classList.add('error'); }
    return;
  }

  const teamRef = db.collection('teams').doc(teamId);

  try {
    const ok = confirm('Delete this team? This will remove the team and all join requests. This cannot be undone.');
    if (!ok) return;

    const teamSnap = await teamRef.get();
    if (!teamSnap.exists) throw new Error('Team not found');

    // Delete subcollection requests
    const reqSnap = await teamRef.collection('requests').get();
    const batch = db.batch();
    reqSnap.forEach(doc => batch.delete(doc.ref));
    batch.delete(teamRef);
    await batch.commit();

    clearOwnerTeamId();

    if (hint) {
      hint.textContent = 'Team deleted.';
      hint.classList.remove('error');
      hint.classList.add('ok');
    }

  } catch (err) {
    console.error('Delete team error:', err);
    if (hint) { hint.textContent = err.message || 'Could not delete team.'; hint.classList.add('error'); }
  }
}

async function renameTeam(teamId, inputId, hintEl) {
  const hint = hintEl || document.getElementById('manage-hint');
  if (hint) hint.textContent = '';

  // Only owner can rename the team
  if (!isOwnerOf(teamId)) {
    if (hint) { hint.textContent = 'You are not the owner of this team.'; hint.classList.add('error'); }
    return;
  }

  const input = document.getElementById(inputId || 'rename-input-manage') || document.getElementById('rename-input') ;
  const newName = input?.value.trim() || '';

  if (!newName) {
    if (hint) { hint.textContent = 'Team name cannot be empty.'; hint.classList.add('error'); }
    return;
  }

  const teamRef = db.collection('teams').doc(teamId);

  try {
    // Check uniqueness
    const existing = await db.collection('teams')
      .where('teamNameLower', '==', newName.toLowerCase())
      .get();

    const conflicts = existing.docs.filter(d => d.id !== teamId);
    if (conflicts.length > 0) {
      throw new Error('That team name is already taken.');
    }

    await teamRef.update({
      teamName: newName,
      teamNameLower: newName.toLowerCase()
    });

    if (hint) {
      hint.textContent = 'Team renamed successfully.';
      hint.classList.remove('error');
      hint.classList.add('ok');
    }
  } catch (err) {
    console.error('Rename error:', err);
    if (hint) { hint.textContent = err.message || 'Could not rename team.'; hint.classList.add('error'); }
  }
}

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

// Format time ago (e.g., "2 hours ago")
function formatTimeAgo(date) {
  if (!date) return '';
  const now = new Date();
  const diff = Math.floor((now - date) / 1000);

  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}d ago`;
  return date.toLocaleDateString();
}
