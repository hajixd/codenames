/*
  Codenames Teams UI
  - Home: set name + see teams left
  - Teams: list teams, click to view members + request to join
  - My Team: create team, rename (creator), kick (creator), requests (creator)
*/

const MAX_TEAMS = 8;
// Teams should have at least 3 players to be tournament-ready, but can have up to 4.
const TEAM_MIN = 3;
const TEAM_MAX = 4;

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
const LS_SETTINGS_ANIMATIONS = 'ct_animations_v1';
const LS_SETTINGS_SOUNDS = 'ct_sounds_v1';
const LS_SETTINGS_VOLUME = 'ct_volume_v1';
// Account model:
// - Accounts are keyed by normalized player name so "same name" = same account across devices.
// - We keep LS_USER_ID for legacy sessions, but once a name is set we migrate to name-based IDs.

let teamsCache = [];
let playersCache = [];
let openTeamId = null;
let mergeNamesInFlight = new Set();

// Chat (tab)
const GLOBAL_CHAT_COLLECTION = 'globalChat';
let chatMode = 'global'; // 'global' | 'team'
let chatUnsub = null;
let chatMessagesCache = [];
// Unread badges
let unreadGlobalUnsub = null;
let unreadTeamUnsub = null;
let unreadGlobalCache = [];
let unreadTeamCache = [];
let unreadGlobalCount = 0;
let unreadTeamCount = 0;
let lastReadWriteAtMs = 0;
let activePanelId = 'panel-game';

// Profile sync
let profileUnsub = null;
let lastLocalNameSetAtMs = 0;

document.addEventListener('DOMContentLoaded', () => {
  initSettings();
  initLaunchScreen();
  initHeaderLogoNav();
  initTabs();
  initName();
  initPlayersTab();
  initTeamModal();
  initCreateTeamModal();
  initMyTeamControls();
  initRequestsModal();
  initChatTab();
  initOnlineCounterUI();
  listenToTeams();
  listenToPlayers();

  // If user already has a name, proactively merge any case-insensitive duplicates
  if (getUserName()) {
    mergeDuplicatePlayersForName(getUserName()).catch(e => {
      console.warn('Initial duplicate-player merge failed (best-effort)', e);
    });
  }
});

/* =========================
   Header navigation
========================= */
function initHeaderLogoNav() {
  const logo = document.querySelector('.app-header .logo');
  if (!logo) return;
  logo.style.cursor = 'pointer';
  logo.setAttribute('role', 'button');
  logo.setAttribute('tabindex', '0');

  const go = () => {
    // Always reset to the initial Choose Mode screen.
    // This keeps the mental model simple: the logo is "start over".
    returnToLaunchScreen();
  };

  logo.addEventListener('click', go);
  logo.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      go();
    }
  });
}

function setBrowserTitle(mode) {
  // Controls the Chrome tab title.
  // - Choose screen: "Codenames"
  // - Quick Play:   "Codenames QuickPlay"
  // - Tournament:   "Codenames Tournament"
  if (mode === 'quick') {
    document.title = 'Codenames QuickPlay';
    return;
  }
  if (mode === 'tournament') {
    document.title = 'Codenames Tournament';
    return;
  }
  document.title = 'Codenames';
}

function showLaunchScreen() {
  const screen = document.getElementById('launch-screen');
  if (screen) screen.style.display = 'block';
  document.body.classList.add('launch');
  document.body.classList.remove('quickplay');
  document.body.classList.remove('tournament');
  document.body.classList.remove('has-team-color');
  setBrowserTitle('launch');
  try { refreshNameUI?.(); } catch (_) {}
}

function returnToLaunchScreen() {
  // Alias for callers (e.g., game back button)
  showLaunchScreen();
}

// Allow other modules (game.js) to return to the initial screen.
window.returnToLaunchScreen = returnToLaunchScreen;

/* =========================
   Launch screen (mode-first)
========================= */
function initLaunchScreen() {
  const screen = document.getElementById('launch-screen');
  if (!screen) return;

  // Hide the rest of the app until a mode is chosen.
  document.body.classList.add('launch');
  setBrowserTitle('launch');

  const quickBtn = document.getElementById('launch-quick-play');
  const tournBtn = document.getElementById('launch-tournament');

  const hint = document.getElementById('launch-name-hint');
  const input = document.getElementById('launch-name-input');

  const requireNameThen = (mode) => {
    const name = getUserName();
    if (!name) {
      if (hint) hint.textContent = 'Enter your name to continue.';
      try {
        document.getElementById('launch-name-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      } catch (_) {}
      try { input?.focus(); } catch (_) {}
      return;
    }
    if (hint) hint.textContent = '';
    enterAppFromLaunch(mode);
  };

  quickBtn?.addEventListener('click', () => requireNameThen('quick'));
  tournBtn?.addEventListener('click', () => requireNameThen('tournament'));

  // Name + logout on launch (mirrors Tournament Home)
  const form = document.getElementById('launch-name-form');
  const logoutBtn = document.getElementById('launch-logout-btn');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (input?.value || '').trim();
    if (!v) {
      if (hint) hint.textContent = 'Please enter a name.';
      return;
    }
    if (hint) hint.textContent = '';
    await setUserName(v);
  });

  logoutBtn?.addEventListener('click', () => {
    const ok = window.confirm('Are you sure you want to log out on this device?');
    if (!ok) return;
    logoutLocal();
  });

  refreshNameUI();
}

function enterAppFromLaunch(mode) {
  const screen = document.getElementById('launch-screen');
  if (screen) screen.style.display = 'none';

  // Default: leave launch state.
  document.body.classList.remove('launch');
  document.body.classList.remove('tournament');

  // QUICK PLAY
  // - Full-screen lobby/game
  // - No tabs (top band stays)
  if (mode === 'quick') {
    document.body.classList.add('quickplay');
    document.body.classList.remove('tournament');
    // Ensure any tournament-only chrome (team glow/text) is off.
    try { refreshHeaderIdentity?.(); } catch (_) {}
    setBrowserTitle('quick');
    switchToPanel('panel-game');
    try {
      if (typeof window.showQuickPlayLobby === 'function') window.showQuickPlayLobby();
    } catch (_) {}
    return;
  }

  // TOURNAMENT
  // - Go to the tournament home tab
  // - Normal navigation visible
  document.body.classList.remove('quickplay');
  document.body.classList.add('tournament');
  // Apply team color/theme immediately on entry (no need to edit color).
  try { refreshHeaderIdentity?.(); } catch (_) {}
  setBrowserTitle('tournament');
  switchToPanel('panel-home');
}

/* =========================
   Tabs
========================= */
function initTabs() {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');

  activePanelId = document.querySelector('.panel.active')?.id || 'panel-game';

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const panelId = tab.dataset.panel;
      if (!panelId) return;
      switchToPanel(panelId);
    });
  });
}

function switchToPanel(panelId) {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const targetId = String(panelId || '').trim();
  if (!targetId) return;
  const prev = activePanelId;

  // Mark *all* tabs that point at the target panel as active (desktop + mobile)
  tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === targetId));
  panels.forEach(p => p.classList.toggle('active', p.id === targetId));

  // Panel lifecycle hooks
  if (prev === 'panel-chat' && targetId !== 'panel-chat') {
    stopChatSubscription();
  }
  if (targetId === 'panel-chat') {
    startChatSubscription();
    markChatRead(chatMode);
    recomputeUnreadBadges();
  }
  activePanelId = targetId;
  recomputeUnreadBadges();

  // Ensure the Tournament "Play" tab never shows Quick Play options.
  // In tournament mode, the Play panel should always render the tournament lobby.
  if (targetId === 'panel-game') {
    try {
      if (document.body.classList.contains('tournament') && typeof window.showTournamentLobby === 'function') {
        window.showTournamentLobby();
      }
      if (document.body.classList.contains('quickplay') && typeof window.showQuickPlayLobby === 'function') {
        window.showQuickPlayLobby();
      }
    } catch (_) {}
  }
}

/* =========================
   User identity (device-local)
========================= */
const NAME_REGISTRY_COLLECTION = 'names';
const TEAMNAME_REGISTRY_COLLECTION = 'teamNames';
function nameToAccountId(name) {
  const n = String(name || '').trim().toLowerCase();
  if (!n) return '';
  // Firestore doc ids can't contain '/', and we want a stable, readable key.
  return n
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
}

function tsToMs(ts) {
  if (!ts) return Number.POSITIVE_INFINITY;
  try {
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  } catch (_) {}
  return Number.POSITIVE_INFINITY;
}

function autoMergeDuplicatePlayers(players) {
  // Best-effort background cleanup: if duplicates exist (multiple docs with same name),
  // merge them to the earliest-created doc.
  const groups = new Map();
  for (const p of (players || [])) {
    const key = nameToAccountId((p?.name || '').trim());
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  for (const [key, list] of groups.entries()) {
    if (!list || list.length < 2) continue;
    if (mergeNamesInFlight.has(key)) continue;
    mergeNamesInFlight.add(key);
    // Fire and forget; listener will re-render on changes.
    mergeDuplicatePlayersForNameKey(key)
      .catch(e => console.warn('Auto-merge failed (best-effort)', e))
      .finally(() => mergeNamesInFlight.delete(key));
  }
}

async function mergeDuplicatePlayersForName(name) {
  const key = nameToAccountId((name || '').trim());
  if (!key) return;
  return mergeDuplicatePlayersForNameKey(key);
}

async function mergeDuplicatePlayersForNameKey(nameKey) {
  const key = String(nameKey || '').trim();
  if (!key) return;

  // The app is small; simplest robust approach is to fetch all players and filter client-side.
  const snap = await db.collection('players').get();
  const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const same = all.filter(p => nameToAccountId((p?.name || '').trim()) === key);
  if (same.length < 2) return;

  // Pick the earliest-created doc as canonical.
  same.sort((a, b) => {
    const ta = tsToMs(a.createdAt);
    const tb = tsToMs(b.createdAt);
    if (ta !== tb) return ta - tb;
    return String(a.id).localeCompare(String(b.id));
  });
  const canonical = same[0];
  const displayName = (canonical?.name || '').trim();

  for (let i = 1; i < same.length; i++) {
    const dupe = same[i];
    if (!dupe?.id || dupe.id === canonical.id) continue;
    await mergePlayerIntoCanonical({
      nameKey: key,
      displayName,
      canonicalId: canonical.id,
      duplicateId: dupe.id,
    });
  }
}

async function mergePlayerIntoCanonical({ nameKey, displayName, canonicalId, duplicateId }) {
  const key = String(nameKey || '').trim();
  const keepId = String(canonicalId || '').trim();
  const dropId = String(duplicateId || '').trim();
  if (!key || !keepId || !dropId || keepId === dropId) return;

  const keepRef = db.collection('players').doc(keepId);
  const dropRef = db.collection('players').doc(dropId);
  const namesRef = db.collection(NAME_REGISTRY_COLLECTION).doc(key);

  // 1) Merge player docs (invites etc.)
  try {
    await db.runTransaction(async (tx) => {
      const [keepSnap, dropSnap, nameSnap] = await Promise.all([
        tx.get(keepRef),
        tx.get(dropRef),
        tx.get(namesRef),
      ]);
      if (!dropSnap.exists) {
        // Still ensure name registry points to the canonical.
        tx.set(namesRef, {
          accountId: keepId,
          name: (displayName || '').trim(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          ...(nameSnap.exists ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
        }, { merge: true });
        return;
      }

      const keep = keepSnap.exists ? ({ id: keepSnap.id, ...keepSnap.data() }) : null;
      const drop = { id: dropSnap.id, ...dropSnap.data() };

      const mergeInvites = (a, b) => {
        const out = [];
        const seen = new Set();
        for (const x of ([]).concat(a || [], b || [])) {
          const tid = String(x?.teamId || '');
          if (!tid) continue;
          if (seen.has(tid)) continue;
          seen.add(tid);
          out.push(x);
        }
        return out;
      };

      const nextName = ((keep?.name || drop?.name || displayName || '').trim() || '—');
      const nextInvites = mergeInvites(keep?.invites, drop?.invites);

      tx.set(keepRef, {
        name: nextName,
        nameKey: key,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(keep?.createdAt ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() }),
        invites: nextInvites,
      }, { merge: true });

      // Force the registry to point at the earliest account.
      tx.set(namesRef, {
        accountId: keepId,
        name: nextName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(nameSnap.exists ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
      }, { merge: true });

      tx.delete(dropRef);
    });
  } catch (e) {
    console.warn('Could not merge player docs', e);
  }

  // 2) Replace duplicate id with canonical id across all teams (members/pending/creator).
  for (const t of (teamsCache || [])) {
    const teamRef = db.collection('teams').doc(t.id);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(teamRef);
        if (!snap.exists) return;
        const team = { id: snap.id, ...snap.data() };

        let changed = false;

        const nextMembers = getMembers(team).map(m => {
          const mName = (m?.name || '').trim();
          const mKey = nameToAccountId(mName);
          if (m?.userId === dropId || (mKey && mKey === key)) {
            if (m?.userId !== keepId) changed = true;
            return { userId: keepId, name: mName || displayName || '—' };
          }
          return m;
        });

        const nextPending = getPending(team).map(r => {
          const rName = (r?.name || '').trim();
          const rKey = nameToAccountId(rName);
          if (r?.userId === dropId || (rKey && rKey === key)) {
            if (r?.userId !== keepId) changed = true;
            return { ...r, userId: keepId, name: rName || displayName || '—' };
          }
          return r;
        });

        let nextCreatorUserId = team.creatorUserId;
        let nextCreatorName = team.creatorName;
        const creatorKey = nameToAccountId((team.creatorName || '').trim());
        if (team.creatorUserId === dropId || (creatorKey && creatorKey === key)) {
          if (team.creatorUserId !== keepId) changed = true;
          nextCreatorUserId = keepId;
          nextCreatorName = (displayName || team.creatorName || '').trim();
        }

        if (!changed) return;
        tx.update(teamRef, {
          members: dedupeRosterByAccount(nextMembers),
          pending: dedupeRosterByAccount(nextPending),
          creatorUserId: nextCreatorUserId,
          creatorName: nextCreatorName,
        });
      });
    } catch (e) {
      console.warn('Could not update team during merge', e);
    }
  }

  // 3) If this device was on the duplicate account, hop to the canonical one.
  const myId = getLocalAccountId();
  const myNameKey = nameToAccountId(getUserName());
  if (myId === dropId && myNameKey === key) {
    safeLSSet(LS_USER_ID, keepId);
  }
}

function teamNameToKey(name) {
  // Key used to enforce unique team names (case-insensitive, space/punct normalized).
  // Same normalization as account ids.
  return nameToAccountId(name);
}

function getLocalAccountId() {
  // Stable per-device (or linked) account id.
  let id = safeLSGet(LS_USER_ID);
  if (!id) {
    id = (crypto?.randomUUID?.() || ('u_' + Math.random().toString(16).slice(2) + Date.now().toString(16)));
    safeLSSet(LS_USER_ID, id);
  }
  return String(id || '').trim();
}

function getUserId() {
  // All app logic should use the current linked account id.
  return getLocalAccountId();
}

function getUserName() {
  return (safeLSGet(LS_USER_NAME) || '').trim();
}

async function setUserName(name, opts = {}) {
  const silent = !!opts.silent;
  const nextName = (name || '').trim();
  const prevName = (safeLSGet(LS_USER_NAME) || '').trim();

  // Used to avoid profile listener bouncing the UI during a local rename.
  lastLocalNameSetAtMs = Date.now();

  const prevKey = nameToAccountId(prevName);
  const nextKey = nameToAccountId(nextName);

  // If clearing name, don't touch registry.
  if (!nextKey) {
    safeLSSet(LS_USER_NAME, nextName);
    refreshNameUI();
    return;
  }

  const myAccountId = getLocalAccountId();
  const namesCol = db.collection(NAME_REGISTRY_COLLECTION);
  const nextRef = namesCol.doc(nextKey);
  const prevRef = (prevKey && prevKey !== nextKey) ? namesCol.doc(prevKey) : null;

  let targetAccountId = myAccountId;

  // If the name is already mapped to another account, ask for verification before linking.
  if (!silent) {
    try {
      const s = await nextRef.get();
      const existing = s.exists ? String(s.data()?.accountId || '').trim() : '';
      if (existing && existing !== myAccountId) {
        const ok = window.confirm('This name is already taken.\n\nContinue to log in as "' + nextName + '"?');
        if (!ok) {
          // Revert to previous name and keep this device on its current account.
          safeLSSet(LS_USER_NAME, prevName);
          refreshNameUI();
          return;
        }
      }
    } catch (e) {
      // best-effort
    }
  }

  // Update local name after verification.
  safeLSSet(LS_USER_NAME, nextName);

  // Ensure cross-device profile sync is active once we have a name.
  startProfileNameSync();

  try {
    await db.runTransaction(async (tx) => {
      const nextSnap = await tx.get(nextRef);

      // If the name already belongs to someone else, link to that account.
      const existingAccountId = nextSnap.exists ? String(nextSnap.data()?.accountId || '').trim() : '';
      if (existingAccountId && existingAccountId !== myAccountId) {
        targetAccountId = existingAccountId;
      } else {
        targetAccountId = myAccountId;
        tx.set(nextRef, {
          accountId: myAccountId,
          name: nextName,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          ...(nextSnap.exists ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
        }, { merge: true });
      }

      // If we're renaming away from a previous name, free the old mapping (only if it points to THIS account).
      if (prevRef) {
        const prevSnap = await tx.get(prevRef);
        const prevAccountId = prevSnap.exists ? String(prevSnap.data()?.accountId || '').trim() : '';
        if (prevAccountId && prevAccountId === myAccountId) {
          tx.delete(prevRef);
        }
      }
    });
  } catch (e) {
    console.warn('Name linking failed (best-effort). Continuing locally.', e);
    targetAccountId = myAccountId;
  }

  // If this name belongs to another account, switch to it (and migrate any local data best-effort).
  if (targetAccountId && targetAccountId !== myAccountId) {
    try {
      await migrateIdentity(myAccountId, targetAccountId, nextName);
    } catch (e) {
      console.warn('Identity migration failed (best-effort)', e);
    }
    safeLSSet(LS_USER_ID, targetAccountId);
  }

  // Ensure we are listening to the correct profile doc for cross-device name sync.
  startProfileNameSync();

  refreshNameUI();

  // Persist "signed up" players to Firestore so they can appear in the Players tab.
  await upsertPlayerProfile(getUserId(), getUserName());

  // If older/buggy sessions created multiple player docs with the same name, merge them
  // to the earliest-created one. This prevents "two accounts with the same name".
  try {
    await mergeDuplicatePlayersForName(nextName);
  } catch (e) {
    console.warn('Duplicate-player merge failed (best-effort)', e);
  }

  // If user is a member/creator, update their stored display name in their team doc (best-effort)
  try {
    await updateNameInAllTeams(getUserId(), getUserName());
  } catch (e) {
    // best-effort
  }
}


async function migrateIdentity(oldId, newId, displayName) {
  const fromId = String(oldId || '').trim();
  const toId = String(newId || '').trim();
  if (!fromId || !toId || fromId === toId) return;

  // 1) Merge player docs (invites) onto the name-keyed account.
  const fromRef = db.collection('players').doc(fromId);
  const toRef = db.collection('players').doc(toId);

  const mergeInvites = (a, b) => {
    const out = [];
    const seen = new Set();
    for (const x of ([]).concat(a || [], b || [])) {
      const tid = String(x?.teamId || '');
      if (!tid) continue;
      if (seen.has(tid)) continue;
      seen.add(tid);
      out.push(x);
    }
    return out;
  };

  try {
    await db.runTransaction(async (tx) => {
      const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);
      const from = fromSnap.exists ? ({ id: fromSnap.id, ...fromSnap.data() }) : null;
      const to = toSnap.exists ? ({ id: toSnap.id, ...toSnap.data() }) : null;

      const nextName = (to?.name || from?.name || displayName || '').trim();
      const nextInvites = mergeInvites(to?.invites, from?.invites);

      tx.set(toRef, {
        name: nextName || (displayName || '—'),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(to?.createdAt ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() }),
        invites: nextInvites
      }, { merge: true });

      if (fromSnap.exists) {
        // Keep data tidy: once migrated, remove the legacy doc.
        tx.delete(fromRef);
      }
    });
  } catch (e) {
    // best-effort
    console.warn('Could not migrate player doc', e);
  }

  // 2) Migrate team memberships/ownership from legacy IDs onto the name-keyed ID.
  // Teams are small (MAX_TEAMS), so scanning client-side is fine.
  for (const t of (teamsCache || [])) {
    const teamRef = db.collection('teams').doc(t.id);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(teamRef);
        if (!snap.exists) return;
        const team = { id: snap.id, ...snap.data() };

        let changed = false;

        const nextMembers = getMembers(team).map(m => {
          const mName = (m?.name || '').trim();
          const mKey = nameToAccountId(mName);
          if (m?.userId === fromId || (mKey && mKey === toId)) {
            changed = true;
            return { userId: toId, name: mName || displayName || '—' };
          }
          return m;
        });

        const nextPending = getPending(team).map(r => {
          const rName = (r?.name || '').trim();
          const rKey = nameToAccountId(rName);
          if (r?.userId === fromId || (rKey && rKey === toId)) {
            changed = true;
            return { ...r, userId: toId, name: rName || displayName || '—' };
          }
          return r;
        });

        let nextCreatorUserId = team.creatorUserId;
        let nextCreatorName = team.creatorName;
        const creatorKey = nameToAccountId((team.creatorName || '').trim());
        if (team.creatorUserId === fromId || (creatorKey && creatorKey === toId)) {
          if (team.creatorUserId !== toId) changed = true;
          nextCreatorUserId = toId;
          nextCreatorName = (displayName || team.creatorName || '').trim();
        }

        if (!changed) return;
        tx.update(teamRef, {
          members: dedupeRosterByAccount(nextMembers),
          pending: dedupeRosterByAccount(nextPending),
          creatorUserId: nextCreatorUserId,
          creatorName: nextCreatorName
        });
      });
    } catch (e) {
      // best-effort
      console.warn('Could not migrate team membership', e);
    }
  }
}

function initName() {
  // Home form
  const form = document.getElementById('name-form');
  const input = document.getElementById('name-input');
  const hint = document.getElementById('name-hint');
  const logoutBtn = document.getElementById('logout-btn');

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = (input?.value || '').trim();
    if (!v) {
      if (hint) hint.textContent = 'Please enter a name.';
      return;
    }
    if (hint) hint.textContent = '';
    await setUserName(v);
  });

  // Only way to unlink a device from the currently linked name/account.
  logoutBtn?.addEventListener('click', () => {
    const ok = window.confirm('Are you sure you want to log out on this device?');
    if (!ok) return;
    logoutLocal();
  });

  // Double-click editing for home page (works on desktop + mobile)
  wireInlineEdit({
    displayEl: document.getElementById('name-saved-display'),
    inputEl: document.getElementById('name-saved-input'),
    getValue: () => getUserName(),
    onCommit: (v) => setUserName(v),
  });

  // Header name pill - single click opens modal
  const headerNamePill = document.getElementById('header-name-pill');
  headerNamePill?.addEventListener('click', () => {
    playSound('click');
    openNameChangeModal();
  });
  headerNamePill?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      playSound('click');
      openNameChangeModal();
    }
  });

  // Header team pill - single click opens teammates modal
  const headerTeamPill = document.getElementById('header-team-pill');
  headerTeamPill?.addEventListener('click', () => {
    playSound('click');
    openTeammatesModal();
  });
  headerTeamPill?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      playSound('click');
      openTeammatesModal();
    }
  });

  // Initialize name change modal
  initNameChangeModal();

  // Initialize teammates modal
  initTeammatesModal();

  refreshNameUI();

  // Keep the local device name in sync with the account profile (so renames propagate
  // across devices without logging out).
  startProfileNameSync();
}

function startProfileNameSync() {
  try { profileUnsub?.(); } catch (_) {}
  profileUnsub = null;

  // Only sync when this device has a saved name (i.e., the user is "logged in" on this device).
  if (!getUserName()) return;

  const uid = getUserId();
  if (!uid) return;

  profileUnsub = db.collection('players').doc(uid).onSnapshot((snap) => {
    if (!snap?.exists) return;
    const remoteName = String(snap.data()?.name || '').trim();
    if (!remoteName) return;

    const localName = getUserName();
    if (remoteName && remoteName !== localName) {
      // Remote profile is the source of truth once linked.
      // (If the user just changed their name locally, the profile write will land shortly.)
      const now = Date.now();
      if (now - lastLocalNameSetAtMs < 750) return;
      safeLSSet(LS_USER_NAME, remoteName);
      refreshNameUI();
    }
  }, (err) => {
    // best-effort
    console.warn('Profile name sync error', err);
  });
}

function refreshNameUI() {
  const name = getUserName();
  const cardForm = document.getElementById('name-form');
  const saved = document.getElementById('name-saved');
  const savedDisplay = document.getElementById('name-saved-display');
  const headerDisplay = document.getElementById('user-name-display');
  const launchInput = document.getElementById('launch-name-input');
  const launchForm = document.getElementById('launch-name-form');
  const launchSaved = document.getElementById('launch-name-saved');
  const launchSavedDisplay = document.getElementById('launch-name-saved-display');
  const launchQuick = document.getElementById('launch-quick-play');
  const launchTourn = document.getElementById('launch-tournament');

  if (savedDisplay) savedDisplay.textContent = name || '—';
  if (headerDisplay) headerDisplay.textContent = name || '—';
  if (launchInput) launchInput.value = name || '';
  if (launchSavedDisplay) launchSavedDisplay.textContent = name ? `Signed in as ${name}` : '—';

  if (cardForm && saved) {
    cardForm.style.display = name ? 'none' : 'block';
    saved.style.display = name ? 'block' : 'none';
  }

  if (launchForm && launchSaved) {
    launchForm.style.display = name ? 'none' : 'block';
    launchSaved.style.display = name ? 'block' : 'none';
  }

  // Launch mode buttons are disabled until the user has a saved name ("logged in").
  // This prevents users entering Quick Play / Tournament without identity.
  const canEnter = !!name;
  if (launchQuick) launchQuick.disabled = !canEnter;
  if (launchTourn) launchTourn.disabled = !canEnter;

  // Also update UI that depends on name (join buttons etc)
  renderTeams(teamsCache);
  renderMyTeam(teamsCache);
  recomputeMyTeamTabBadge();

  // Keep header identity (name + team) in sync
  refreshHeaderIdentity();
}

function refreshHeaderIdentity() {
  const st = computeUserState(teamsCache);
  const teamText = st.team
    ? (st.team.teamName || 'My team')
    : (st.pendingTeam ? `Pending: ${st.pendingTeam.teamName || 'Team'}` : 'No team');
  setText('user-team-display', teamText);

  // Apply team theme (glow + accent) for the team you're ON.
  applyTeamThemeFromState(st);
}

/* =========================
   Real-time data
========================= */
function listenToTeams() {
  db.collection('teams')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      teamsCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      refreshHeaderIdentity();
      refreshUnreadTeamListener();
      recomputeUnreadBadges();
      recomputeMyTeamTabBadge();
      updateHomeStats(teamsCache);
      renderTeams(teamsCache);
      renderMyTeam(teamsCache);
      renderPlayers(playersCache, teamsCache);
      renderInvites(playersCache, teamsCache);
      // If a modal is open, refresh its contents
      if (openTeamId) openTeamModal(openTeamId);
      if (document.getElementById('requests-modal')?.style?.display === 'flex') {
        renderRequestsModal();
      }
    }, (err) => {
      console.error('Team listener error:', err);
      setHint('teams-hint', 'Error loading teams.');
    });
}

function listenToPlayers() {
  // Players = anyone who has entered their name on this device at least once.
  db.collection('players')
    .orderBy('name', 'asc')
    .onSnapshot((snapshot) => {
      playersCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Best-effort: if prior versions created duplicate player docs for the same name,
      // auto-merge them to the earliest-created doc.
      autoMergeDuplicatePlayers(playersCache);
      recomputeUnreadBadges();
      recomputeMyTeamTabBadge();
      renderPlayers(playersCache, teamsCache);
      renderInvites(playersCache, teamsCache);
    }, (err) => {
      console.error('Players listener error:', err);
      setHint('players-hint', 'Error loading players.');
    });
}

function updateHomeStats(teams) {
  const teamCount = teams.length;
  const players = teams.reduce((sum, t) => sum + getMembers(t).length, 0);

  // Home "spots" = remaining player slots (more useful than remaining teams)
  const maxPlayers = MAX_TEAMS * TEAM_MAX;
  const spots = Math.max(0, maxPlayers - players);

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

function entryAccountId(entry) {
  // Prefer the stable userId stored on roster entries so accounts don't fragment
  // simply because a display name changes. We keep a name-based fallback for
  // legacy/partial data.
  const uid = String(entry?.userId || '').trim();
  if (uid) return uid;
  const n = (entry?.name || '').trim();
  return nameToAccountId(n);
}

function isSameAccount(entry, accountId) {
  const aid = String(accountId || '').trim();
  if (!aid) return false;
  return entryAccountId(entry) === aid;
}

function dedupeRosterByAccount(list) {
  const out = [];
  const seen = new Set();
  for (const e of (list || [])) {
    const key = entryAccountId(e);
    if (!key) continue;
    if (seen.has(key)) {
      // Prefer keeping a version that has a name if the existing one is blank
      const idx = out.findIndex(x => entryAccountId(x) === key);
      if (idx >= 0) {
        const curName = (out[idx]?.name || '').trim();
        const nextName = (e?.name || '').trim();
        if (!curName && nextName) out[idx] = { ...out[idx], name: nextName };
      }
      continue;
    }
    seen.add(key);
    out.push(e);
  }
  return out;
}

function findUserInMembers(team, userId) {
  return getMembers(team).find(m => isSameAccount(m, userId));
}

function findUserInPending(team, userId) {
  return getPending(team).find(r => isSameAccount(r, userId));
}

function computeUserState(teams) {
  const userId = getUserId();
  let team = null;
  let pendingTeam = null;
  for (const t of teams) {
    if (findUserInMembers(t, userId)) team = t;
    if (findUserInPending(t, userId)) pendingTeam = t;
  }
  const creatorKey = team ? nameToAccountId((team.creatorName || '').trim()) : '';
  // Creator detection:
  // - Prefer the stable creatorUserId match
  // - Fallback to creatorName match (legacy teams)
  const myNameKey = nameToAccountId(getUserName());
  const isCreator = !!(team && (
    team.creatorUserId === userId ||
    (creatorKey && myNameKey && creatorKey === myNameKey) ||
    (creatorKey && creatorKey === userId) // very old/buggy sessions
  ));
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
   Team theme (color)
========================= */
function getDisplayTeamColor(team) {
  const raw = (team?.teamColor || '').trim();
  return isValidHexColor(raw) ? raw : '#64748b';
}

function isValidHexColor(c) {
  return /^#([0-9a-fA-F]{6})$/.test(String(c || '').trim());
}

function hexToRgba(hex, alpha) {
  if (!isValidHexColor(hex)) return `rgba(59,130,246,0)`;
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = Math.max(0, Math.min(1, Number(alpha)));
  return `rgba(${r},${g},${b},${a})`;
}

function applyTeamThemeFromState(st) {
  const body = document.body;
  const root = document.documentElement;
  const raw = st?.team?.teamColor;
  const color = isValidHexColor(raw) ? raw : (st?.team ? '#3b82f6' : null);

  // Only show team chrome (team text + glow outline) while in Tournament.
  const isTournament = body?.classList.contains('tournament');

  if (color && isTournament) {
    body?.classList.add('has-team-color');
    root.style.setProperty('--team-accent', color);
    // Brighter team outline
    root.style.setProperty('--team-glow', hexToRgba(color, 0.50));
  } else {
    body?.classList.remove('has-team-color');
    root.style.setProperty('--team-accent', 'transparent');
    root.style.setProperty('--team-glow', 'rgba(59,130,246,0)');
  }
}

function dedupeInvitesByTeamId(invites) {
  const out = [];
  const seen = new Set();
  for (const i of (invites || [])) {
    const tid = String(i?.teamId || '').trim();
    if (!tid) continue;
    if (seen.has(tid)) continue;
    seen.add(tid);
    out.push(i);
  }
  return out;
}

/* =========================
   Players page (directory + invites)
========================= */
function initPlayersTab() {
  // Nothing to wire yet (render is driven by listeners), but keep hints clean.
  setHint('players-hint', '');
}

function buildRosterIndex(teams) {
  const memberTeamByUserId = new Map();
  const pendingTeamByUserId = new Map();
  for (const t of (teams || [])) {
    for (const m of getMembers(t)) {
      const key = entryAccountId(m);
      if (key) memberTeamByUserId.set(key, t);
    }
    for (const r of getPending(t)) {
      const key = entryAccountId(r);
      if (key) pendingTeamByUserId.set(key, t);
    }
  }
  return { memberTeamByUserId, pendingTeamByUserId };
}

// Players directory should include:
// - anyone in the `players` collection (signed up)
// - anyone who appears in an accepted team roster (even if they never saved a name on this device)
function buildPlayersDirectory(players, teams) {
  const byKey = new Map();

  for (const p of (players || [])) {
    const name = (p?.name || '').trim();
    const key = String(p?.id || '').trim() || nameToAccountId(name);
    if (!key) continue;
    const cur = byKey.get(key) || { id: key, name: '', invites: [] };
    const invitesA = Array.isArray(cur.invites) ? cur.invites : [];
    const invitesB = Array.isArray(p.invites) ? p.invites : [];
    const merged = dedupeInvitesByTeamId(invitesA.concat(invitesB));
    const curName = (cur?.name || '').trim();
    byKey.set(key, { ...cur, id: key, name: curName || name, invites: merged });
  }

  for (const t of (teams || [])) {
    for (const m of getMembers(t)) {
      const rosterName = (m?.name || '').trim();
      const key = entryAccountId(m);
      if (!key) continue;
      const cur = byKey.get(key) || { id: key, name: rosterName, invites: [] };
      const curName = (cur?.name || '').trim();
      if (!curName && rosterName) cur.name = rosterName;
      byKey.set(key, cur);
    }

    // Also include users who have submitted a request (pending), but do NOT expose
    // which team they requested publicly.
    for (const r of getPending(t)) {
      const reqName = (r?.name || '').trim();
      const key = entryAccountId(r);
      if (!key) continue;
      const cur = byKey.get(key) || { id: key, name: reqName, invites: [] };
      const curName = (cur?.name || '').trim();
      if (!curName && reqName) cur.name = reqName;
      byKey.set(key, cur);
    }
  }

  return Array.from(byKey.values())
    .filter(p => (p?.name || '').trim())
    .sort((a, b) => (a.name || '').localeCompare(b.name || '', undefined, { sensitivity: 'base' }));
}

// Best-effort name lookup for a user id.
// Used so teammates can invite roster-detected users who don't yet have a `players` doc.
function findKnownUserName(userId) {
  const pid = String(userId || '').trim();
  if (!pid) return '';
  const p = (playersCache || []).find(x => x?.id === pid || nameToAccountId((x?.name || '').trim()) === pid);
  const pn = (p?.name || '').trim();
  if (pn) return pn;

  for (const t of (teamsCache || [])) {
    for (const m of getMembers(t)) {
      if (entryAccountId(m) === pid) {
        const n = (m?.name || '').trim();
        if (n) return n;
      }
    }
    for (const r of getPending(t)) {
      if (entryAccountId(r) === pid) {
        const n = (r?.name || '').trim();
        if (n) return n;
      }
    }
  }

  return '';
}

function renderPlayers(players, teams) {
  const container = document.getElementById('players-list');
  if (!container) return;

  const st = computeUserState(teams);
  const roster = buildRosterIndex(teams);
  const myTeam = st?.team;
  // Anyone on a team can send invites (not just the creator).
  const canManageInvites = !!(st.teamId && myTeam);
  const canSendInvitesNow = !!(canManageInvites && getMembers(myTeam).length < TEAM_MAX);

  // Directory = every known player from the Players collection PLUS anyone currently on a team.
  const directory = buildPlayersDirectory(players, teams);

  if (!directory || directory.length === 0) {
    container.innerHTML = '<div class="empty-state">No players yet. Set your name on Home.</div>';
    return;
  }

  const rows = directory
    .filter(p => (p?.name || '').trim())
    .map((p) => {
      const uid = p.id;
      const name = (p.name || '—').trim();

      const memberTeam = roster.memberTeamByUserId.get(uid);
      // IMPORTANT: do not show pending requests publicly.
      // Only show team if the player is an accepted member.
      const team = memberTeam || null;
      const teamName = team ? (team.teamName || 'Team') : '—';
      const teamColor = team ? getDisplayTeamColor(team) : null;

      const showAvailable = !memberTeam;

      const invites = Array.isArray(p.invites) ? p.invites : [];
      const alreadyInvitedByMe = !!(st.teamId && invites.some(i => i?.teamId === st.teamId));
      const isTeammate = !!(memberTeam && st.teamId && memberTeam.id === st.teamId);
      const inviteDisabledBase = !st.name;

      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';

      // Right-side pill: show the player's team (if they're on one), otherwise show "Available".
      // Teammates can also send invites via the Invite pill.
      const teamPillStyle = teamColor
        ? `style="border-color:${esc(hexToRgba(teamColor, 0.35))}; color:${esc(teamColor)}; background:${esc(hexToRgba(teamColor, 0.10))}"`
        : '';

      // Always show the status pill (Available or Team). If you're on a team,
      // also show an Invite pill to the RIGHT of the status pill.
      let statusPillHtml = memberTeam
        ? `<span class="player-tag" ${teamPillStyle}>${esc(teamName)}</span>`
        : `<span class="player-tag ok">Available</span>`;

      let invitePillHtml = '';
      if (canManageInvites && uid !== st.userId) {
        if (isTeammate) {
          invitePillHtml = `<button class="player-tag pill-action invite" type="button" disabled title="Already on your team">Invite</button>`;
        } else {
          const mode = alreadyInvitedByMe ? 'cancel' : 'send';
          const disabled = inviteDisabledBase || (!alreadyInvitedByMe && !canSendInvitesNow);
          const title = inviteDisabledBase
            ? 'Set your name on Home first.'
            : (!alreadyInvitedByMe && !canSendInvitesNow ? 'Your team is full.' : '');
          invitePillHtml = `
            <button class="player-tag pill-action ${alreadyInvitedByMe ? 'cancel' : 'invite'}" type="button" data-invite="${esc(uid)}" data-invite-mode="${mode}" ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>
              ${alreadyInvitedByMe ? 'Cancel invite' : 'Invite'}
            </button>
          `;
        }
      }

      return `
        <div class="player-row player-directory-row">
          <div class="player-left">
            <span class="player-name" ${nameStyle}>${esc(name)}</span>
          </div>
          <div class="player-right">
            ${statusPillHtml}
            ${invitePillHtml}
          </div>
        </div>
      `;
    });

  container.innerHTML = rows.length
    ? rows.join('')
    : '<div class="empty-state">No players yet. Set your name on Home.</div>';

  container.querySelectorAll('[data-invite]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const targetId = btn.getAttribute('data-invite');
      if (!targetId) return;
      const mode = btn.getAttribute('data-invite-mode') || 'send';
      if (mode === 'cancel') {
        await cancelInviteToPlayer(targetId);
      } else {
        await sendInviteToPlayer(targetId);
      }
    });
  });

  // Helpful hint for teammates
  if (st.teamId) {
    if (!st.name) setHint('players-hint', 'Set your name on Home first.');
    else if (!canSendInvitesNow) setHint('players-hint', 'Your team is full — you can’t send new invites.');
    else setHint('players-hint', 'Tap Invite to send a team invite.');
  }
}
function renderInvites(players, teams) {
  const card = document.getElementById('invites-card');
  const list = document.getElementById('invites-list');
  if (!card || !list) return;

  const st = computeUserState(teams);
  const noName = !st.name;

  // Invites are useful even if you're already on a team (accepting will switch you).
  // If the user has a pending request somewhere, they can still accept an invite (and the pending request will be cleared).

  const me = (players || []).find(p => p.id === st.userId);
  const invites = Array.isArray(me?.invites) ? me.invites : [];
  if (!invites.length) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';

  if (noName) {
    setHint('invites-hint', 'Set your name on Home first.');
  } else {
    setHint('invites-hint', '');
  }

  list.innerHTML = invites.map(inv => {
    const teamName = inv?.teamName || 'Team';
    const teamId = inv?.teamId || '';
    const t = (teams || []).find(x => x?.id === teamId);
    const c = t ? getDisplayTeamColor(t) : null;
    const nameStyle = c ? `style="color:${esc(c)}"` : '';
    return `
      <div class="invite-row">
        <div class="invite-left">
          <div class="invite-title" ${nameStyle}>${esc(teamName)}</div>
          <div class="invite-sub">You’ve been invited to join</div>
        </div>
        <div class="invite-actions">
          <button class="btn primary small" type="button" data-invite-accept="${esc(teamId)}" ${noName ? 'disabled' : ''}>Join</button>
          <button class="btn danger small" type="button" data-invite-decline="${esc(teamId)}">Decline</button>
        </div>
      </div>
    `;
  }).join('');

  list.querySelectorAll('[data-invite-accept]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const teamId = btn.getAttribute('data-invite-accept');
      if (!teamId) return;
      await acceptInvite(teamId);
      renderInvites(playersCache, teamsCache);
      renderMyTeam(teamsCache);
    });
  });

  list.querySelectorAll('[data-invite-decline]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const teamId = btn.getAttribute('data-invite-decline');
      if (!teamId) return;
      await declineInvite(teamId);
      renderInvites(playersCache, teamsCache);
    });
  });
}

async function upsertPlayerProfile(userId, name) {
  const n = (name || '').trim();
  if (!userId || !n) return;
  const ref = db.collection('players').doc(userId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) {
        tx.set(ref, {
          name: n,
          nameKey: nameToAccountId(n),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          invites: []
        });
      } else {
        tx.update(ref, {
          name: n,
          nameKey: nameToAccountId(n),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      }
    });
  } catch (e) {
    // best effort
    console.warn('Could not upsert player profile', e);
  }
}

async function sendInviteToPlayer(targetUserId) {
  const st = computeUserState(teamsCache);
  if (!st.teamId || !st.team) return;
  if (getMembers(st.team).length >= TEAM_MAX) return;

  setHint('players-hint', 'Sending invite…');

  const teamId = st.teamId;
  const invite = {
    teamId,
    teamName: st.team.teamName || 'Team',
    teamColor: st.team.teamColor || null,
    inviterUserId: st.userId,
    inviterName: st.name || '—',
    invitedAt: firebase.firestore.Timestamp.now(),
  };

  const playerRef = db.collection('players').doc(targetUserId);
  const fallbackName = findKnownUserName(targetUserId) || '—';
  try {
    await db.runTransaction(async (tx) => {
      const ps = await tx.get(playerRef);
      if (!ps.exists) {
        // If the user has never "signed up" (no players doc), create a lightweight profile
        // so invites can still work for roster-detected users.
        tx.set(playerRef, {
          name: fallbackName,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          invites: [invite]
        });
        return;
      }

      const p = { id: ps.id, ...ps.data() };
      const invites = Array.isArray(p.invites) ? p.invites : [];
      if (invites.some(i => i?.teamId === teamId)) return;
      tx.update(playerRef, { invites: invites.concat([invite]), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    setHint('players-hint', 'Invite sent.');
  } catch (e) {
    console.error(e);
    setHint('players-hint', e?.message || 'Could not send invite.');
  }
}

async function cancelInviteToPlayer(targetUserId) {
  const st = computeUserState(teamsCache);
  if (!st.teamId) return;

  const playerRef = db.collection('players').doc(String(targetUserId || '').trim());
  setHint('players-hint', 'Canceling invite…');

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(playerRef);
      if (!snap.exists) return;
      const p = { id: snap.id, ...snap.data() };
      const invites = Array.isArray(p.invites) ? p.invites : [];
      const nextInvites = invites.filter(i => i?.teamId !== st.teamId);
      tx.update(playerRef, {
        invites: nextInvites,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    setHint('players-hint', 'Invite canceled.');
  } catch (e) {
    console.error(e);
    setHint('players-hint', e?.message || 'Could not cancel invite.');
  }
}

async function acceptInvite(teamId) {
  const st = computeUserState(teamsCache);
  if (!st.name) return;

  if (st.teamId && st.teamId === teamId) {
    // Already on this team — just clean up the invite.
    await declineInvite(teamId);
    setHint('invites-hint', 'You are already on this team.');
    return;
  }

  const playerRef = db.collection('players').doc(st.userId);
  setHint('invites-hint', 'Joining…');

  try {
    // We keep the app small (MAX_TEAMS). Safest approach is to read all teams so we can:
    // - remove the player from any old team roster (switch)
    // - clear the player's pending requests from every team once they join
    const allTeamIds = (teamsCache || []).map(t => String(t.id || '').trim()).filter(Boolean);
    const teamRefs = allTeamIds.map(id => db.collection('teams').doc(id));

    await db.runTransaction(async (tx) => {
      const snaps = await Promise.all([tx.get(playerRef)].concat(teamRefs.map(r => tx.get(r))));
      const playerSnap = snaps[0];
      if (!playerSnap.exists) throw new Error('Player not found.');

      const teams = [];
      for (let i = 1; i < snaps.length; i++) {
        const s = snaps[i];
        if (!s.exists) continue;
        teams.push({ id: s.id, ...s.data() });
      }

      const target = teams.find(t => t.id === teamId);
      if (!target) throw new Error('Team not found.');

      const targetMembers = getMembers(target);
      if (targetMembers.length >= TEAM_MAX) throw new Error('Team is full.');
      if (targetMembers.some(m => isSameAccount(m, st.userId))) return;

      // Determine if we're switching from another team.
      const oldTeam = teams.find(t => t.id !== teamId && getMembers(t).some(m => isSameAccount(m, st.userId))) || null;
      const oldTeamId = oldTeam?.id ? String(oldTeam.id) : null;

      // Update target team: add member, remove any pending request by this user.
      const targetPending = getPending(target);
      const nextTargetPending = targetPending.filter(r => !isSameAccount(r, st.userId));
      const nextTargetMembers = dedupeRosterByAccount(targetMembers.concat([{ userId: st.userId, name: st.name }]));
      tx.update(db.collection('teams').doc(teamId), { members: nextTargetMembers, pending: nextTargetPending });

      // Update player doc: remove invite for this team.
      const player = { id: playerSnap.id, ...playerSnap.data() };
      const invites = Array.isArray(player.invites) ? player.invites : [];
      const nextInvites = invites.filter(i => i?.teamId !== teamId);
      tx.update(playerRef, { invites: nextInvites, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

      // Clear this user's pending requests from ALL teams (including the target).
      for (const t of teams) {
        const p = getPending(t);
        if (!p?.length) continue;
        const next = p.filter(r => !isSameAccount(r, st.userId));
        if (next.length !== p.length) {
          tx.update(db.collection('teams').doc(t.id), { pending: next });
        }
      }

      // If switching, remove from old team roster. If you were the creator:
      // - if you're leaving the last spot, delete the team (and free its name)
      // - otherwise, hand creator over to a random remaining member
      if (oldTeamId) {
        const oldMembers = getMembers(oldTeam);
        const nextOldMembers = oldMembers.filter(m => !isSameAccount(m, st.userId));

        const oldCreatorKey = nameToAccountId((oldTeam.creatorName || '').trim());
        const myNameKey = nameToAccountId((st.name || '').trim());
        const leavingIsCreator = !!(
          String(oldTeam.creatorUserId || '').trim() === String(st.userId || '').trim() ||
          (oldCreatorKey && myNameKey && oldCreatorKey === myNameKey) ||
          (oldCreatorKey && oldCreatorKey === String(st.userId || '').trim())
        );

        if (nextOldMembers.length === 0) {
          // Delete team + remove name registry mapping (if any).
          const key = teamNameToKey(String(oldTeam.teamName || '').trim());
          if (key) {
            const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
            const nameSnap = await tx.get(nameRef);
            const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
            if (mappedId === oldTeamId) tx.delete(nameRef);
          }
          tx.delete(db.collection('teams').doc(oldTeamId));
        } else if (leavingIsCreator) {
          const nextCreator = nextOldMembers[Math.floor(Math.random() * nextOldMembers.length)];
          tx.update(db.collection('teams').doc(oldTeamId), {
            members: nextOldMembers,
            creatorUserId: entryAccountId(nextCreator),
            creatorName: (nextCreator?.name || '').trim() || oldTeam.creatorName || ''
          });
        } else {
          tx.update(db.collection('teams').doc(oldTeamId), { members: nextOldMembers });
        }
      }
    });

    setHint('invites-hint', 'Joined!');
    activatePanel('panel-myteam');
  } catch (e) {
    console.error(e);
    setHint('invites-hint', e?.message || 'Could not join team.');
  }
}

async function declineInvite(teamId) {
  const st = computeUserState(teamsCache);
  const playerRef = db.collection('players').doc(st.userId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(playerRef);
      if (!snap.exists) return;
      const p = { id: snap.id, ...snap.data() };
      const invites = Array.isArray(p.invites) ? p.invites : [];
      tx.update(playerRef, { invites: invites.filter(i => i?.teamId !== teamId), updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
  } catch (e) {
    console.error(e);
  }
}

/* =========================
   Teams page
========================= */
function renderTeams(teams) {
  const container = document.getElementById('teams-list');
  if (!container) return;

  const st = computeUserState(teams);

  if (teams.length === 0) {
    container.innerHTML = '<div class="empty-state">No teams yet</div>';
    return;
  }

  // Sharp, simple list: team name + member names. Click for details / request.
  container.innerHTML = teams.map((t) => {
    const members = getMembers(t);
    const memberNames = members.length
      ? members.map(m => (m?.name || '—').trim()).filter(Boolean).join(', ')
      : 'No members yet';

    const isMine = st.teamId === t.id;

    const tc = getDisplayTeamColor(t);
    const nameStyle = tc ? `style="color:${esc(tc)}"` : '';

    return `
      <button class="team-list-item ${isMine ? 'is-mine' : ''}" type="button" data-team="${esc(t.id)}">
        <div class="team-list-left">
          <div class="team-list-name ${isMine ? 'team-accent' : ''}"><span class="team-list-name-text" ${nameStyle}>${esc(t.teamName || 'Unnamed')}</span></div>
          <div class="team-list-members" ${nameStyle}>${esc(memberNames)}</div>
        </div>
        <div class="team-list-right">
          <div class="team-list-count">${members.length}/${TEAM_MAX}</div>
        </div>
      </button>
    `;
  }).join('');

  container.querySelectorAll('[data-team]')?.forEach(row => {
    row.addEventListener('click', () => {
      const teamId = row.getAttribute('data-team');
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
    const st = computeUserState(teamsCache);
    // If the user already has a pending request for this team, clicking the button cancels it.
    if (st.pendingTeamId === openTeamId) {
      await cancelJoinRequest(openTeamId);
      // Update UI immediately; snapshot listener will also re-render.
      renderTeamModal(openTeamId);
      return;
    }
    await requestToJoin(openTeamId);
    renderTeamModal(openTeamId);
  });
}

function openTeamModal(teamId) {
  openTeamId = teamId;
  const modal = document.getElementById('team-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));
  renderTeamModal(teamId);
}

function closeTeamModal() {
  openTeamId = null;
  const modal = document.getElementById('team-modal');
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }
  setHint('team-modal-hint', '');
}

function renderTeamModal(teamId) {
  const team = teamsCache.find(t => t.id === teamId);
  if (!team) return;

  const tc = getDisplayTeamColor(team);
  setHTML('team-modal-title', `<span class="team-title-inline" style="color:${esc(tc)}">${esc(team.teamName || 'Team')}</span>`);

  const membersEl = document.getElementById('team-modal-members');
  const members = getMembers(team);
  const tcMember = getDisplayTeamColor(team);
  if (membersEl) {
    membersEl.innerHTML = members.length
      ? members.map(m => `
          <div class="player-row">
            <div class="player-left">
              <span class="player-name" style="color:${esc(tcMember)}">${esc(m.name || '—')}</span>
            </div>
          </div>
        `).join('')
      : '<div class="empty-state">No members yet</div>';
  }

  const st = computeUserState(teamsCache);
  const joinBtn = document.getElementById('team-modal-join');
  const full = members.length >= TEAM_MAX;
  const iAmMember = st.teamId === teamId;
  const iAmPendingHere = st.pendingTeamId === teamId;
  const hasOtherPending = !!(st.pendingTeamId && st.pendingTeamId !== teamId);
  const noName = !st.name;

  let label = 'Request to join';
  let disabled = false;
  let hint = '';
  let variant = 'primary';

  if (noName) {
    disabled = true;
    hint = 'Set your name on Home first.';
  } else if (iAmMember) {
    disabled = true;
    label = 'You are on this team';
  } else if (iAmPendingHere) {
    // Replace "Request sent" with a cancellable action.
    disabled = false;
    label = 'Cancel Request';
    variant = 'danger';
    hint = 'Your request is pending.';
  } else if (hasOtherPending) {
    disabled = true;
    hint = 'You already have a pending request.';
  } else if (full) {
    // Allow requests even when a team is full; the leader can accept later once space is available.
    disabled = false;
    label = 'Request to join';
    hint = '';

  }

  if (joinBtn) {
    joinBtn.disabled = disabled;
    joinBtn.classList.toggle('disabled', disabled);
    // Button style variant
    joinBtn.classList.toggle('primary', variant === 'primary');
    joinBtn.classList.toggle('danger', variant === 'danger');
    joinBtn.textContent = label;
  }
  setHint('team-modal-hint', hint);
}

async function cancelJoinRequest(teamId, opts = {}) {
  const st = computeUserState(teamsCache);
  const ref = db.collection('teams').doc(teamId);

  setHint(opts.hintElId || 'team-modal-hint', 'Canceling…');

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const pending = getPending(t);
      const next = pending.filter(r => !isSameAccount(r, st.userId));
      // If nothing to remove, no-op.
      if (next.length === pending.length) return;
      tx.update(ref, { pending: next });
    });
    setHint(opts.hintElId || 'team-modal-hint', 'Request canceled.');
  } catch (e) {
    console.error(e);
    setHint(opts.hintElId || 'team-modal-hint', e?.message || 'Could not cancel request.');
  }
}

async function requestToJoin(teamId, opts = {}) {
  const st = computeUserState(teamsCache);
  if (!st.name) {
    setHint(opts.hintElId || 'team-modal-hint', 'Set your name on Home first.');
    return;
  }
  if (st.pendingTeamId && st.pendingTeamId !== teamId) {
    setHint(opts.hintElId || 'team-modal-hint', 'You already have a pending request.');
    return;
  }

  setHint(opts.hintElId || 'team-modal-hint', 'Sending…');

  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      const pending = getPending(t);
      if (pending.some(r => isSameAccount(r, st.userId))) return;
      // NOTE: serverTimestamp() is not supported inside arrays in Firestore.
      // Use a client timestamp instead.
      tx.update(ref, {
        pending: dedupeRosterByAccount(pending.concat([{ userId: st.userId, name: st.name, requestedAt: firebase.firestore.Timestamp.now() }]))
      });
    });
    setHint(opts.hintElId || 'team-modal-hint', 'Request sent.');
  } catch (e) {
    console.error(e);
    setHint(opts.hintElId || 'team-modal-hint', e?.message || 'Could not send request.');
  }
}

/* =========================
   My Team page
========================= */
function initMyTeamControls() {
  // If you're not on a team, offer a direct jump to the Teams tab.
  document.getElementById('join-team-btn')?.addEventListener('click', () => {
    switchToPanel('panel-teams');
  });

  document.getElementById('open-create-team')?.addEventListener('click', () => {
    openCreateTeamModal();
  });

  document.getElementById('leave-or-delete')?.addEventListener('click', async () => {
    const st = computeUserState(teamsCache);
    if (!st.teamId) return;

    if (st.isCreator) {
      const ok = window.confirm('Are you sure you want to delete your team? This cannot be undone.');
      if (!ok) return;
      await deleteTeam(st.teamId);
    } else {
      const ok = window.confirm('Are you sure you want to leave this team?');
      if (!ok) return;
      await leaveTeam(st.teamId, st.userId);
    }
  });

  document.getElementById('open-requests')?.addEventListener('click', () => {
    openRequestsModal();
  });

  document.getElementById('open-chat')?.addEventListener('click', () => {
    openChatModal();
  });

  // Quick path: if you're not on a team, jump to Teams tab.
  document.getElementById('join-team-btn')?.addEventListener('click', () => {
    switchToPanel('panel-teams');
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
      try {
      await renameTeamUnique(st.teamId, v);
    } catch (e) {
      setHint('teams-hint', e?.message || 'Could not rename team.');
    }
    }
  });

  // Team color (creator)
  const colorInput = document.getElementById('team-color-input');
  colorInput?.addEventListener('input', async () => {
    const st = computeUserState(teamsCache);
    if (!st.isCreator || !st.teamId) return;
    const color = (colorInput.value || '').trim();
    if (!isValidHexColor(color)) return;
    try {
      await db.collection('teams').doc(st.teamId).update({ teamColor: color });
    } catch (e) {
      console.warn('Could not update team color', e);
    }
  });
}

function renderMyTeam(teams) {
  const st = computeUserState(teams);
  const createBtn = document.getElementById('open-create-team');
  const card = document.getElementById('myteam-card');
  const joinBtn = document.getElementById('join-team-btn');
  const membersEl = document.getElementById('myteam-members');
  const actionsEl = document.getElementById('myteam-actions');
  const requestsBtn = document.getElementById('open-requests');
  const chatBtn = document.getElementById('open-chat');
  const leaveDeleteBtn = document.getElementById('leave-or-delete');
  const sub = document.getElementById('myteam-subtitle');
  const colorRow = document.getElementById('team-color-row');
  const colorInput = document.getElementById('team-color-input');

  const hasTeam = !!st.teamId;

  if (joinBtn) {
    // Only show when you're named and not currently on a team.
    const show = !!st.name && !hasTeam;
    joinBtn.style.display = show ? 'inline-flex' : 'none';
  }
  if (createBtn) {
    // Create button is only relevant if you're not on a team.
    const disableCreate = !st.name || hasTeam || !!st.pendingTeamId || teams.length >= MAX_TEAMS;
    createBtn.disabled = disableCreate;
    createBtn.classList.toggle('disabled', disableCreate);
    createBtn.style.display = hasTeam ? 'none' : 'inline-flex';
  }
  if (sub) {
    if (!st.name) sub.textContent = 'Set your name first (Home tab).';
    else if (hasTeam) sub.textContent = st.isCreator ? 'Double click the team name to rename. You can kick teammates and manage requests.' : 'You are on a team.';
    else sub.textContent = 'Create a team or request to join one from the Teams tab.';
  }

  if (chatBtn) {
    chatBtn.style.display = hasTeam ? 'inline-flex' : 'none';
    chatBtn.disabled = !hasTeam;
    chatBtn.classList.toggle('disabled', !hasTeam);
  }

  if (!card) return;

  if (!hasTeam) {
    card.style.display = 'none';
    return;
  }

  card.style.display = 'block';
  setText('myteam-name', st.team.teamName || 'Unnamed');
  const myNameEl = document.getElementById('myteam-name');
  if (myNameEl) myNameEl.style.color = getDisplayTeamColor(st.team);
  setText('myteam-size', `${getMembers(st.team).length}/${TEAM_MAX}`);

  // Footer buttons
  if (leaveDeleteBtn) {
    leaveDeleteBtn.style.display = 'inline-flex';
    leaveDeleteBtn.textContent = st.isCreator ? 'Delete team' : 'Leave team';
  }
  if (requestsBtn) {
    if (st.isCreator) {
      requestsBtn.style.display = 'inline-flex';
      requestsBtn.textContent = `Requests (${getPending(st.team).length})`;
    } else {
      requestsBtn.style.display = 'none';
    }
  }

  // Team color picker (visible to everyone; editable by creator)
  if (colorRow && colorInput) {
    colorRow.style.display = 'flex';
    const c = getDisplayTeamColor(st.team);
    colorInput.value = c;
    if (st.isCreator) {
      colorInput.disabled = false;
      colorRow.classList.remove('readonly');
    } else {
      colorInput.disabled = true;
      colorRow.classList.add('readonly');
    }
  }

  // Members list
  const members = getMembers(st.team);
  if (membersEl) {
    membersEl.innerHTML = members.map(m => {
      const ownerKey = String(st.team.creatorUserId || '').trim() || nameToAccountId((st.team.creatorName || '').trim());
      const isOwner = ownerKey ? (entryAccountId(m) === ownerKey) : false;
      const canKick = st.isCreator && !isOwner;
      return `
        <div class="player-row">
          <div class="player-left">
            <span class="player-name" style="color:${esc(getDisplayTeamColor(st.team))}">${esc(m.name || '—')}</span>
          </div>
          ${canKick ? `<button class="icon-btn danger" type="button" data-kick="${esc(entryAccountId(m))}" title="Kick">×</button>` : ''}
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

  // Actions (small helper row) - keep empty for now but reserved for future.
  if (actionsEl) actionsEl.innerHTML = '';
}

/* =========================
   Requests modal (owner)
========================= */
function initRequestsModal() {
  const modal = document.getElementById('requests-modal');
  document.getElementById('requests-modal-close')?.addEventListener('click', closeRequestsModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeRequestsModal();
  });
}

function openRequestsModal() {
  const st = computeUserState(teamsCache);
  if (!st.isCreator || !st.teamId) return;
  const modal = document.getElementById('requests-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  renderRequestsModal();
}

function closeRequestsModal() {
  const modal = document.getElementById('requests-modal');
  if (modal) modal.style.display = 'none';
  setHint('requests-modal-hint', '');
}

function renderRequestsModal() {
  const st = computeUserState(teamsCache);
  const list = document.getElementById('requests-modal-list');
  if (!list) return;
  if (!st.isCreator || !st.team) {
    list.innerHTML = '<div class="empty-state">No team</div>';
    return;
  }

  const pending = getPending(st.team);
  list.innerHTML = pending.length
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

  list.querySelectorAll('[data-accept]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-accept');
      if (!uid) return;
      await acceptRequest(st.teamId, uid);
      renderRequestsModal();
      renderMyTeam(teamsCache);
    });
  });
  list.querySelectorAll('[data-decline]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const uid = btn.getAttribute('data-decline');
      if (!uid) return;
      await declineRequest(st.teamId, uid);
      renderRequestsModal();
      renderMyTeam(teamsCache);
    });
  });
}

/* =========================
   Chat (tab)
========================= */
function setBadge(el, count) {
  const node = typeof el === 'string' ? document.getElementById(el) : el;
  if (!node) return;
  const n = Number(count || 0);
  if (!n || n <= 0) {
    node.style.display = 'none';
    node.textContent = '';
    return;
  }
  node.style.display = 'inline-flex';
  node.textContent = n > 99 ? '99+' : String(n);
}

function getMyPlayerDoc() {
  const uid = getUserId();
  return (playersCache || []).find(p => String(p?.id || '').trim() === String(uid || '').trim()) || null;
}

function getReadMsGlobal() {
  const me = getMyPlayerDoc();
  const ts = me?.readReceipts?.global;
  const ms = tsToMs(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function getReadMsTeam(teamId) {
  const me = getMyPlayerDoc();
  const tid = String(teamId || '').trim();
  if (!tid) return 0;
  const ts = me?.readReceipts?.team?.[tid];
  const ms = tsToMs(ts);
  return Number.isFinite(ms) ? ms : 0;
}

function computeUnreadFromCache(cache, lastReadMs) {
  const myId = String(getUserId() || '').trim();
  let n = 0;
  for (const m of (cache || [])) {
    const createdMs = tsToMs(m?.createdAt);
    if (!Number.isFinite(createdMs) || createdMs <= lastReadMs) continue;
    const senderId = String(m?.senderId || '').trim();
    if (senderId && myId && senderId === myId) continue;
    n += 1;
  }
  return n;
}

function recomputeUnreadBadges() {
  // Global
  const globalLastRead = getReadMsGlobal();
  let g = computeUnreadFromCache(unreadGlobalCache, globalLastRead);

  // Team
  const st = computeUserState(teamsCache);
  const teamId = st?.teamId || '';
  const teamLastRead = teamId ? getReadMsTeam(teamId) : Number.MAX_SAFE_INTEGER;
  let t = teamId ? computeUnreadFromCache(unreadTeamCache, teamLastRead) : 0;

  // If user is currently viewing a chat, treat it as read.
  if (activePanelId === 'panel-chat') {
    if (chatMode === 'global') g = 0;
    if (chatMode === 'team') t = 0;
  }

  unreadGlobalCount = g;
  unreadTeamCount = t;

  setBadge('badge-global', unreadGlobalCount);
  setBadge('badge-team', unreadTeamCount);
  setBadge('badge-chat-desktop', unreadGlobalCount + unreadTeamCount);
  setBadge('badge-chat-mobile', unreadGlobalCount + unreadTeamCount);
}

function recomputeMyTeamTabBadge() {
  // My Team badge counts actionable team-related items:
  // - Pending join requests to *your* team if you are the creator
  // - Invites you have received (regardless of whether you're on a team)
  const st = computeUserState(teamsCache);
  let n = 0;
  if (st?.isCreator && st?.team) n += getPending(st.team).length;

  const me = getMyPlayerDoc();
  const invites = Array.isArray(me?.invites) ? me.invites : [];
  n += invites.length;

  setBadge('badge-myteam-desktop', n);
  setBadge('badge-myteam-mobile', n);
}

async function markChatRead(mode) {
  const now = Date.now();
  // Throttle writes to avoid spam.
  if (now - lastReadWriteAtMs < 1500) return;
  lastReadWriteAtMs = now;

  const uid = getUserId();
  const name = getUserName();
  if (!uid || !name) return;

  const ref = db.collection('players').doc(uid);
  try {
    if (mode === 'team') {
      const st = computeUserState(teamsCache);
      const tid = String(st?.teamId || '').trim();
      if (!tid) return;
      await ref.set({
        readReceipts: {
          team: { [tid]: firebase.firestore.FieldValue.serverTimestamp() }
        },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    } else {
      await ref.set({
        readReceipts: { global: firebase.firestore.FieldValue.serverTimestamp() },
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
  } catch (e) {
    // best-effort
  }
}

function initUnreadListeners() {
  // Global unread listener (always on)
  if (!unreadGlobalUnsub) {
    unreadGlobalUnsub = db.collection(GLOBAL_CHAT_COLLECTION)
      .orderBy('createdAt', 'asc')
      .limit(200)
      .onSnapshot((snap) => {
        unreadGlobalCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        recomputeUnreadBadges();
      }, () => {
        // ignore
      });
  }
  refreshUnreadTeamListener();
}

function refreshUnreadTeamListener() {
  const st = computeUserState(teamsCache);
  const tid = String(st?.teamId || '').trim();

  // If no team, clear the team cache and unsubscribe.
  if (!tid) {
    if (unreadTeamUnsub) {
      try { unreadTeamUnsub(); } catch (_) {}
      unreadTeamUnsub = null;
    }
    unreadTeamCache = [];
    recomputeUnreadBadges();
    return;
  }

  // If already listening to the right team, keep it.
  const currentListeningTeamId = unreadTeamUnsub?.__teamId || '';
  if (currentListeningTeamId === tid) return;

  if (unreadTeamUnsub) {
    try { unreadTeamUnsub(); } catch (_) {}
    unreadTeamUnsub = null;
  }
  unreadTeamCache = [];

  const unsub = db.collection('teams')
    .doc(tid)
    .collection('chat')
    .orderBy('createdAt', 'asc')
    .limit(200)
    .onSnapshot((snap) => {
      unreadTeamCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      recomputeUnreadBadges();
    }, () => {
      // ignore
    });
  // Tag the function so we know which team we're on.
  unsub.__teamId = tid;
  unreadTeamUnsub = unsub;
}

function initChatTab() {
  const btnGlobal = document.getElementById('chat-mode-global');
  const btnTeam = document.getElementById('chat-mode-team');
  const form = document.getElementById('chat-panel-form');

  const setMode = (mode) => {
    chatMode = mode === 'team' ? 'team' : 'global';
    btnGlobal?.classList.toggle('active', chatMode === 'global');
    btnTeam?.classList.toggle('active', chatMode === 'team');
    btnGlobal?.setAttribute('aria-selected', chatMode === 'global' ? 'true' : 'false');
    btnTeam?.setAttribute('aria-selected', chatMode === 'team' ? 'true' : 'false');

    // If chat panel is visible, resubscribe.
    if (activePanelId === 'panel-chat') {
      startChatSubscription();
      // Switching modes while in Chat should clear unread.
      markChatRead(chatMode);
    }
    recomputeUnreadBadges();
  };

  btnGlobal?.addEventListener('click', () => setMode('global'));
  btnTeam?.addEventListener('click', () => setMode('team'));

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendChatTabMessage();
  });

  initUnreadListeners();
  recomputeUnreadBadges();
}

function stopChatSubscription() {
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }
  chatMessagesCache = [];
  const list = document.getElementById('chat-panel-messages');
  if (list) list.innerHTML = '';
  setHint('chat-panel-hint', '');
}

function startChatSubscription() {
  const st = computeUserState(teamsCache);

  if (!st.name) {
    stopChatSubscription();
    setHint('chat-panel-hint', 'Set your name on Home first.');
    return;
  }

  // Clear any previous subscription.
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }

  const list = document.getElementById('chat-panel-messages');
  if (list) list.innerHTML = '<div class="empty-state">Loading…</div>';

  if (chatMode === 'team') {
    if (!st.teamId) {
      chatMessagesCache = [];
      renderChatTabMessages();
      setHint('chat-panel-hint', 'Join a team to use team chat.');
      return;
    }

    setHint('chat-panel-hint', '');
    chatUnsub = db.collection('teams')
      .doc(st.teamId)
      .collection('chat')
      .orderBy('createdAt', 'asc')
      .limit(200)
      .onSnapshot((snap) => {
        chatMessagesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChatTabMessages();
        if (activePanelId === 'panel-chat' && chatMode === 'team') {
          markChatRead('team');
        }
      }, (err) => {
        console.warn('Team chat listen failed', err);
        setHint('chat-panel-hint', 'Could not load team chat.');
      });
    return;
  }

  // Global chat
  setHint('chat-panel-hint', '');
  chatUnsub = db.collection(GLOBAL_CHAT_COLLECTION)
    .orderBy('createdAt', 'asc')
    .limit(200)
    .onSnapshot((snap) => {
      chatMessagesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderChatTabMessages();
      if (activePanelId === 'panel-chat' && chatMode === 'global') {
        markChatRead('global');
      }
    }, (err) => {
      console.warn('Global chat listen failed', err);
      setHint('chat-panel-hint', 'Could not load global chat.');
    });
}

function renderChatTabMessages() {
  const list = document.getElementById('chat-panel-messages');
  if (!list) return;

  if (!chatMessagesCache?.length) {
    list.innerHTML = '<div class="empty-state">No messages yet</div>';
    return;
  }

  const getTeamForMemberId = (memberId) => {
    const mid = String(memberId || '').trim();
    if (!mid) return null;
    for (const t of (teamsCache || [])) {
      if (findUserInMembers(t, mid)) return t;
    }
    return null;
  };

  list.innerHTML = chatMessagesCache.map(m => {
    const senderName = (m?.senderName || '—');
    const senderId = String(m?.senderId || '').trim() || nameToAccountId(senderName);
    const team = getTeamForMemberId(senderId);
    const teamName = team?.teamName ? String(team.teamName) : '';
    const color = team ? getDisplayTeamColor(team) : '';

    const label = teamName
      ? `${senderName} (team ${teamName})`
      : senderName;

    const whoStyle = color ? `style="color:${esc(color)}"` : '';

    return `
      <div class="chat-msg">
        <div class="chat-line"><span class="chat-who" ${whoStyle}>${esc(label)}:</span> <span class="chat-text">${esc(m?.text || '')}</span></div>
      </div>
    `;
  }).join('');

  try { list.scrollTop = list.scrollHeight; } catch (_) {}
}

async function sendChatTabMessage() {
  const st = computeUserState(teamsCache);
  if (!st.name) {
    setHint('chat-panel-hint', 'Set your name on Home first.');
    return;
  }

  const input = document.getElementById('chat-panel-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  try {
    if (chatMode === 'team') {
      if (!st.teamId) {
        setHint('chat-panel-hint', 'Join a team to use team chat.');
        return;
      }
      await db.collection('teams')
        .doc(st.teamId)
        .collection('chat')
        .add({
          senderId: st.userId,
          senderName: st.name,
          text,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
    } else {
      await db.collection(GLOBAL_CHAT_COLLECTION).add({
        senderId: st.userId,
        senderName: st.name,
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    }
    if (input) input.value = '';
    setHint('chat-panel-hint', '');
    // Play message sent sound
    if (window.playSound) window.playSound('message');
  } catch (e) {
    console.warn('Could not send chat message', e);
    setHint('chat-panel-hint', 'Could not send message.');
    // Play error sound
    if (window.playSound) window.playSound('error');
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
  if (modal) {
    modal.style.display = 'flex';
    // Trigger reflow for animation
    void modal.offsetWidth;
    modal.classList.add('modal-open');
  }
  const input = document.getElementById('create-teamName');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function closeCreateTeamModal() {
  const modal = document.getElementById('create-team-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
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
  const colorInput = document.getElementById('create-teamColor');
  const rawColor = (colorInput?.value || '#3b82f6').trim();
  const teamColor = isValidHexColor(rawColor) ? rawColor : '#3b82f6';
  if (!teamName) {
    setHint('create-team-hint', 'Enter a team name.');
    return;
  }

  setHint('create-team-hint', 'Creating…');

  try {
    const teamKey = teamNameToKey(teamName);
    if (!teamKey) throw new Error('Enter a team name.');

    const teamsCol = db.collection('teams');
    const teamRef = teamsCol.doc(); // pre-generate id for registry
    const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(teamKey);

    await db.runTransaction(async (tx) => {
      const nameSnap = await tx.get(nameRef);
      if (nameSnap.exists) {
        const existingTeamId = String(nameSnap.data()?.teamId || '').trim();
        if (existingTeamId) throw new Error('That team name is already taken.');
      }

      tx.set(teamRef, {
        teamName,
        teamColor,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        creatorUserId: st.userId,
        creatorName: st.name,
        members: [{ userId: st.userId, name: st.name }],
        pending: []
      });

      tx.set(nameRef, {
        teamId: teamRef.id,
        teamName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        ...(nameSnap.exists ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
      }, { merge: true });
    });

    setHint('create-team-hint', 'Created!');
    closeCreateTeamModal();
    // Switch to My Team tab
    activatePanel('panel-myteam');
  } catch (e) {
    console.error(e);
    setHint('create-team-hint', (e && e.message) ? e.message : 'Could not create team.');
  }
}

async function leaveTeam(teamId, userId) {
  const ref = db.collection('teams').doc(teamId);
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      const members = getMembers(t);
      tx.update(ref, { members: members.filter(m => !isSameAccount(m, userId)) });
    });
    activatePanel('panel-teams');
  } catch (e) {
    console.error(e);
    setHint('teams-hint', e?.message || 'Could not leave team.');
  }
}

async function deleteTeam(teamId) {
  const tid = String(teamId || '').trim();
  if (!tid) return;

  const teamRef = db.collection('teams').doc(tid);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(teamRef);
      if (!snap.exists) return;
      const t = { id: snap.id, ...snap.data() };
      const key = teamNameToKey(String(t.teamName || '').trim());
      if (key) {
        const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
        const nameSnap = await tx.get(nameRef);
        const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
        if (mappedId === tid) tx.delete(nameRef);
      }
      tx.delete(teamRef);
    });

    closeRequestsModal();
    activatePanel('panel-teams');
  } catch (e) {
    console.error(e);
    setHint('teams-hint', e?.message || 'Could not delete team.');
  }
}


async function renameTeamUnique(teamId, nextName) {
  const tid = String(teamId || '').trim();
  const name = (nextName || '').trim();
  if (!tid || !name) return;

  const teamRef = db.collection('teams').doc(tid);
  const nextKey = teamNameToKey(name);
  if (!nextKey) throw new Error('Enter a team name.');

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(teamRef);
    if (!snap.exists) throw new Error('Team not found.');
    const t = { id: snap.id, ...snap.data() };
    const prevName = String(t.teamName || '').trim();
    const prevKey = teamNameToKey(prevName);

    const nextRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(nextKey);
    const prevRef = (prevKey && prevKey !== nextKey) ? db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(prevKey) : null;

    const nextSnap = await tx.get(nextRef);
    if (nextSnap.exists) {
      const existingTeamId = String(nextSnap.data()?.teamId || '').trim();
      if (existingTeamId && existingTeamId !== tid) throw new Error('That team name is already taken.');
    }

    tx.update(teamRef, { teamName: name });

    tx.set(nextRef, {
      teamId: tid,
      teamName: name,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      ...(nextSnap.exists ? {} : { createdAt: firebase.firestore.FieldValue.serverTimestamp() })
    }, { merge: true });

    if (prevRef) {
      const prevSnap = await tx.get(prevRef);
      const prevTeamId = prevSnap.exists ? String(prevSnap.data()?.teamId || '').trim() : '';
      if (prevTeamId === tid) tx.delete(prevRef);
    }
  });
}

/* =========================
   Team management actions
========================= */
async function acceptRequest(teamId, userId) {
  const st = computeUserState(teamsCache);
  if (!st.isCreator || st.teamId !== teamId) return;

  const tid = String(teamId || '').trim();
  if (!tid) return;

  const allTeamIds = (teamsCache || []).map(t => String(t.id || '').trim()).filter(Boolean);
  const teamRefs = allTeamIds.map(id => db.collection('teams').doc(id));
  const teamRef = db.collection('teams').doc(tid);

  try {
    await db.runTransaction(async (tx) => {
      const snaps = await Promise.all(teamRefs.map(r => tx.get(r)));
      const teams = [];
      for (const s of snaps) {
        if (!s.exists) continue;
        teams.push({ id: s.id, ...s.data() });
      }

      const targetTeam = teams.find(t => t.id === tid);
      if (!targetTeam) throw new Error('Team not found.');

      const members = getMembers(targetTeam);
      if (members.length >= TEAM_MAX) throw new Error('Team is full.');

      // Find the request by account (robust to legacy/migrated ids).
      const pending = getPending(targetTeam);
      const req = pending.find(r => isSameAccount(r, userId)) || pending.find(r => String(r.userId || '').trim() === String(userId || '').trim());
      if (!req) return;

      const targetId = entryAccountId(req) || String(userId || '').trim();
      const targetName = (req.name || '—').trim();

      // Add to target team, remove from its pending.
      const nextPending = pending.filter(r => !isSameAccount(r, targetId));
      const nextMembers = dedupeRosterByAccount(members.concat([{ userId: targetId, name: targetName }]));
      tx.update(teamRef, { pending: nextPending, members: nextMembers });

      // Clear all other pending requests for that person (across all teams).
      for (const t of teams) {
        const p = getPending(t);
        if (!p?.length) continue;
        const next = p.filter(r => !isSameAccount(r, targetId));
        if (next.length !== p.length) {
          tx.update(db.collection('teams').doc(t.id), { pending: next });
        }
      }

      // If they were already on another team, remove them (switch).
      const oldTeam = teams.find(t => t.id !== tid && getMembers(t).some(m => isSameAccount(m, targetId))) || null;
      if (oldTeam) {
        const oldTeamId = String(oldTeam.id || '').trim();
        const oldMembers = getMembers(oldTeam);
        const nextOldMembers = oldMembers.filter(m => !isSameAccount(m, targetId));

        const oldCreatorKey = nameToAccountId((oldTeam.creatorName || '').trim());
        const targetNameKey = nameToAccountId(targetName);
        const leavingIsCreator = !!(
          String(oldTeam.creatorUserId || '').trim() === String(targetId || '').trim() ||
          (oldCreatorKey && targetNameKey && oldCreatorKey === targetNameKey) ||
          (oldCreatorKey && oldCreatorKey === String(targetId || '').trim())
        );

        if (nextOldMembers.length === 0) {
          // Delete team + free its name.
          const key = teamNameToKey(String(oldTeam.teamName || '').trim());
          if (key) {
            const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
            const nameSnap = await tx.get(nameRef);
            const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
            if (mappedId === oldTeamId) tx.delete(nameRef);
          }
          tx.delete(db.collection('teams').doc(oldTeamId));
        } else if (leavingIsCreator) {
          const nextCreator = nextOldMembers[Math.floor(Math.random() * nextOldMembers.length)];
          tx.update(db.collection('teams').doc(oldTeamId), {
            members: nextOldMembers,
            creatorUserId: entryAccountId(nextCreator),
            creatorName: (nextCreator?.name || '').trim() || oldTeam.creatorName || ''
          });
        } else {
          tx.update(db.collection('teams').doc(oldTeamId), { members: nextOldMembers });
        }
      }
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
      tx.update(ref, { members: members.filter(m => !isSameAccount(m, userId)) });
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
      const idx = members.findIndex(m => isSameAccount(m, userId));
      if (idx === -1) return;
      const updated = members.slice();
      updated[idx] = { ...updated[idx], userId: String(userId || '').trim(), name };
      tx.update(ref, { members: updated });
      // keep creatorName in sync if creator updated
      if (t.creatorUserId === userId || nameToAccountId((t.creatorName || '').trim()) === String(userId || '').trim()) {
        tx.update(ref, { creatorName: name });
      }
    });
  } catch (e) {
    // best-effort
    console.warn('Could not update member name', e);
  }
}

async function updateNameInAllTeams(userId, name) {
  const uid = String(userId || '').trim();
  const n = String(name || '').trim();
  if (!uid || !n) return;

  // A user can only be on one team, but may appear in pending/legacy fields.
  for (const t of (teamsCache || [])) {
    const teamId = String(t?.id || '').trim();
    if (!teamId) continue;
    const ref = db.collection('teams').doc(teamId);
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const team = { id: snap.id, ...snap.data() };

        let changed = false;

        const nextMembers = getMembers(team).map(m => {
          if (!isSameAccount(m, uid)) return m;
          if (String(m?.name || '').trim() !== n) changed = true;
          return { ...m, userId: uid, name: n };
        });

        const nextPending = getPending(team).map(r => {
          if (!isSameAccount(r, uid)) return r;
          if (String(r?.name || '').trim() !== n) changed = true;
          return { ...r, userId: uid, name: n };
        });

        // Keep creatorName in sync when this account is the creator.
        const creatorUserId = String(team.creatorUserId || '').trim();
        const creatorKey = nameToAccountId((team.creatorName || '').trim());
        const isCreator = (creatorUserId && creatorUserId === uid) || (creatorKey && creatorKey === uid);
        let nextCreatorName = team.creatorName;
        let nextCreatorUserId = team.creatorUserId;
        if (isCreator) {
          if (String(team.creatorName || '').trim() !== n) changed = true;
          nextCreatorName = n;
          nextCreatorUserId = uid;
        }

        if (!changed) return;
        tx.update(ref, {
          members: dedupeRosterByAccount(nextMembers),
          pending: dedupeRosterByAccount(nextPending),
          ...(isCreator ? { creatorName: nextCreatorName, creatorUserId: nextCreatorUserId } : {})
        });
      });
    } catch (e) {
      // best-effort
      console.warn('Could not update name in team', teamId, e);
    }
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

function setHTML(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = String(html);
}

function setHint(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value || '';
}

function activatePanel(panelId) {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const targetId = String(panelId || '').trim();
  if (!targetId) return;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === targetId));
  panels.forEach(p => p.classList.toggle('active', p.id === targetId));
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

function logoutLocal() {
  // Local-only "logout": clears this device's saved name + id so it is no longer
  // linked to any shared name-based account.
  try { localStorage.removeItem(LS_USER_NAME); } catch (_) {}
  try { localStorage.removeItem(LS_USER_ID); } catch (_) {}
  // Full refresh keeps the app state consistent (listeners, cached state, theme).
  try { window.location.reload(); } catch (_) {}
}

/* =========================
   Settings & Sound Effects
========================= */

// Settings state
let settingsAnimations = true;
let settingsSounds = true;
let settingsVolume = 70;

// Audio context for sound effects
let audioCtx = null;

function initSettings() {
  // Load saved settings from localStorage
  const savedAnimations = safeLSGet(LS_SETTINGS_ANIMATIONS);
  const savedSounds = safeLSGet(LS_SETTINGS_SOUNDS);
  const savedVolume = safeLSGet(LS_SETTINGS_VOLUME);

  settingsAnimations = savedAnimations !== 'false';
  settingsSounds = savedSounds !== 'false';
  settingsVolume = savedVolume ? parseInt(savedVolume, 10) : 70;

  // Apply initial state
  applyAnimationsSetting();

  // Get UI elements
  const gearBtn = document.getElementById('settings-gear-btn');
  const modal = document.getElementById('settings-modal');
  const backdrop = document.getElementById('settings-modal-backdrop');
  const closeBtn = document.getElementById('settings-modal-close');
  const animToggle = document.getElementById('settings-animations-toggle');
  const soundToggle = document.getElementById('settings-sounds-toggle');
  const volumeSlider = document.getElementById('settings-volume-slider');
  const volumeValue = document.getElementById('settings-volume-value');
  const testSoundBtn = document.getElementById('settings-test-sound');

  if (!gearBtn || !modal) return;

  // Set initial values
  if (animToggle) animToggle.checked = settingsAnimations;
  if (soundToggle) soundToggle.checked = settingsSounds;
  if (volumeSlider) volumeSlider.value = settingsVolume;
  if (volumeValue) volumeValue.textContent = settingsVolume + '%';

  // Open modal
  gearBtn.addEventListener('click', () => {
    playSound('click');
    openSettingsModal();
  });

  // Close modal
  closeBtn?.addEventListener('click', () => {
    playSound('click');
    closeSettingsModal();
  });
  backdrop?.addEventListener('click', () => {
    playSound('click');
    closeSettingsModal();
  });

  // Animations toggle
  animToggle?.addEventListener('change', () => {
    settingsAnimations = animToggle.checked;
    safeLSSet(LS_SETTINGS_ANIMATIONS, settingsAnimations ? 'true' : 'false');
    applyAnimationsSetting();
    playSound('toggle');
  });

  // Sounds toggle
  soundToggle?.addEventListener('change', () => {
    settingsSounds = soundToggle.checked;
    safeLSSet(LS_SETTINGS_SOUNDS, settingsSounds ? 'true' : 'false');
    if (settingsSounds) playSound('toggle');
  });

  // Volume slider
  volumeSlider?.addEventListener('input', () => {
    settingsVolume = parseInt(volumeSlider.value, 10);
    if (volumeValue) volumeValue.textContent = settingsVolume + '%';
    safeLSSet(LS_SETTINGS_VOLUME, String(settingsVolume));
  });

  // Log Out button in settings
  const settingsLogoutBtn = document.getElementById('settings-logout-btn');
  settingsLogoutBtn?.addEventListener('click', () => {
    const ok = window.confirm('Are you sure you want to log out?');
    if (!ok) return;
    closeSettingsModal();
    logoutLocal();
  });

  // Delete Account button in settings
  const settingsDeleteBtn = document.getElementById('settings-delete-account-btn');
  settingsDeleteBtn?.addEventListener('click', () => {
    const ok = window.confirm('Are you sure you want to delete your account? This cannot be undone.');
    if (!ok) return;
    closeSettingsModal();
    logoutLocal();
  });

  // Test sound button
  testSoundBtn?.addEventListener('click', () => {
    playSound('success');
  });

  // Keyboard escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('modal-open')) {
      closeSettingsModal();
    }
  });
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.style.display = 'block';
  // Trigger reflow for animation
  void modal.offsetWidth;
  modal.classList.add('modal-open');
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
}

function applyAnimationsSetting() {
  if (settingsAnimations) {
    document.body.classList.remove('no-animations');
  } else {
    document.body.classList.add('no-animations');
  }
}

// Sound Effects System using Web Audio API
function getAudioContext() {
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported');
      return null;
    }
  }
  // Resume if suspended (required for autoplay policies)
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  return audioCtx;
}

// Sound definitions using Web Audio synthesis
const SOUNDS = {
  click: { type: 'click', freq: 800, duration: 0.05 },
  toggle: { type: 'toggle', freq: 600, duration: 0.08 },
  success: { type: 'success', freqs: [523, 659, 784], duration: 0.15 },
  error: { type: 'error', freq: 200, duration: 0.2 },
  hover: { type: 'hover', freq: 1200, duration: 0.03 },
  tabSwitch: { type: 'click', freq: 900, duration: 0.04 },
  modalOpen: { type: 'swoosh', freq: 400, duration: 0.15 },
  modalClose: { type: 'swoosh', freq: 300, duration: 0.1 },
  message: { type: 'message', freq: 880, duration: 0.1 },
  notification: { type: 'notification', freqs: [659, 784], duration: 0.12 },
  cardReveal: { type: 'reveal', freq: 440, duration: 0.2 },
  cardCorrect: { type: 'success', freqs: [523, 659, 784], duration: 0.2 },
  cardWrong: { type: 'error', freq: 180, duration: 0.3 },
  cardAssassin: { type: 'assassin', freq: 100, duration: 0.5 },
  turnStart: { type: 'turn', freq: 660, duration: 0.15 },
  clueGiven: { type: 'clue', freqs: [440, 554, 659], duration: 0.2 },
  gameStart: { type: 'fanfare', freqs: [523, 659, 784, 1047], duration: 0.3 },
  gameWin: { type: 'victory', freqs: [523, 659, 784, 1047, 1319], duration: 0.4 },
  gameLose: { type: 'defeat', freqs: [392, 330, 262], duration: 0.5 },
  timerTick: { type: 'tick', freq: 1000, duration: 0.02 },
  timerWarning: { type: 'warning', freq: 880, duration: 0.1 },
  buttonHover: { type: 'hover', freq: 1100, duration: 0.025 },
  ready: { type: 'ready', freqs: [440, 554], duration: 0.15 },
  join: { type: 'join', freq: 523, duration: 0.12 },
  leave: { type: 'leave', freq: 330, duration: 0.15 },
  invite: { type: 'notification', freqs: [784, 988], duration: 0.15 },
  endTurn: { type: 'endTurn', freq: 350, duration: 0.12 },
};

function playSound(soundName) {
  if (!settingsSounds) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  const sound = SOUNDS[soundName];
  if (!sound) return;

  const volume = settingsVolume / 100;
  const masterGain = ctx.createGain();
  masterGain.gain.value = volume * 0.3; // Base volume adjustment
  masterGain.connect(ctx.destination);

  const now = ctx.currentTime;

  switch (sound.type) {
    case 'click':
    case 'hover':
    case 'toggle':
    case 'tick':
      playSingleTone(ctx, masterGain, sound.freq, sound.duration, now, 'sine');
      break;

    case 'success':
    case 'notification':
    case 'ready':
    case 'clue':
      playArpeggio(ctx, masterGain, sound.freqs, sound.duration, now);
      break;

    case 'error':
      playErrorSound(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'swoosh':
      playSwoosh(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'message':
      playMessageSound(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'reveal':
      playRevealSound(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'assassin':
      playAssassinSound(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'turn':
    case 'join':
      playSingleTone(ctx, masterGain, sound.freq, sound.duration, now, 'triangle');
      break;

    case 'leave':
    case 'endTurn':
      playSingleTone(ctx, masterGain, sound.freq, sound.duration, now, 'sawtooth', true);
      break;

    case 'warning':
      playWarningSound(ctx, masterGain, sound.freq, sound.duration, now);
      break;

    case 'fanfare':
    case 'victory':
      playFanfare(ctx, masterGain, sound.freqs, sound.duration, now);
      break;

    case 'defeat':
      playDefeatSound(ctx, masterGain, sound.freqs, sound.duration, now);
      break;

    default:
      playSingleTone(ctx, masterGain, sound.freq || 440, sound.duration || 0.1, now, 'sine');
  }
}

function playSingleTone(ctx, destination, freq, duration, startTime, waveType = 'sine', fadeDown = false) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = waveType;
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0.5, startTime);
  if (fadeDown) {
    gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  } else {
    gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration * 0.8);
  }

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playArpeggio(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq;

    const noteStart = startTime + i * noteDuration * 0.5;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.4, noteStart + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

function playErrorSound(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, startTime + duration);

  gain.gain.setValueAtTime(0.3, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playSwoosh(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq * 0.5, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 2, startTime + duration);

  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(freq, startTime);
  filter.frequency.exponentialRampToValueAtTime(freq * 4, startTime + duration);

  gain.gain.setValueAtTime(0.2, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  osc.connect(filter);
  filter.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playMessageSound(ctx, destination, freq, duration, startTime) {
  [1, 1.25].forEach((mult, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.value = freq * mult;

    const noteStart = startTime + i * 0.05;
    gain.gain.setValueAtTime(0.3, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + duration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(noteStart);
    osc.stop(noteStart + duration);
  });
}

function playRevealSound(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 0.8, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.2, startTime + duration * 0.5);
  osc.frequency.exponentialRampToValueAtTime(freq, startTime + duration);

  gain.gain.setValueAtTime(0.4, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  osc.connect(gain);
  gain.connect(destination);

  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playAssassinSound(ctx, destination, freq, duration, startTime) {
  // Low rumble
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();

  osc1.type = 'sawtooth';
  osc1.frequency.setValueAtTime(freq, startTime);
  osc1.frequency.exponentialRampToValueAtTime(freq * 0.3, startTime + duration);

  gain1.gain.setValueAtTime(0.4, startTime);
  gain1.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  osc1.connect(gain1);
  gain1.connect(destination);

  osc1.start(startTime);
  osc1.stop(startTime + duration);

  // Noise burst
  const bufferSize = ctx.sampleRate * duration;
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.3));
  }

  const noise = ctx.createBufferSource();
  const noiseGain = ctx.createGain();
  const filter = ctx.createBiquadFilter();

  noise.buffer = buffer;
  filter.type = 'lowpass';
  filter.frequency.value = 200;

  noiseGain.gain.setValueAtTime(0.3, startTime);
  noiseGain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);

  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(destination);

  noise.start(startTime);
}

function playWarningSound(ctx, destination, freq, duration, startTime) {
  [0, 0.08].forEach((offset) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'square';
    osc.frequency.value = freq;

    const noteStart = startTime + offset;
    gain.gain.setValueAtTime(0.15, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + duration * 0.5);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(noteStart);
    osc.stop(noteStart + duration);
  });
}

function playFanfare(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.value = freq;

    const noteStart = startTime + i * noteDuration * 0.4;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.35, noteStart + 0.03);
    gain.gain.setValueAtTime(0.35, noteStart + noteDuration * 0.6);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration * 1.5);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(noteStart);
    osc.stop(noteStart + noteDuration * 1.5);
  });
}

function playDefeatSound(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sawtooth';
    osc.frequency.value = freq;

    const noteStart = startTime + i * noteDuration * 0.6;
    gain.gain.setValueAtTime(0.25, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);

    osc.connect(gain);
    gain.connect(destination);

    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

// Add ripple effect to buttons
function addRippleEffect(element) {
  if (!element) return;
  element.addEventListener('click', function() {
    this.classList.remove('ripple');
    void this.offsetWidth; // Trigger reflow
    this.classList.add('ripple');
    setTimeout(() => this.classList.remove('ripple'), 300);
  });
}

// Initialize sound effects on common interactions
function initGlobalSoundEffects() {
  // Tab clicks
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => playSound('tabSwitch'));
  });

  // All buttons
  document.querySelectorAll('.btn').forEach(btn => {
    btn.addEventListener('click', () => playSound('click'));
    addRippleEffect(btn);
  });

  // Mode cards
  document.querySelectorAll('.mode-card').forEach(card => {
    card.addEventListener('click', () => playSound('click'));
  });

  // Input focus
  document.querySelectorAll('.input').forEach(input => {
    input.addEventListener('focus', () => playSound('hover'));
  });

  // Toggle switches
  document.querySelectorAll('.toggle-switch input').forEach(toggle => {
    toggle.addEventListener('change', () => playSound('toggle'));
  });

  // Select changes
  document.querySelectorAll('select').forEach(select => {
    select.addEventListener('change', () => playSound('click'));
  });

  // Deck picker cards
  document.querySelectorAll('.qp-deck-card').forEach(card => {
    card.addEventListener('click', () => playSound('click'));
  });
}

// Call this after DOM is ready
document.addEventListener('DOMContentLoaded', initGlobalSoundEffects);

// Export for game.js to use
window.playSound = playSound;

/* =========================
   Online Presence System
========================= */

const PRESENCE_COLLECTION = 'presence';
const PRESENCE_INACTIVE_MS = 5 * 60 * 1000;  // 5 minutes
const PRESENCE_OFFLINE_MS = 15 * 60 * 1000;  // 15 minutes
const PRESENCE_UPDATE_INTERVAL_MS = 60 * 1000; // Update every 1 minute

let presenceUnsub = null;
let presenceCache = [];
let presenceUpdateInterval = null;
let lastActivityTime = Date.now();

function initPresence() {
  const name = getUserName();
  if (!name) return;

  // Update presence immediately
  updatePresence();

  // Set up periodic presence updates
  if (presenceUpdateInterval) clearInterval(presenceUpdateInterval);
  presenceUpdateInterval = setInterval(updatePresence, PRESENCE_UPDATE_INTERVAL_MS);

  // Track user activity
  const activityEvents = ['mousedown', 'keydown', 'touchstart', 'scroll', 'mousemove'];
  const throttledActivity = throttle(() => {
    lastActivityTime = Date.now();
  }, 10000); // Throttle to once per 10 seconds

  activityEvents.forEach(evt => {
    document.addEventListener(evt, throttledActivity, { passive: true });
  });

  // Update presence on visibility change
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      lastActivityTime = Date.now();
      updatePresence();
    }
  });

  // Update presence before unload
  window.addEventListener('beforeunload', () => {
    // Mark as going offline
    const userId = getUserId();
    if (userId) {
      // Use sendBeacon for reliable delivery on page close
      const presenceRef = db.collection(PRESENCE_COLLECTION).doc(userId);
      presenceRef.update({
        lastActivity: firebase.firestore.FieldValue.serverTimestamp()
      }).catch(() => {});
    }
  });

  // Start listening to all presence docs
  startPresenceListener();
}

function throttle(fn, wait) {
  let last = 0;
  return function(...args) {
    const now = Date.now();
    if (now - last >= wait) {
      last = now;
      fn.apply(this, args);
    }
  };
}

async function updatePresence() {
  const userId = getUserId();
  const name = getUserName();
  if (!userId || !name) return;

  try {
    const presenceRef = db.collection(PRESENCE_COLLECTION).doc(userId);
    await presenceRef.set({
      odId: userId,
      name: name,
      lastActivity: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (e) {
    console.warn('Presence update failed:', e);
  }
}

function startPresenceListener() {
  if (presenceUnsub) return;

  presenceUnsub = db.collection(PRESENCE_COLLECTION)
    .orderBy('lastActivity', 'desc')
    .onSnapshot(snap => {
      presenceCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderOnlineCounter();
    }, err => {
      console.warn('Presence listener error:', err);
    });
}

function stopPresenceListener() {
  if (presenceUnsub) {
    presenceUnsub();
    presenceUnsub = null;
  }
}

function getPresenceStatus(presence) {
  if (!presence?.lastActivity) return 'offline';

  const lastMs = typeof presence.lastActivity.toMillis === 'function'
    ? presence.lastActivity.toMillis()
    : (presence.lastActivity.seconds ? presence.lastActivity.seconds * 1000 : 0);

  const now = Date.now();
  const diff = now - lastMs;

  if (diff < PRESENCE_INACTIVE_MS) return 'online';
  // Rename "inactive" to "idle" in the UI/status model.
  if (diff < PRESENCE_OFFLINE_MS) return 'idle';
  return 'offline';
}

function getTimeSinceActivity(presence) {
  if (!presence?.lastActivity) return '';

  const lastMs = typeof presence.lastActivity.toMillis === 'function'
    ? presence.lastActivity.toMillis()
    : (presence.lastActivity.seconds ? presence.lastActivity.seconds * 1000 : 0);

  const now = Date.now();
  const diff = now - lastMs;
  const minutes = Math.floor(diff / 60000);

  if (minutes < 1) return 'just now';
  if (minutes === 1) return '1 minute ago';
  if (minutes < 60) return `${minutes} minutes ago`;

  const hours = Math.floor(minutes / 60);
  if (hours === 1) return '1 hour ago';
  if (hours < 24) return `${hours} hours ago`;

  const days = Math.floor(hours / 24);
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

function renderOnlineCounter() {
  const countEl = document.getElementById('online-count');
  if (!countEl) return;

  const online = presenceCache.filter(p => getPresenceStatus(p) === 'online');
  countEl.textContent = online.length;
}

function initOnlineCounterUI() {
  const btn = document.getElementById('online-counter-btn');
  const modal = document.getElementById('online-modal');
  const backdrop = document.getElementById('online-modal-backdrop');
  const closeBtn = document.getElementById('online-modal-close');

  if (!btn || !modal) return;

  btn.addEventListener('click', () => {
    playSound('click');
    openOnlineModal();
  });

  closeBtn?.addEventListener('click', () => {
    playSound('click');
    closeOnlineModal();
  });

  backdrop?.addEventListener('click', () => {
    playSound('click');
    closeOnlineModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'block') {
      closeOnlineModal();
    }
  });
}

function openOnlineModal() {
  const modal = document.getElementById('online-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  void modal.offsetWidth; // Trigger reflow for animation
  modal.classList.add('modal-open');
  renderOnlineUsersList();
}

function closeOnlineModal() {
  const modal = document.getElementById('online-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
}

function renderOnlineUsersList() {
  const listEl = document.getElementById('online-users-list');
  if (!listEl) return;

  const myId = getUserId();

  const roster = buildRosterIndex(teamsCache);

  // Get teammate IDs if filtering by teammates
  let teammateIds = new Set();
  if (onlineModalTab === 'teammates') {
    const st = computeUserState(teamsCache);
    if (st.team && st.team.members) {
      for (const m of st.team.members) {
        if (m.userId) teammateIds.add(m.userId);
      }
    }
  }

  // Filter by tab
  let filtered = [...presenceCache];
  if (onlineModalTab === 'teammates') {
    filtered = filtered.filter(p => {
      const odId = p.id || p.odId;
      return teammateIds.has(odId);
    });
  }

  // Sort users by status: online first, then idle, then offline
  const statusOrder = { online: 0, idle: 1, offline: 2 };
  const sorted = filtered.sort((a, b) => {
    const statusA = getPresenceStatus(a);
    const statusB = getPresenceStatus(b);
    if (statusOrder[statusA] !== statusOrder[statusB]) {
      return statusOrder[statusA] - statusOrder[statusB];
    }
    // Within same status, sort by lastActivity descending
    const aMs = a.lastActivity?.toMillis?.() || 0;
    const bMs = b.lastActivity?.toMillis?.() || 0;
    return bMs - aMs;
  });

  // Group by status
  const groups = { online: [], idle: [], offline: [] };
  for (const p of sorted) {
    const status = getPresenceStatus(p);
    groups[status].push(p);
  }

  let html = '';

  // Online users
  if (groups.online.length > 0) {
    html += `<div class="online-section-title">Online (${groups.online.length})</div>`;
    for (const p of groups.online) {
      const isYou = p.id === myId || p.odId === myId;
      const uid = String(p.id || p.odId || '').trim();
      const displayName = (p.name || findKnownUserName(uid) || 'Unknown').trim();
      const memberTeam = roster.memberTeamByUserId.get(uid);
      const teamName = memberTeam ? (memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = teamName ? ` <span class="online-user-team-inline">(${esc(teamName)})</span>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot online"></div>
          <div class="online-user-name" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">active</div>
        </div>
      `;
    }
  }

  // Idle users
  if (groups.idle.length > 0) {
    html += `<div class="online-section-title">Idle (${groups.idle.length})</div>`;
    for (const p of groups.idle) {
      const isYou = p.id === myId || p.odId === myId;
      const uid = String(p.id || p.odId || '').trim();
      const displayName = (p.name || findKnownUserName(uid) || 'Unknown').trim();
      const memberTeam = roster.memberTeamByUserId.get(uid);
      const teamName = memberTeam ? (memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = teamName ? ` <span class="online-user-team-inline">(${esc(teamName)})</span>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot inactive"></div>
          <div class="online-user-name" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">${getTimeSinceActivity(p)}</div>
        </div>
      `;
    }
  }

  // Offline users
  if (groups.offline.length > 0) {
    html += `<div class="online-section-title">Offline (${groups.offline.length})</div>`;
    for (const p of groups.offline) {
      const isYou = p.id === myId || p.odId === myId;
      const uid = String(p.id || p.odId || '').trim();
      const displayName = (p.name || findKnownUserName(uid) || 'Unknown').trim();
      const memberTeam = roster.memberTeamByUserId.get(uid);
      const teamName = memberTeam ? (memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = teamName ? ` <span class="online-user-team-inline">(${esc(teamName)})</span>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot offline"></div>
          <div class="online-user-name" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">last seen ${getTimeSinceActivity(p)}</div>
        </div>
      `;
    }
  }

  if (!html) {
    if (onlineModalTab === 'teammates') {
      html = '<div class="online-user-row"><div class="online-user-name">No teammates online</div></div>';
    } else {
      html = '<div class="online-user-row"><div class="online-user-name">No users yet</div></div>';
    }
  }

  listEl.innerHTML = html;
}

// Online modal tab state
let onlineModalTab = 'everyone';

function initOnlineModalTabs() {
  const everyoneTab = document.getElementById('online-tab-everyone');
  const teammatesTab = document.getElementById('online-tab-teammates');

  everyoneTab?.addEventListener('click', () => {
    playSound('click');
    onlineModalTab = 'everyone';
    everyoneTab.classList.add('active');
    everyoneTab.setAttribute('aria-selected', 'true');
    teammatesTab?.classList.remove('active');
    teammatesTab?.setAttribute('aria-selected', 'false');
    renderOnlineUsersList();
  });

  teammatesTab?.addEventListener('click', () => {
    playSound('click');
    onlineModalTab = 'teammates';
    teammatesTab.classList.add('active');
    teammatesTab.setAttribute('aria-selected', 'true');
    everyoneTab?.classList.remove('active');
    everyoneTab?.setAttribute('aria-selected', 'false');
    renderOnlineUsersList();
  });
}

// Call this in initOnlineCounterUI
document.addEventListener('DOMContentLoaded', initOnlineModalTabs);

/* =========================
   Name Change Modal
========================= */
function initNameChangeModal() {
  const modal = document.getElementById('name-change-modal');
  const backdrop = document.getElementById('name-change-modal-backdrop');
  const closeBtn = document.getElementById('name-change-modal-close');
  const cancelBtn = document.getElementById('name-change-cancel');
  const form = document.getElementById('name-change-form');
  const input = document.getElementById('name-change-input');

  if (!modal) return;

  closeBtn?.addEventListener('click', () => {
    playSound('click');
    closeNameChangeModal();
  });

  cancelBtn?.addEventListener('click', () => {
    playSound('click');
    closeNameChangeModal();
  });

  backdrop?.addEventListener('click', () => {
    playSound('click');
    closeNameChangeModal();
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const newName = (input?.value || '').trim();
    if (!newName) return;

    playSound('click');
    await setUserName(newName);
    closeNameChangeModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeNameChangeModal();
    }
  });
}

function openNameChangeModal() {
  const modal = document.getElementById('name-change-modal');
  const input = document.getElementById('name-change-input');
  if (!modal) return;

  // Pre-fill with current name
  if (input) input.value = getUserName() || '';

  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('modal-open');

  // Focus the input
  setTimeout(() => input?.focus(), 100);
}

function closeNameChangeModal() {
  const modal = document.getElementById('name-change-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
}

/* =========================
   Teammates Modal
========================= */
function initTeammatesModal() {
  const modal = document.getElementById('teammates-modal');
  const backdrop = document.getElementById('teammates-modal-backdrop');
  const closeBtn = document.getElementById('teammates-modal-close');

  if (!modal) return;

  closeBtn?.addEventListener('click', () => {
    playSound('click');
    closeTeammatesModal();
  });

  backdrop?.addEventListener('click', () => {
    playSound('click');
    closeTeammatesModal();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      closeTeammatesModal();
    }
  });
}

function openTeammatesModal() {
  const modal = document.getElementById('teammates-modal');
  if (!modal) return;

  renderTeammatesList();

  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('modal-open');
}

function closeTeammatesModal() {
  const modal = document.getElementById('teammates-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
}

function renderTeammatesList() {
  const listEl = document.getElementById('teammates-modal-list');
  const titleEl = document.getElementById('teammates-modal-title');
  const hintEl = document.getElementById('teammates-modal-hint');
  if (!listEl) return;

  const st = computeUserState(teamsCache);
  const myId = getUserId();

  const roster = buildRosterIndex(teamsCache);

  if (!st.team) {
    if (titleEl) titleEl.textContent = 'My Team';
    if (hintEl) hintEl.textContent = 'You are not on a team yet.';
    listEl.innerHTML = '';
    return;
  }

  const team = st.team;
  if (titleEl) titleEl.textContent = team.teamName || 'My Team';
  if (hintEl) hintEl.textContent = '';

  const members = team.members || [];
  const ownerId = team.creatorUserId;

  let html = '';
  for (const member of members) {
    const isYou = member.userId === myId;
    const isOwner = member.userId === ownerId;
    const initial = (member.name || '?').charAt(0).toUpperCase();

    html += `
      <div class="teammate-row${isYou ? ' is-you' : ''}${isOwner ? ' is-owner' : ''}">
        <div class="teammate-avatar">${esc(initial)}</div>
        <div class="teammate-info">
          <div class="teammate-name">${esc(member.name || 'Unknown')}${isYou ? ' (you)' : ''}</div>
        </div>
      </div>
    `;
  }

  if (!html) {
    html = '<div class="hint">No teammates yet.</div>';
  }

  listEl.innerHTML = html;
}

// Initialize presence when name is set
const originalSetUserName = setUserName;
window.setUserNameWithPresence = async function(name, opts) {
  await originalSetUserName(name, opts);
  if (getUserName()) {
    initPresence();
  }
};

// Override setUserName to also init presence
setUserName = async function(name, opts) {
  await originalSetUserName.call(this, name, opts);
  if (getUserName()) {
    initPresence();
  }
};

// Initialize presence on DOMContentLoaded if user already has a name
document.addEventListener('DOMContentLoaded', () => {
  if (getUserName()) {
    initPresence();
  }
});

// Export presence functions for game.js
window.getPresenceStatus = getPresenceStatus;
Object.defineProperty(window, 'presenceCache', {
  get: function() { return presenceCache; },
  configurable: true
});
window.updatePresence = updatePresence;
