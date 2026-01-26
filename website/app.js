/*
  Codenames Teams UI
  - Home: set name + see teams left
  - Teams: list teams, click to view members + request to join
  - My Team: create team, rename (creator), kick (creator), requests (creator)
*/

const MAX_TEAMS = 8;
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
// Account model:
// - Accounts are keyed by normalized player name so "same name" = same account across devices.
// - We keep LS_USER_ID for legacy sessions, but once a name is set we migrate to name-based IDs.

let teamsCache = [];
let playersCache = [];
let openTeamId = null;
let mergeNamesInFlight = new Set();

// Team chat
let chatOpenTeamId = null;
let chatUnsub = null;
let chatMessagesCache = [];

document.addEventListener('DOMContentLoaded', () => {
  initTabs();
  initName();
  initPlayersTab();
  initTeamModal();
  initCreateTeamModal();
  initMyTeamControls();
  initRequestsModal();
  initTeamChatModal();
  listenToTeams();
  listenToPlayers();
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
  const st = computeUserState(teamsCache);
  if (st?.team && st?.teamId) {
    updateMemberName(st.teamId, st.userId, st.name);
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

  // If the user already had a saved name, normalize their account id (and migrate legacy ids) so
  // the same name behaves like the same account across devices.
  if (getUserName()) {
    // Best-effort: don't block UI on startup.
    setUserName(getUserName(), { silent: true });
  }
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
  const maxPlayers = MAX_TEAMS * TEAM_SIZE;
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

  if (color) {
    body?.classList.add('has-team-color');
    root.style.setProperty('--team-accent', color);
    // Very subtle, but slightly more visible than before
    root.style.setProperty('--team-glow', hexToRgba(color, 0.28));
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
// Used so team leaders can invite roster-detected users who don't yet have a `players` doc.
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
  const canManageInvites = !!(st.isCreator && st.teamId && myTeam);
  const canSendInvitesNow = !!(canManageInvites && getMembers(myTeam).length < TEAM_SIZE);

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
      // Allow inviting even if the player has a pending request somewhere.
      // Show "Cancel invite" if already invited (even if the team is currently full).
      const showInviteButton = canManageInvites && uid !== st.userId && !memberTeam && (alreadyInvitedByMe || canSendInvitesNow);
      const inviteDisabled = !st.name;

      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';

      // Right-side pill: show the player's team (if they're on one), otherwise show "Available".
      // For team leaders, replace the Available pill with an Invite / Cancel invite pill-button.
      const teamPillStyle = teamColor
        ? `style="border-color:${esc(hexToRgba(teamColor, 0.35))}; color:${esc(teamColor)}; background:${esc(hexToRgba(teamColor, 0.10))}"`
        : '';

      let statusPillHtml = '';
      if (memberTeam) {
        statusPillHtml = `<span class="player-tag" ${teamPillStyle}>${esc(teamName)}</span>`;
      } else if (showInviteButton) {
        statusPillHtml = `
          <button class="player-tag pill-action ${alreadyInvitedByMe ? 'cancel' : 'invite'}" type="button" data-invite="${esc(uid)}" data-invite-mode="${alreadyInvitedByMe ? 'cancel' : 'send'}" ${inviteDisabled ? 'disabled' : ''}>
            ${alreadyInvitedByMe ? 'Cancel invite' : 'Invite'}
          </button>
        `;
      } else {
        statusPillHtml = `<span class="player-tag ok">Available</span>`;
      }

      return `
        <div class="player-row player-directory-row">
          <div class="player-left">
            <span class="player-name" ${nameStyle}>${esc(name)}</span>
          </div>
          <div class="player-right">
            ${statusPillHtml}
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

  // Helpful hint for leaders
  if (st.isCreator && st.teamId) {
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

  // Only show invites if the user isn't already on a team.
  // If the user has a pending request somewhere, they can still accept an invite (and the pending request will be cleared).
  if (st.teamId) {
    card.style.display = 'none';
    return;
  }

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
  if (!st.isCreator || !st.teamId || !st.team) return;
  if (getMembers(st.team).length >= TEAM_SIZE) return;

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
  if (!st.isCreator || !st.teamId) return;

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
  if (st.teamId) {
    setHint('invites-hint', 'You are already on a team.');
    return;
  }

  const teamRef = db.collection('teams').doc(teamId);
  const playerRef = db.collection('players').doc(st.userId);
  setHint('invites-hint', 'Joining…');

  try {
    // Clear any pending requests for this user (across teams) when they join via invite.
    const pendingTeamIds = (teamsCache || [])
      .filter(t => getPending(t).some(r => isSameAccount(r, st.userId)))
      .map(t => t.id);

    await db.runTransaction(async (tx) => {
      const refsToRead = [teamRef, playerRef].concat(pendingTeamIds.map(id => db.collection('teams').doc(id)));
      const snaps = await Promise.all(refsToRead.map(r => tx.get(r)));

      const teamSnap = snaps[0];
      const playerSnap = snaps[1];
      if (!teamSnap.exists) throw new Error('Team not found.');
      if (!playerSnap.exists) throw new Error('Player not found.');

      const team = { id: teamSnap.id, ...teamSnap.data() };
      const members = getMembers(team);
      if (members.length >= TEAM_SIZE) throw new Error('Team is full.');
      if (members.some(m => isSameAccount(m, st.userId))) return;

      // Remove this user from the team's pending list if present.
      const teamPending = getPending(team);
      const nextTeamPending = teamPending.filter(r => !isSameAccount(r, st.userId));

      const nextMembers = members.concat([{ userId: st.userId, name: st.name }]);

      const player = { id: playerSnap.id, ...playerSnap.data() };
      const invites = Array.isArray(player.invites) ? player.invites : [];
      const nextInvites = invites.filter(i => i?.teamId !== teamId);

      tx.update(teamRef, { members: nextMembers, pending: nextTeamPending });
      tx.update(playerRef, { invites: nextInvites, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });

      // Clear pending requests from any other teams (so no leader sees stale requests).
      for (let i = 2; i < snaps.length; i++) {
        const s = snaps[i];
        if (!s.exists) continue;
        const t = { id: s.id, ...s.data() };
        const p = getPending(t);
        if (!p?.length) continue;
        const next = p.filter(r => !isSameAccount(r, st.userId));
        if (next.length !== p.length) {
          tx.update(db.collection('teams').doc(s.id), { pending: next });
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
          <div class="team-list-members">${esc(memberNames)}</div>
        </div>
        <div class="team-list-right">
          <div class="team-list-count">${members.length}/${TEAM_SIZE}</div>
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
  const full = members.length >= TEAM_SIZE;
  const iAmMember = st.teamId === teamId;
  const iAmPendingHere = st.pendingTeamId === teamId;
  const iAmBusy = !!(st.teamId || st.pendingTeamId);
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
  } else if (iAmBusy) {
    disabled = true;
    hint = 'You are already on a team (or have a pending request).';
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
  if (st.teamId || st.pendingTeamId) {
    setHint(opts.hintElId || 'team-modal-hint', 'You are already on a team (or have a pending request).');
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
  const membersEl = document.getElementById('myteam-members');
  const actionsEl = document.getElementById('myteam-actions');
  const requestsBtn = document.getElementById('open-requests');
  const chatBtn = document.getElementById('open-chat');
  const leaveDeleteBtn = document.getElementById('leave-or-delete');
  const sub = document.getElementById('myteam-subtitle');
  const colorRow = document.getElementById('team-color-row');
  const colorInput = document.getElementById('team-color-input');

  const hasTeam = !!st.teamId;
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
  setText('myteam-size', `${getMembers(st.team).length}/${TEAM_SIZE}`);

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
   Team chat
========================= */
function initTeamChatModal() {
  const modal = document.getElementById('chat-modal');
  document.getElementById('chat-modal-close')?.addEventListener('click', closeChatModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeChatModal();
  });

  const form = document.getElementById('chat-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendChatMessage();
  });
}

function openChatModal() {
  const st = computeUserState(teamsCache);
  if (!st.teamId || !st.team) return;
  if (!st.name) {
    setHint('chat-hint', 'Set your name on Home first.');
    return;
  }
  const modal = document.getElementById('chat-modal');
  if (!modal) return;
  modal.style.display = 'flex';

  const title = document.getElementById('chat-modal-title');
  if (title) title.textContent = (st.team.teamName || 'Team') + ' chat';

  chatOpenTeamId = st.teamId;
  setHint('chat-hint', '');

  // Subscribe to this team's chat messages.
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }

  chatUnsub = db.collection('teams')
    .doc(st.teamId)
    .collection('chat')
    .orderBy('createdAt', 'asc')
    .limit(200)
    .onSnapshot((snap) => {
      chatMessagesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      renderChatMessages();
    }, (err) => {
      console.warn('Chat listen failed', err);
      setHint('chat-hint', 'Could not load chat.');
    });

  // Focus composer
  const input = document.getElementById('chat-input');
  try { input?.focus(); } catch (_) {}
}

function closeChatModal() {
  const modal = document.getElementById('chat-modal');
  if (modal) modal.style.display = 'none';
  setHint('chat-hint', '');
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }
  chatOpenTeamId = null;
  chatMessagesCache = [];
  const list = document.getElementById('chat-messages');
  if (list) list.innerHTML = '';
}

function renderChatMessages() {
  const list = document.getElementById('chat-messages');
  if (!list) return;

  if (!chatMessagesCache?.length) {
    list.innerHTML = '<div class="empty-state">No messages yet</div>';
    return;
  }

  list.innerHTML = chatMessagesCache.map(m => {
    return `
      <div class="chat-msg">
        <div class="chat-line"><span class="chat-who">${esc(m?.senderName || '—')}:</span> <span class="chat-text">${esc(m?.text || '')}</span></div>
      </div>
    `;
  }).join('');

  // Scroll to bottom
  try { list.scrollTop = list.scrollHeight; } catch (_) {}
}

async function sendChatMessage() {
  const st = computeUserState(teamsCache);
  if (!st.teamId || !st.team) return;
  const input = document.getElementById('chat-input');
  const text = (input?.value || '').trim();
  if (!text) return;

  try {
    await db.collection('teams')
      .doc(st.teamId)
      .collection('chat')
      .add({
        senderId: st.userId,
        senderName: st.name,
        text,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    if (input) input.value = '';
    setHint('chat-hint', '');
  } catch (e) {
    console.warn('Could not send chat message', e);
    setHint('chat-hint', 'Could not send message.');
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

      const targetId = entryAccountId(req) || String(req.userId || '').trim();

      const newPending = pending.filter(r => r.userId !== userId);
      const newMembers = dedupeRosterByAccount(members.concat([{ userId: targetId, name: req.name || '—' }]));
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

function logoutLocal() {
  // Local-only "logout": clears this device's saved name + id so it is no longer
  // linked to any shared name-based account.
  try { localStorage.removeItem(LS_USER_NAME); } catch (_) {}
  try { localStorage.removeItem(LS_USER_ID); } catch (_) {}
  // Full refresh keeps the app state consistent (listeners, cached state, theme).
  try { window.location.reload(); } catch (_) {}
}
