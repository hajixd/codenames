/*
  Codenames Teams UI
  - Home: set name + see teams left
  - Teams: list teams, click to view members + request to join
  - My Team: create team, rename (creator), kick (creator), requests (creator)
*/

const SOFT_MAX_TEAMS = 8;
// Teams should have at least 3 players to be tournament-ready.
// Historically we capped at 4; now that's just the recommended size.
const TEAM_MIN = 3;
// Tournament-ready cap for team size.
// NOTE: We do NOT hard-block requests/accepts beyond this cap.
// Teams can go over; they simply become ineligible and show "Too many players".
const SOFT_TEAM_MAX = 5;

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
const auth = firebase.auth();
const db = firebase.firestore();

// Keep users signed in across refreshes.
try {
  auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL);
} catch (e) {
  console.warn('Auth persistence not set (best-effort)', e);
}

const LS_USER_ID = 'ct_userId_v1';
const LS_USER_NAME = 'ct_userName_v1';
const LS_LAST_USERNAME = 'ct_lastUsername_v1';
const LS_RELOAD_TOAST = 'ct_reloadToast_v1';
const LS_SETTINGS_ANIMATIONS = 'ct_animations_v1';
const LS_SETTINGS_SOUNDS = 'ct_sounds_v1';
const LS_SETTINGS_VOLUME = 'ct_volume_v1';
const LS_SETTINGS_THEME = 'ct_theme_v1';
const LS_SETTINGS_OG_MODE = 'ct_og_mode_v1';
const LS_SETTINGS_STYLE_MODE = 'ct_style_mode_v1';
const LS_SETTINGS_STACKING = 'ct_stacking_v1';

// Signup / provisioning guard. During account creation, Firebase Auth may
// report an authenticated user before Firestore username/profile docs are
// written and before displayName is set. We keep a short-lived hint so the
// auth gate can avoid false “corrupted account” enforcement.
const LS_PROVISIONING_USERNAME = 'ct_provisioning_username_v1';
const LS_PROVISIONING_TS = 'ct_provisioning_ts_v1';

function setProvisioning(username) {
  try { localStorage.setItem(LS_PROVISIONING_USERNAME, normalizeUsername(username)); } catch (_) {}
  try { localStorage.setItem(LS_PROVISIONING_TS, String(Date.now())); } catch (_) {}
}

function clearProvisioning() {
  try { localStorage.removeItem(LS_PROVISIONING_USERNAME); } catch (_) {}
  try { localStorage.removeItem(LS_PROVISIONING_TS); } catch (_) {}
}

function getProvisioning() {
  try {
    const u = normalizeUsername(localStorage.getItem(LS_PROVISIONING_USERNAME) || '');
    const ts = Number(localStorage.getItem(LS_PROVISIONING_TS) || '0');
    if (!u || !ts) return null;
    // Only trust within 60s.
    if (Date.now() - ts > 60_000) return null;
    return { username: u, ts };
  } catch (_) {
    return null;
  }
}

// =========================
// Auth helpers (username + password)
// =========================
function normalizeUsername(v) {
  return String(v || '').trim().toLowerCase();
}

function isValidUsername(v) {
  return /^[a-z0-9_]{3,20}$/.test(String(v || '').trim().toLowerCase());
}

// Firebase Auth enforces a minimum password length. We keep UX flexible by
// transforming the user-entered password into a longer deterministic secret
// before sending it to Auth. (Login uses the same transform.)
const PW_PEPPER = '::codenames_pw_v1';
function passwordForAuth(pw) {
  const raw = String(pw || '');
  if (!raw) return raw;
  let padded = raw;
  while (padded.length < 6) padded += '_';
  return padded + PW_PEPPER;
}

function makeAuthHandle(username) {
  // Players sign in with "username + password".
  // Under the hood, Firebase Auth needs a unique identifier.
  // This handle is intentionally NOT deterministic; it lives in Firestore at
  // /usernames/{username}.
  const u = normalizeUsername(username);
  const rand = Math.random().toString(36).slice(2, 10);
  return `${u}.${rand}@u.local`;
}

async function lookupAuthHandleForUsername(username) {
  try {
    const u = normalizeUsername(username);
    const doc = await db.collection('usernames').doc(u).get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    return String(data.authHandle || '').trim() || null;
  } catch (e) {
    console.warn('Failed reading username registry (best-effort)', e);
    return null;
  }
}

async function resolveUsernameForUid(uid) {
  try {
    const q = await db.collection('usernames').where('uid', '==', String(uid || '').trim()).limit(1).get();
    if (q.empty) return null;
    return String(q.docs[0].id || '').trim() || null;
  } catch (e) {
    console.warn('Failed resolving username for uid (best-effort)', e);
    return null;
  }
}

// Ensure a signed-in user has a usable displayName.
// Returns the resolved username (normalized) or null.
async function ensureUserDisplayName(u) {
  try {
    const uid = String(u?.uid || '').trim();
    if (!uid) return null;

    const current = String(u?.displayName || '').trim();
    let username = normalizeUsername(current);

    // During signup, we may have a provisioning hint.
    const prov = getProvisioning();
    if (!username && prov?.username) username = normalizeUsername(prov.username);

    // The usernames registry is the source of truth for "what is my current handle".
    // This matters when the same account is logged in on multiple devices and the user
    // changes their name on one device: the other device must adopt the updated handle.
    let fromReg = null;
    try { fromReg = await resolveUsernameForUid(uid); } catch (_) {}
    const regName = normalizeUsername(fromReg || '');

    if (regName) {
      // If registry disagrees with Auth displayName, trust the registry and sync Auth.
      if (!username || username !== regName) {
        username = regName;
      }
    } else if (!username) {
      // No registry entry yet (e.g., early provisioning). We'll rely on provisioning/displayName.
      username = username || '';
    }

    // Keep Auth displayName synced to our resolved username so UI + checks are consistent.
    if (username && (!current || normalizeUsername(current) !== username)) {
      try { await u.updateProfile({ displayName: username }); } catch (_) {}
    }

    // Cache for faster cold starts.
    if (username) {
      try { safeLSSet(LS_LAST_USERNAME, username); } catch (_) {}
    }

    // Clear provisioning once we have a stable identity.
    if (prov?.username && username && normalizeUsername(prov.username) === username) {
      clearProvisioning();
    }

    return username || null;
  } catch (e) {
    console.warn('Failed ensuring displayName (best-effort)', e);
    return null;
  }
}


// =========================
// Account integrity / corruption handling
// =========================
function isPasswordProviderUser(u) {
  try {
    const pd = u?.providerData || [];
    return Array.isArray(pd) && pd.some(p => String(p?.providerId || '').toLowerCase() === 'password');
  } catch (_) {
    return false;
  }
}

// Returns { ok: true } or { ok:false, reason, username }.
// IMPORTANT: We only treat *structural* missing fields as corruption to avoid
// false positives from transient network errors.
async function checkAccountIntegrity(u, usernameOverride = null) {
  // Returns { ok: true, username } or { ok:false, reason, username, canRepair }
  // We keep this intentionally conservative: missing docs are usually repairable.
  try {
    const uid = String(u?.uid || '').trim();
    const rawName = String(u?.displayName || '').trim();
    const username = normalizeUsername(usernameOverride || rawName || safeLSGet(LS_LAST_USERNAME) || '');

    if (!uid) return { ok: false, reason: 'Missing user id', username: username || rawName || '', canRepair: false };
    if (!username) return { ok: false, reason: 'Missing account name', username: '', canRepair: false };

    // Accounts must be password-based. If the user signed in without a password provider
    // (e.g. anonymous / provider-only), treat it as a corrupted account and remove it.
    // During signup provisioning, providerData can briefly lag, so we skip this check
    // while the provisioning hint is active.
    const prov = getProvisioning();
    if (!prov && !isPasswordProviderUser(u)) {
      return { ok: false, reason: 'Missing password', username, canRepair: false };
    }

    const regRef = db.collection('usernames').doc(username);
    const regSnap = await regRef.get();

    if (!regSnap.exists) {
      return { ok: false, reason: 'Missing username registry', username, canRepair: true };
    }

    const reg = regSnap.data() || {};
    const regUid = String(reg.uid || '').trim();
    const regHandle = String(reg.authHandle || '').trim();

    if (!regUid || !regHandle) {
      // Rules make registry immutable; only admin can delete+recreate.
      return { ok: false, reason: 'Incomplete username registry', username, canRepair: false };
    }

    if (regUid !== uid) {
      return { ok: false, reason: 'Username registry mismatch', username, canRepair: false };
    }

    // User profile doc is non-critical; we can self-heal.
    return { ok: true, username };
  } catch (e) {
    console.warn('Account integrity check failed (best-effort)', e);
    // On network/permission errors, do NOT block.
    return { ok: true };
  }
}

async function repairAccountDocs(u, username) {
  // Best-effort self-heal for cases where account docs were deleted but the user is still signed in.
  // This prevents "corruption" from transient missing docs.
  try {
    const uid = String(u?.uid || '').trim();
    const uname = normalizeUsername(username || String(u?.displayName || '').trim() || safeLSGet(LS_LAST_USERNAME) || '');
    if (!uid || !uname) return { ok: false, reason: 'Missing account name' };

    // Persist last known username locally for boot restores.
    try { safeLSSet(LS_LAST_USERNAME, uname); } catch (_) {}

    // Ensure displayName is set.
    try {
      if (String(u?.displayName || '').trim() !== uname) {
        await u.updateProfile({ displayName: uname });
      }
    } catch (_) {}

    const authHandle = String(u?.email || '').trim();

    // Ensure username registry exists (create-only; immutable after).
    const regRef = db.collection('usernames').doc(uname);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(regRef);
      if (snap.exists) {
        const d = snap.data() || {};
        const regUid = String(d.uid || '').trim();
        if (regUid && regUid !== uid) {
          throw new Error('USERNAME_CONFLICT');
        }
        // If it exists but is incomplete we cannot update under current rules.
        return;
      }
      tx.set(regRef, {
        uid,
        authHandle,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    // Ensure users/<uid> exists.
    try {
      const ref = db.collection('users').doc(uid);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? (snap.data() || {}) : {};
        const patch = {
          username: uname,
          name: uname,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (!data.createdAt) patch.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        tx.set(ref, patch, { merge: true });
      });
    } catch (_) {}

    // Ensure players/<uid> exists.
    try {
      const ref = db.collection('players').doc(uid);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? (snap.data() || {}) : {};
        const patch = {
          name: uname,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        };
        if (!data.createdAt) patch.createdAt = firebase.firestore.FieldValue.serverTimestamp();
        tx.set(ref, patch, { merge: true });
      });
    } catch (_) {}

    return { ok: true, username: uname };
  } catch (e) {
    const msg = String(e?.message || '');
    if (msg.includes('USERNAME_CONFLICT')) return { ok: false, reason: 'Username conflict' };
    console.warn('Failed to repair account docs (best-effort)', e);
    return { ok: false, reason: 'Repair failed' };
  }
}

async function purgeCorruptedAccountEverywhere(u, info = {}) {
  const uid = String(u?.uid || '').trim();
  const username = normalizeUsername(info.username || u?.displayName || '');
  if (!uid) return;

  // Remove presence first so they immediately disappear from "Who's Online".
  try { await db.collection(PRESENCE_COLLECTION).doc(uid).delete(); } catch (_) {}

  // Best-effort: remove from teams membership + pending lists.
  try {
    const teamColl = db.collection('teams');

    // Some schemas store memberIds; remove those too if present.
    const qIds = await teamColl.where('memberIds', 'array-contains', uid).get();
    for (const doc of qIds.docs) {
      try {
        await teamColl.doc(doc.id).update({
          memberIds: firebase.firestore.FieldValue.arrayRemove(uid),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        });
      } catch (_) {}
    }

    // Many teams store members/pending arrays of objects, so we rewrite arrays
    // for any team where the user appears.
    const allTeams = await teamColl.get();
    for (const doc of allTeams.docs) {
      const t = { id: doc.id, ...doc.data() };
      const members = getMembers(t);
      const pending = getPending(t);
      const has = !!(findUserInMembers(t, uid) || pending.some(p => isSameAccount(p, uid)));
      if (!has) continue;

      const newMembers = members.filter(m => !isSameAccount(m, uid));
      const newPending = pending.filter(p => !isSameAccount(p, uid));
      try {
        await teamColl.doc(doc.id).set({
          members: newMembers,
          pending: newPending,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      } catch (_) {}
    }
  } catch (_) {}

  // Delete personal DM threads involving this user (best-effort)
  try {
    const threadsSnap = await db.collection(DM_THREADS_COLLECTION).where('participants', 'array-contains', uid).get();
    for (const th of threadsSnap.docs) {
      const threadId = th.id;
      // Delete messages in chunks
      while (true) {
        const ms = await db.collection(DM_THREADS_COLLECTION).doc(threadId).collection('messages').limit(250).get();
        if (ms.empty) break;
        const batch = db.batch();
        ms.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      await th.ref.delete();
    }
  } catch (_) {}

  // Delete messages in global chat sent by this user (best-effort)
  try {
    while (true) {
      const snap = await db.collection(GLOBAL_CHAT_COLLECTION).where('senderId', '==', uid).limit(250).get();
      if (snap.empty) break;
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
    }
  } catch (_) {}

  // Delete messages in team chat sent by this user (best-effort)
  try {
    const teamColl = db.collection('teams');
    const teamsSnap = await teamColl.get();
    for (const tdoc of teamsSnap.docs) {
      const chatRef = teamColl.doc(tdoc.id).collection('chat');
      while (true) {
        const snap = await chatRef.where('senderId', '==', uid).limit(250).get();
        if (snap.empty) break;
        const batch = db.batch();
        snap.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
    }
  } catch (_) {}

  // Delete core docs
  try { await db.collection('users').doc(uid).delete(); } catch (_) {}
  try { await db.collection('players').doc(uid).delete(); } catch (_) {}

  // Delete username registry docs for this uid so the username(s) become available.
  try {
    const names = new Set();

    // Prefer cache
    try {
      for (const r of (usernamesCache || [])) {
        const rUid = String(r?.uid || '').trim();
        const nm = String(r?.id || '').trim();
        if (rUid && rUid === uid && nm) names.add(nm);
      }
    } catch (_) {}

    // If empty, query directly
    if (names.size === 0) {
      const q = await db.collection('usernames').where('uid', '==', uid).get();
      q.docs.forEach(d => names.add(String(d.id || '').trim()));
    }

    // Last resort: try the provided username
    if (username && isValidUsername(username)) names.add(username);

    for (const nm of names) {
      if (!nm) continue;
      try { await db.collection('usernames').doc(nm).delete(); } catch (_) {}
    }
  } catch (_) {}

  // Finally, delete the Auth user (best-effort). This may require recent login.
  try { await u.delete(); } catch (e) { console.warn('Could not delete auth user (best-effort)', e); }
}

const LS_NAV_MODE = 'ct_navMode_v1';      // 'quick' | 'tournament' | null
const LS_NAV_PANEL = 'ct_navPanel_v1';    // panel id for tournament mode
// Game resume keys (game.js owns the values; app.js only triggers restore)
const LS_ACTIVE_GAME_ID = 'ct_activeGameId_v1';
const LS_ACTIVE_GAME_SPECTATOR = 'ct_activeGameSpectator_v1';
// Account model:
// - Accounts are keyed by normalized player name so "same name" = same account across devices.
// - We keep LS_USER_ID for legacy sessions, but once a name is set we migrate to name-based IDs.

let teamsCache = [];
let playersCache = [];

// Throttle best-effort empty-team auto-archiving (admin only)
const emptyTeamCleanupAttempts = new Map(); // teamId -> lastAttemptMs

// Live listeners (only when signed in)
let teamsUnsub = null;
let playersUnsub = null;
let usernamesUnsub = null;
let usernamesCache = []; // docs from /usernames (public registry)

// Avoid spamming Firestore with repeated legacy-migration writes.
const migratedCreatorIds = new Set();
let openTeamId = null;
let mergeNamesInFlight = new Set();

// Admin controls
// IMPORTANT: admin status is determined by Firebase Auth custom claims.
// The UI also hides admin features for non-admins, but the real security must
// be enforced by Firestore security rules + (ideally) server-side functions.
let cachedIsAdmin = false;
async function refreshAdminClaims() {
  try {
    const u = auth.currentUser;
    if (!u) { cachedIsAdmin = false; return false; }
    const token = await u.getIdTokenResult(true);
    cachedIsAdmin = !!token?.claims?.admin;
    return cachedIsAdmin;
  } catch (_) {
    cachedIsAdmin = false;
    return false;
  }
}
function isAdminUser() {
  try {
    const nm = normalizeUsername(getUserName() || auth.currentUser?.displayName || '');
    return !!cachedIsAdmin || nm === 'admin';
  } catch (_) {
    return !!cachedIsAdmin;
  }
}

// =========================
// Admin Logs (client-side)
// =========================
// A lightweight event log used by the special "admin" account.
// Writes are best-effort (fire-and-forget) and read access is restricted
// via Firestore rules.
let logsUnsub = null;
let logsCache = [];
let inferredLogsCache = [];
let inferredLogsInterval = null;
let inferredLogsInFlight = false;

// Best-effort historical log reconstruction for events that happened
// before the dedicated /logs collection existed.
// We infer timestamps from existing structured fields (e.g. requestedAt, invitedAt).
async function refreshInferredLogs() {
  if (!isAdminUser()) return;
  if (inferredLogsInFlight) return;
  inferredLogsInFlight = true;
  try {
    const [teamsSnap, playersSnap] = await Promise.all([
      db.collection('teams').get(),
      db.collection('players').get()
    ]);

    const teamNameById = new Map();
    for (const d of teamsSnap.docs) {
      const t = d.data() || {};
      teamNameById.set(d.id, String(t.teamName || '').trim());
    }

    const inferred = [];

    // Team creation history (createdAt/createdAtMs)
    for (const d of teamsSnap.docs) {
      const t = d.data() || {};
      const teamId = d.id;
      const teamName = String(t.teamName || '').trim() || 'a team';
      const ms = tsToMs(t?.createdAt) || Number(t?.createdAtMs) || 0;
      if (!Number.isFinite(ms) || ms <= 0) continue;
      inferred.push({
        id: `infer_team_create_${teamId}_${ms}`,
        inferred: true,
        type: 'team_created',
        message: `Team created: ${teamName}`,
        actorId: null,
        actorName: null,
        inferredAtMs: ms,
        meta: { teamId, teamName }
      });
    }

    // Player/account creation history (players/<uid>.createdAt)
    for (const d of playersSnap.docs) {
      const p = d.data() || {};
      const uid = d.id;
      const nm = normalizeUsername(String(p.name || uid || 'user'));
      const ms = tsToMs(p?.createdAt) || Number(p?.createdAtMs) || 0;
      if (!Number.isFinite(ms) || ms <= 0) continue;
      inferred.push({
        id: `infer_player_create_${uid}_${ms}`,
        inferred: true,
        type: 'account_created',
        message: `${nm || 'user'} account created`,
        actorId: uid,
        actorName: nm || null,
        inferredAtMs: ms,
        meta: { userId: uid, username: nm || null }
      });
    }

    // Team join history (members[].joinedAt / joinedAtMs)
    for (const d of teamsSnap.docs) {
      const t = d.data() || {};
      const teamId = d.id;
      const teamName = String(t.teamName || '').trim() || 'a team';
      const members = getMembers(t);
      for (const m of members) {
        const ms = tsToMs(m?.joinedAt) || Number(m?.joinedAtMs) || 0;
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const uid = String(entryAccountId(m) || m?.userId || '').trim();
        const nm = normalizeUsername(String(m?.name || uid || 'user'));
        inferred.push({
          id: `infer_join_${teamId}_${uid}_${ms}`,
          inferred: true,
          type: 'team_join',
          message: `${nm || 'user'} joined ${teamName}`,
          actorId: uid || null,
          actorName: nm || null,
          inferredAtMs: ms,
          meta: { teamId, teamName }
        });
      }
    }

    // Pending join requests (requestedAt exists).
    for (const d of teamsSnap.docs) {
      const t = d.data() || {};
      const teamId = d.id;
      const teamName = String(t.teamName || '').trim() || 'a team';
      const pending = Array.isArray(t.pending) ? t.pending : [];
      for (const r of pending) {
        const ms = tsToMs(r?.requestedAt);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const actorId = String(entryAccountId(r) || r?.userId || '').trim();
        const actorName = normalizeUsername(String(r?.name || actorId || 'user'));
        inferred.push({
          id: `infer_req_${teamId}_${actorId}_${ms}`,
          inferred: true,
          type: 'team_request',
          message: `${actorName || 'user'} requested to join ${teamName}`,
          actorId: actorId || null,
          actorName: actorName || null,
          inferredAtMs: ms,
          meta: { teamId, teamName }
        });
      }
    }

    // Invites (invitedAt exists on player.invites entries).
    for (const d of playersSnap.docs) {
      const p = d.data() || {};
      const targetId = d.id;
      const targetName = normalizeUsername(String(p.name || targetId || 'user'));
      const invites = Array.isArray(p.invites) ? p.invites : [];
      for (const inv of invites) {
        const ms = tsToMs(inv?.invitedAt);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const teamId = String(inv?.teamId || '').trim();
        const teamName = (teamId && teamNameById.get(teamId)) ? teamNameById.get(teamId) : '';
        const inviterId = String(inv?.inviterUserId || '').trim();
        const inviterName = normalizeUsername(String(inv?.inviterName || inviterId || 'user'));
        const msg = teamName
          ? `${inviterName || 'user'} invited ${targetName || 'user'} to ${teamName}`
          : `${inviterName || 'user'} invited ${targetName || 'user'} to a team`;
        inferred.push({
          id: `infer_inv_${teamId}_${inviterId}_${targetId}_${ms}`,
          inferred: true,
          type: 'invite_sent',
          message: msg,
          actorId: inviterId || null,
          actorName: inviterName || null,
          inferredAtMs: ms,
          meta: { teamId, teamName, targetUserId: targetId, targetName }
        });
      }
    }

    // Chat history (best-effort): recent global chat + recent team chat.
    try {
      const globalSnap = await db.collection(GLOBAL_CHAT_COLLECTION)
        .orderBy('createdAt', 'desc')
        .limit(80)
        .get();
      for (const d of globalSnap.docs) {
        const m = d.data() || {};
        const ms = tsToMs(m?.createdAt);
        if (!Number.isFinite(ms) || ms <= 0) continue;
        const senderId = String(m?.senderId || '').trim();
        const senderName = normalizeUsername(String(m?.senderName || senderId || 'user'));
        const text = String(m?.text || '').trim();
        if (!text) continue;
        const snippet = text.length > 60 ? (text.slice(0, 57) + '…') : text;
        inferred.push({
          id: `infer_global_msg_${d.id}`,
          inferred: true,
          type: 'global_message',
          message: `${senderName || 'user'}: ${snippet}`,
          actorId: senderId || null,
          actorName: senderName || null,
          inferredAtMs: ms,
          meta: { scope: 'global', docId: d.id }
        });
      }
    } catch (_) {}

    try {
      // Limit team chat sampling so we don't hammer Firestore on large tournaments.
      const teamDocs = teamsSnap.docs.slice();
      teamDocs.sort((a, b) => {
        const ad = a.data() || {};
        const bd = b.data() || {};
        const am = tsToMs(ad?.updatedAt) || tsToMs(ad?.createdAt) || Number(ad?.createdAtMs) || 0;
        const bm = tsToMs(bd?.updatedAt) || tsToMs(bd?.createdAt) || Number(bd?.createdAtMs) || 0;
        return (bm || 0) - (am || 0);
      });
      const sample = teamDocs.slice(0, 8);
      for (const td of sample) {
        const t = td.data() || {};
        const teamId = td.id;
        const teamName = String(t.teamName || '').trim() || 'a team';
        let chatSnap = null;
        try {
          chatSnap = await db.collection('teams').doc(teamId).collection('chat')
            .orderBy('createdAt', 'desc')
            .limit(25)
            .get();
        } catch (_) { chatSnap = null; }
        if (!chatSnap || chatSnap.empty) continue;
        for (const d of chatSnap.docs) {
          const m = d.data() || {};
          const ms = tsToMs(m?.createdAt);
          if (!Number.isFinite(ms) || ms <= 0) continue;
          const senderId = String(m?.senderId || '').trim();
          const senderName = normalizeUsername(String(m?.senderName || senderId || 'user'));
          const text = String(m?.text || '').trim();
          if (!text) continue;
          const snippet = text.length > 60 ? (text.slice(0, 57) + '…') : text;
          inferred.push({
            id: `infer_team_msg_${teamId}_${d.id}`,
            inferred: true,
            type: 'team_message',
            message: `[${teamName}] ${senderName || 'user'}: ${snippet}`,
            actorId: senderId || null,
            actorName: senderName || null,
            inferredAtMs: ms,
            meta: { scope: 'team', teamId, teamName, docId: d.id }
          });
        }
      }
    } catch (_) {}

    inferred.sort((a, b) => (b.inferredAtMs || 0) - (a.inferredAtMs || 0));
    inferredLogsCache = inferred.slice(0, 500);
  } catch (e) {
    console.warn('Historical log inference failed (best-effort)', e);
  } finally {
    inferredLogsInFlight = false;
  }
}

function logEvent(type, message, meta = {}) {
  try {
    const u = auth.currentUser;
    if (!u) return;
    const actorId = String(u.uid || '').trim();
    if (!actorId) return;
    const actorName = normalizeUsername(getUserName() || u.displayName || '');
    const t = String(type || '').trim();
    const msg = String(message || '').trim();
    if (!t || !msg) return;

    // Best-effort write (do not block UX).
    db.collection('logs').add({
      type: t,
      message: msg,
      actorId,
      actorName: actorName || null,
      meta: meta && typeof meta === 'object' ? meta : {},
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  } catch (_) {
    // swallow
  }
}

// App-level backups (client-driven, admin-only)
// These backups live in Firestore under:
//   adminBackups/{backupId}
//     - meta fields (createdAtMs, createdAt, reason, createdBy)
//     - subcollections: teams/{teamId}, players/{playerId}
const ADMIN_BACKUPS_COLL = 'adminBackups';
const ADMIN_BACKUP_KEEP_MS = 2 * 60 * 60 * 1000; // keep ~2 hours by default
let adminBackupInterval = null;
let adminBackupInFlight = false;

async function adminCreateBackup(reason = 'manual') {
  if (!isAdminUser()) throw new Error('Admin only');
  if (adminBackupInFlight) return null;
  adminBackupInFlight = true;
  try {
    const createdAtMs = Date.now();
    const backupId = String(createdAtMs);
    const backupRef = db.collection(ADMIN_BACKUPS_COLL).doc(backupId);

    // Read current collections
    const [teamsSnap, playersSnap] = await Promise.all([
      db.collection('teams').get(),
      db.collection('players').get()
    ]);

    await backupRef.set({
      createdAtMs,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
      reason: String(reason || 'manual'),
      createdBy: String(getUserName() || 'unknown')
    });

    // Write teams + players into subcollections (chunked batches)
    await adminWriteSnapshotSubcollection(backupRef.collection('teams'), teamsSnap);
    await adminWriteSnapshotSubcollection(backupRef.collection('players'), playersSnap);

    // Best-effort prune old backups
    adminPruneOldBackups().catch(e => console.warn('Backup prune failed (best-effort)', e));
    return { backupId, createdAtMs, teams: teamsSnap.size, players: playersSnap.size };
  } finally {
    adminBackupInFlight = false;
  }
}

async function adminWriteSnapshotSubcollection(targetCollRef, snap) {
  let batch = db.batch();
  let count = 0;
  let wrote = 0;
  for (const doc of snap.docs) {
    batch.set(targetCollRef.doc(doc.id), doc.data() || {});
    count++;
    wrote++;
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
  return wrote;
}

async function adminFindBackupAtOrBefore(targetMs) {
  if (!isAdminUser()) throw new Error('Admin only');
  const q = await db.collection(ADMIN_BACKUPS_COLL)
    .where('createdAtMs', '<=', targetMs)
    .orderBy('createdAtMs', 'desc')
    .limit(1)
    .get();
  if (q.empty) return null;
  const doc = q.docs[0];
  return { id: doc.id, ...doc.data() };
}

async function adminRestoreFromMinutesAgo(minutes = 5) {
  if (!isAdminUser()) throw new Error('Admin only');
  const mins = Math.max(1, Math.min(60, parseInt(minutes, 10) || 5));
  const targetMs = Date.now() - mins * 60 * 1000;

  const backup = await adminFindBackupAtOrBefore(targetMs);
  if (!backup) {
    throw new Error(`No admin backup found at or before ${mins} minutes ago.`);
  }

  const backupRef = db.collection(ADMIN_BACKUPS_COLL).doc(String(backup.id));
  const [teamsSnap, playersSnap] = await Promise.all([
    backupRef.collection('teams').get(),
    backupRef.collection('players').get()
  ]);

  // Replace live collections
  await adminDeleteAllDocs('teams');
  await adminDeleteAllDocs('players');

  await adminRestoreCollectionFromSnapshot('teams', teamsSnap);
  await adminRestoreCollectionFromSnapshot('players', playersSnap);

  return { restoredFromBackupId: backup.id, teams: teamsSnap.size, players: playersSnap.size };
}

async function adminRestoreCollectionFromSnapshot(collectionName, snap) {
  let batch = db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.set(db.collection(collectionName).doc(doc.id), doc.data() || {});
    count++;
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

async function adminDeleteAllDocs(collectionName) {
  // Deletes documents in batches to stay within Firestore limits.
  const coll = db.collection(collectionName);
  while (true) {
    const snap = await coll.limit(450).get();
    if (snap.empty) break;
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  }
}

async function adminPruneOldBackups() {
  if (!isAdminUser()) return;
  const cutoff = Date.now() - ADMIN_BACKUP_KEEP_MS;
  const snap = await db.collection(ADMIN_BACKUPS_COLL)
    .where('createdAtMs', '<', cutoff)
    .orderBy('createdAtMs', 'asc')
    .limit(25)
    .get();
  if (snap.empty) return;
  // Delete backup doc + its subcollections (best-effort).
  // Firestore doesn't support recursive delete from client; we delete subcollection docs first.
  for (const d of snap.docs) {
    const ref = d.ref;
    try {
      const [t, p] = await Promise.all([
        ref.collection('teams').get(),
        ref.collection('players').get()
      ]);
      await adminDeleteSnapshotDocs(ref.collection('teams'), t);
      await adminDeleteSnapshotDocs(ref.collection('players'), p);
      await ref.delete();
    } catch (e) {
      console.warn('Failed pruning backup', d.id, e);
    }
  }
}

function adminEnsureAutoBackupsRunning() {
  // Auto backups only run for admin accounts and are client-driven.
  // This is best-effort and intended as a "break glass" safety net.
  if (!isAdminUser()) {
    if (adminBackupInterval) {
      try { clearInterval(adminBackupInterval); } catch (_) {}
      adminBackupInterval = null;
    }
    return;
  }
  if (adminBackupInterval) return;
  // Create an initial backup as soon as we detect an admin session.
  adminCreateBackup('auto').catch(() => {});
  adminBackupInterval = setInterval(() => {
    adminCreateBackup('auto').catch(() => {});
  }, 60 * 1000);
}

async function adminDeleteSnapshotDocs(subCollRef, snap) {
  let batch = db.batch();
  let count = 0;
  for (const doc of snap.docs) {
    batch.delete(subCollRef.doc(doc.id));
    count++;
    if (count >= 450) {
      await batch.commit();
      batch = db.batch();
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}

// Chat (tab)
const GLOBAL_CHAT_COLLECTION = 'globalChat';
const DM_THREADS_COLLECTION = 'dmThreads';
let chatMode = 'global'; // 'global' | 'team' | 'personal'
let chatPersonalUserId = '';
let chatPersonalUserName = '';
const LS_CHAT_PERSONAL = 'ct_chatPersonal_v1';
let chatUnsub = null;
let chatMessagesCache = [];
// Personal inbox (DM) UI
let dmInboxUnsub = null;
let dmThreadsCache = [];
let dmView = 'inbox'; // 'inbox' | 'thread'
let dmNewOpen = false;
// Unread badges
let unreadGlobalUnsub = null;
let unreadTeamUnsub = null;
let unreadGlobalCache = [];
let unreadTeamCache = [];
let unreadGlobalCount = 0;
let unreadTeamCount = 0;
let unreadPersonalCount = 0;
let lastReadWriteAtMs = 0;
let activePanelId = 'panel-game';
// Used to suppress quick-play lobby rendering on the *next* panel-game switch.
// (Needed for the live-game chooser so users don't briefly see the lobby.)
let skipQuickPlayLobbyOnce = false;

// Profile sync
let profileUnsub = null;
let lastLocalNameSetAtMs = 0;

// Boot loader coordination (prevents login-page flashes on refresh)
let bootAuthStartedAtMs = 0;
let bootAuthResolvedOnce = false;

// Messages drawer (global/team/personal)
let chatDrawerOpen = false;
let lastHeaderInGameState = null;

function finishBootAuthLoading(minVisibleMs = 700) {
  // Keep the loading screen up long enough to avoid a UI "flash" while Auth
  // resolves and the correct route/screen renders.
  const started = bootAuthStartedAtMs || Date.now();
  const elapsed = Date.now() - started;
  const wait = Math.max(minVisibleMs - elapsed, 0);
  setTimeout(() => {
    // One extra rAF ensures we hide after the browser paints the target screen.
    requestAnimationFrame(() => hideAuthLoadingScreen());
  }, wait);
}


function isInGameBoardView() {
  const el = document.getElementById('game-board-container');
  if (!el) return false;
  try {
    return window.getComputedStyle(el).display !== 'none';
  } catch (_) {
    return String(el.style.display || '').toLowerCase() !== 'none';
  }
}

function updateHeaderIconVisibility() {
  const chatBtn = document.getElementById('header-chat-btn');
  const inGame = isInGameBoardView();
  if (inGame && chatDrawerOpen) {
    try { setChatDrawerOpen(false); } catch (_) {}
  }
  if (lastHeaderInGameState === inGame && chatBtn) {
    // still update disabled state on auth changes
  }
  lastHeaderInGameState = inGame;

  if (chatBtn) chatBtn.style.display = inGame ? 'none' : 'inline-flex';

  const signedIn = !!auth.currentUser;
  if (chatBtn) chatBtn.classList.toggle('disabled', !signedIn);
}

function setChatDrawerOpen(open, opts = {}) {
  const drawer = document.getElementById('chat-drawer');
  const backdrop = document.getElementById('chat-drawer-backdrop');
  if (!drawer || !backdrop) return;

  const wantOpen = !!open;
  if (wantOpen === chatDrawerOpen) return;

  chatDrawerOpen = wantOpen;

  if (wantOpen) {
    if (!auth.currentUser) {
      // Not signed in; ignore.
      chatDrawerOpen = false;
      updateHeaderIconVisibility();
      return;
    }
    backdrop.style.display = 'block';
    drawer.setAttribute('aria-hidden', 'false');
    requestAnimationFrame(() => drawer.classList.add('open'));

    startChatSubscription();
    if (chatMode === 'global' || chatMode === 'team') markChatRead(chatMode);
    recomputeUnreadBadges();

    if (opts.focusInput) {
      setTimeout(() => {
        try { document.getElementById('chat-panel-input')?.focus(); } catch (_) {}
      }, 80);
    }
  } else {
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    stopChatSubscription();
    recomputeUnreadBadges();
    setTimeout(() => { backdrop.style.display = 'none'; }, 190);
  }
}

function initChatDrawerChrome() {
  const btn = document.getElementById('header-chat-btn');
  const close = document.getElementById('chat-drawer-close');
  const backdrop = document.getElementById('chat-drawer-backdrop');

  btn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!auth.currentUser) {
      // If user isn't signed in yet, the auth screen is the right place.
      return;
    }
    setChatDrawerOpen(true, { focusInput: false });
  });

  close?.addEventListener('click', (e) => {
    e.preventDefault();
    setChatDrawerOpen(false);
  });

  backdrop?.addEventListener('click', () => setChatDrawerOpen(false));

  // Keep icon visibility correct
  setInterval(() => updateHeaderIconVisibility(), 500);
}




/* =========================
   Layout: sync fixed chrome heights
   
   The header and (desktop) tabs are position:fixed and can vary in height
   (safe-area insets, dynamic pills, font loading). If the CSS variables
   --header-h / --tabs-h are too small, the top of scrollable panels can end
   up hidden behind the fixed chrome with no way to scroll to it.

   We measure the real rendered heights and write them back into the CSS
   variables used by .main-content padding.
========================= */
function syncChromeHeights() {
  try {
    const app = document.querySelector('.app');
    if (!app) return;

    const header = document.querySelector('.app-header');
    const desktopTabs = document.querySelector('.desktop-tabs');

    const headerH = header ? header.getBoundingClientRect().height : 0;
    // Only count desktop tabs if actually visible
    let tabsH = 0;
    if (desktopTabs) {
      const cs = window.getComputedStyle(desktopTabs);
      if (cs && cs.display !== 'none' && cs.visibility !== 'hidden') {
        tabsH = desktopTabs.getBoundingClientRect().height;
      }
    }

    // Round to whole pixels to avoid subpixel jitter.
    app.style.setProperty('--header-h', `${Math.max(0, Math.round(headerH))}px`);
    app.style.setProperty('--tabs-h', `${Math.max(0, Math.round(tabsH))}px`);
  } catch (_) {}
}

function initChromeHeightSync() {
  // Run immediately and again after layout settles (fonts/icons can shift height).
  try { syncChromeHeights(); } catch (_) {}
  try { setTimeout(syncChromeHeights, 50); } catch (_) {}
  try { setTimeout(syncChromeHeights, 250); } catch (_) {}

  try {
    const onResize = () => {
      // Batch with rAF to avoid spamming during resize.
      try { requestAnimationFrame(syncChromeHeights); } catch (_) { syncChromeHeights(); }
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', () => {
      try { setTimeout(syncChromeHeights, 50); } catch (_) { syncChromeHeights(); }
    });
  } catch (_) {}

  // Watch for dynamic header/tab content changes (e.g., team pill appears, name changes).
  try {
    const header = document.querySelector('.app-header');
    const desktopTabs = document.querySelector('.desktop-tabs');
    const targets = [header, desktopTabs].filter(Boolean);
    if (targets.length) {
      const obs = new MutationObserver(() => {
        try { requestAnimationFrame(syncChromeHeights); } catch (_) { syncChromeHeights(); }
      });
      for (const t of targets) {
        try {
          obs.observe(t, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch (_) {
          // Some environments may reject certain options; fall back to a simpler observer.
          try { obs.observe(t, { childList: true, subtree: true }); } catch (_) {}
        }
      }
    }
  } catch (_) {}
}

document.addEventListener('DOMContentLoaded', () => {
  // Defensive: some browsers can briefly restore prior DOM state on reload
  // (especially if a reload happens shortly after closing an animated modal).
  // Force transient modals closed at boot so we always start in a clean state.
  try {
    const forceClose = (id) => {
      const m = document.getElementById(id);
      if (!m) return;
      m.classList.remove('modal-open');
      m.style.display = 'none';
    };
    forceClose('name-change-modal');
    forceClose('settings-modal');
    forceClose('password-change-modal');
    forceClose('profile-details-modal');
  } catch (_) {}

  // Remove the booting class once we've forcibly closed transient UI.
  // Also strip our cache-buster param (if present) so the URL stays clean.
  try {
    const u = new URL(window.location.href);
    if (u.searchParams.has('_r')) {
      u.searchParams.delete('_r');
      history.replaceState(null, '', u.toString());
    }
  } catch (_) {}
  try { document.body?.classList.remove('booting'); } catch (_) {}

  // Show the loading screen immediately. We'll hide it only after Firebase Auth
  // resolves and we've rendered the correct initial screen.
  bootAuthStartedAtMs = Date.now();
  try { showAuthLoadingScreen('Loading'); } catch (_) {}
  // Prevent initial HTML/CSS from flashing the auth screen before Auth resolves.
  try {
    const a = document.getElementById('auth-screen');
    const l = document.getElementById('launch-screen');
    if (a) a.style.display = 'none';
    if (l) l.style.display = 'none';
  } catch (_) {}

  initSettings();
  initPasswordChangeModal();
  initNameChangeModal();
  initConfirmDialog();
  initSystemDialog();
  initPasswordDialog();
  initQuickPlayGate();
  initLaunchScreen();
  initAuthGate();
  initPasswordVisibilityToggles();
  initHeaderLogoNav();
  initTabs();
  initHomeActions();
  initChromeHeightSync();
  initName();
  initPlayersTab();
  initTeamModal();
  initBracketsUI();
  initPracticePage();
  initCreateTeamModal();
  initMyTeamControls();
  initRequestsModal();
  initInvitesModal();
  initAdminAssignModal();
  initChatTab();
  initChatDrawerChrome();
  updateHeaderIconVisibility();
  initOnlineCounterUI();
  initAuthOnlineButton();
  initUsernamesRegistryListener();
  // Read-only presence listener so "Who's Online" works even before login.
  // (Writes only happen after sign-in.)
  startPresenceListener();
  initProfileDetailsModal();
  // Live Firestore listeners are started after sign-in (initAuthGate).

  // Keep compact header labels in sync when crossing mobile/desktop breakpoints.
  try {
    if (window.matchMedia) {
      const mq = window.matchMedia('(max-width: 520px)');
      const onChange = () => {
        try { refreshNameUI(); } catch (_) {}
        try { refreshHeaderIdentity(); } catch (_) {}
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    }
  } catch (_) {}

  // NOTE: initial navigation restore is handled after Firebase Auth resolves
  // (inside initAuthGate). Doing it here can cause a visible "flash".

  // If we intentionally reloaded (e.g., after a rename), show a confirmation toast now.
  setTimeout(() => { try { consumeReloadToast(); } catch (_) {} }, 350);

});

function initAuthOnlineButton() {
  const btn = document.getElementById('auth-whos-online-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    playSound('click');
    openOnlineModal();
  });
}

function initPasswordVisibilityToggles() {
  // Passwords are intentionally always visible (no eye toggles).
  const inputIds = [
    'launch-password-login',
    'launch-password-create',
    'password-dialog-input',
    'password-current-input',
    'password-new-input',
    'password-confirm-input',
    'password-change-current',
    'password-change-new',
    'password-change-confirm',
  ];

  for (const id of inputIds) {
    const input = document.getElementById(id);
    if (!input) continue;
    if (input.type === 'password') input.type = 'text';
  }

  // Hide any legacy toggle buttons if they exist.
  const btnIds = ['pw-toggle-login', 'pw-toggle-create', 'password-dialog-toggle'];
  for (const id of btnIds) {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = 'none';
  }
}

// (isAdminUser defined near the top)

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

function setLaunchAnimationLabOpen(open) {
  const modeScreen = document.getElementById('launch-screen');
  if (!modeScreen) return;
  const modeRow = modeScreen.querySelector('.launch-mode-row');
  const labPage = document.getElementById('launch-animation-page');
  if (!modeRow || !labPage) return;
  const allowOpen = !!isAdminUser();
  const nextOpen = !!open && allowOpen;
  modeRow.style.display = nextOpen ? 'none' : '';
  labPage.style.display = nextOpen ? 'block' : 'none';
  modeScreen.classList.toggle('launch-animation-open', nextOpen);
}

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const modeScreen = document.getElementById('launch-screen');
  if (authScreen) authScreen.style.display = 'flex';
  if (modeScreen) modeScreen.style.display = 'none';
  setLaunchAnimationLabOpen(false);
  document.body.classList.add('launch');
  document.body.classList.remove('quickplay');
  document.body.classList.remove('tournament');
  document.body.classList.remove('practice');
  document.body.classList.remove('has-team-color');
  setBrowserTitle('launch');
  try { refreshNameUI?.(); } catch (_) {}
}

function showLaunchScreen() {
  // Choose Mode screen (shown after sign-in).
  const authScreen = document.getElementById('auth-screen');
  const modeScreen = document.getElementById('launch-screen');
  if (authScreen) authScreen.style.display = 'none';
  if (modeScreen) modeScreen.style.display = 'flex';
  setLaunchAnimationLabOpen(false);
  document.body.classList.add('launch');
  document.body.classList.remove('quickplay');
  document.body.classList.remove('tournament');
  document.body.classList.remove('practice');
  document.body.classList.remove('has-team-color');
  setBrowserTitle('launch');
  try { refreshNameUI?.(); } catch (_) {}
}

function returnToLaunchScreen(opts = {}) {
  const skipPracticeCleanup = !!opts.skipPracticeCleanup;
  if (!skipPracticeCleanup) {
    try {
      if (typeof window.isPracticeGameActive === 'function' && window.isPracticeGameActive()) {
        void window.handleLeaveGame?.({ skipConfirm: true, skipReturn: true });
      }
    } catch (_) {}
  }
  // Logo = start over. Clear any device-local resume state so refresh doesn't jump back into the previous mode.
  clearLastNavigation();
  showAuthLoadingScreen();
  setTimeout(() => {
    try {
      if (auth.currentUser) showLaunchScreen();
      else showAuthScreen();
    } finally {
      hideAuthLoadingScreen();
    }
  }, 200);
}

// Allow other modules (game.js) to return to the initial screen.
window.returnToLaunchScreen = returnToLaunchScreen;

/* =========================
   Quick Play gate (live game in progress)
========================= */

let qpGateEl = null;
let qpGateRejoinBtn = null;
let qpGateSpectateBtn = null;
let qpGateBackBtn = null;
let qpGateStatus = null;
let qpGateState = { gameId: null, canRejoin: false };

function initQuickPlayGate() {
  qpGateEl = document.getElementById('qp-gate');
  if (!qpGateEl) return;
  qpGateRejoinBtn = document.getElementById('qp-gate-rejoin');
  qpGateSpectateBtn = document.getElementById('qp-gate-spectate');
  qpGateBackBtn = document.getElementById('qp-gate-back');
  qpGateStatus = document.getElementById('qp-gate-status');

  const hide = () => hideQuickPlayGate();
  qpGateEl.addEventListener('click', (e) => {
    // Click-out closes the gate.
    if (e.target === qpGateEl) hide();
  });
  window.addEventListener('keydown', (e) => {
    if (!document.body.classList.contains('qp-gate-open')) return;
    if (e.key === 'Escape') hide();
  });

  qpGateBackBtn?.addEventListener('click', () => {
    // Back to Homepage should NOT sign you out. Just exit the live-game chooser.
    try { hide(); } catch (_) {}
    try { stopGameListener?.(); } catch (_) {}
    try { window.returnToLaunchScreen?.(); } catch (_) {}
  });

  // Rejoin the in-progress Quick Play game (only if eligible).
  qpGateRejoinBtn?.addEventListener('click', () => {
    if (!qpGateState?.canRejoin) return;
    hideQuickPlayGate();
    // Switch from spectator preview to player mode.
    try { window.startQuickPlayLiveBackdrop?.({ spectator: false }); } catch (_) {}
  });

  // Spectate: keep the live game running behind the overlay.
  qpGateSpectateBtn?.addEventListener('click', () => {
    hideQuickPlayGate();
    // Ensure we're in spectator mode.
    try { window.startQuickPlayLiveBackdrop?.({ spectator: true }); } catch (_) {}
  });
}

function showQuickPlayGate({ gameId, canRejoin } = {}) {
  if (!qpGateEl) return;
  qpGateState = { gameId: gameId || null, canRejoin: !!canRejoin };
  document.body.classList.add('qp-gate-open');
  qpGateEl.classList.remove('hidden');
  if (qpGateStatus) qpGateStatus.textContent = 'A live game is in progress.';

  if (qpGateRejoinBtn) {
    qpGateRejoinBtn.disabled = !qpGateState.canRejoin;
    qpGateRejoinBtn.classList.toggle('disabled', !qpGateState.canRejoin);
  }
}

function hideQuickPlayGate() {
  if (!qpGateEl) return;
  qpGateEl.classList.add('hidden');
  document.body.classList.remove('qp-gate-open');
}

async function maybeGateQuickPlayWithLiveGame(opts = {}) {
  // Checks the authoritative Quick Play singleton game doc.
  // If a live game is in progress, we enter Quick Play (skipping the lobby),
  // start a live backdrop, then present the 3-button chooser.
  const QUICKPLAY_DOC_ID = 'quickplay';

  const minDelayMs = Number.isFinite(opts.minDelayMs) ? Math.max(0, opts.minDelayMs) : 350;

  // Default: if the caller provided onProceed (already inside the app), avoid flashing a loader unless requested.
  const showLoading = (typeof opts.showLoading === 'boolean')
    ? opts.showLoading
    : (typeof opts.onProceed !== 'function');

  const loadingLabel = String(opts.loadingLabel || 'Loading');
  const onProceed = (typeof opts.onProceed === 'function')
    ? opts.onProceed
    : (() => {
        enterAppFromLaunch('quick');
      });

  const startedAtMs = Date.now();
  if (showLoading) showAuthLoadingScreen(loadingLabel);

  let snap = null;
  try {
    snap = await db.collection('games').doc(QUICKPLAY_DOC_ID).get();
  } catch (e) {
    console.warn('Quick Play gate lookup failed (best-effort):', e);
  }

  const finish = () => {
    if (showLoading) hideAuthLoadingScreen();
  };

  const scheduleAfterMinDelay = (fn) => {
    const elapsed = Date.now() - startedAtMs;
    const wait = Math.max(minDelayMs - elapsed, 0);
    setTimeout(fn, wait);
  };

  // No doc -> treat as no live game.
  if (!snap || !snap.exists) {
    scheduleAfterMinDelay(() => {
      (async () => {
        try {
          try { if (typeof window.resetQuickPlayReady === 'function') window.resetQuickPlayReady(); } catch (_) {}
          await Promise.resolve(onProceed());
          if (typeof window.waitForQuickPlayReady === 'function') {
            await window.waitForQuickPlayReady({ timeoutMs: 12000 });
          }
        } finally {
          finish();
        }
      })();
    });
    return;
  }

  const g = snap.data() || {};
  const inProgress = !!(g.currentPhase && g.currentPhase !== 'waiting' && g.winner == null);

  if (!inProgress) {
    scheduleAfterMinDelay(() => {
      (async () => {
        try {
          try { if (typeof window.resetQuickPlayReady === 'function') window.resetQuickPlayReady(); } catch (_) {}
          await Promise.resolve(onProceed());
          if (typeof window.waitForQuickPlayReady === 'function') {
            await window.waitForQuickPlayReady({ timeoutMs: 12000 });
          }
        } finally {
          finish();
        }
      })();
    });
    return;
  }

  // Live Quick Play game is in progress.
  const uid = String(getUserId?.() || '').trim();
  const redPlayers = Array.isArray(g.redPlayers) ? g.redPlayers : [];
  const bluePlayers = Array.isArray(g.bluePlayers) ? g.bluePlayers : [];
  const ids = new Set([
    ...redPlayers.map(p => String(p?.odId || '').trim()).filter(Boolean),
    ...bluePlayers.map(p => String(p?.odId || '').trim()).filter(Boolean),
  ]);
  const canRejoin = !!uid && ids.has(uid);

  scheduleAfterMinDelay(() => {
    (async () => {
      try {
        // Enter Quick Play, but skip the lobby so users never see it flash.
        try { if (typeof window.resetQuickPlayReady === 'function') window.resetQuickPlayReady(); } catch (_) {}
        enterAppFromLaunch('quick', { skipQuickLobby: true, restore: true });

        // Start a spectator preview of the live game so it plays behind the overlay.
        try { window.startQuickPlayLiveBackdrop?.({ spectator: true }); } catch (_) {}

        // Show the chooser.
        showQuickPlayGate({ gameId: QUICKPLAY_DOC_ID, canRejoin });

        // Keep the loader up until the backdrop/game has rendered at least once.
        if (typeof window.waitForQuickPlayReady === 'function') {
          await window.waitForQuickPlayReady({ timeoutMs: 12000 });
        }
      } finally {
        finish();
      }
    })();
  });
}

// Allow game.js to gate quick-play navigation too.
window.maybeGateQuickPlayWithLiveGame = maybeGateQuickPlayWithLiveGame;

/* =========================
   Launch + auth screens
   - Auth first
   - Then choose Quick Play vs Tournament
========================= */
function initLaunchScreen() {
  const screen = document.getElementById('launch-screen');
  if (!screen) return;

  // Hide the rest of the app until a mode is chosen.
  document.body.classList.add('launch');
  setBrowserTitle('launch');
  // NOTE: We do not show Auth/Launch here to avoid a flash on reload.
  // The initial screen is chosen after Firebase Auth resolves (initAuthGate).

  const quickBtn = document.getElementById('launch-quick-play');
  const tournBtn = document.getElementById('launch-tournament');
  const bracketsBtn = document.getElementById('launch-brackets');
  const practiceBtn = document.getElementById('launch-practice');
  const animBtn = document.getElementById('launch-animations');
  const animBackBtn = document.getElementById('launch-animation-back');

  const hint = document.getElementById('launch-name-hint');

  const requireAuthThen = async (mode, opts = {}) => {
    const u = auth.currentUser;
    const name = getUserName();
    if (!u || !name) {
      // If somehow they reach mode buttons while signed out, bounce to auth.
      try { showAuthScreen(); } catch (_) {}
      if (hint) hint.textContent = 'Sign in to continue.';
      try { document.getElementById('launch-username-login')?.focus(); } catch (_) {}
      return;
    }
    if (hint) hint.textContent = '';
    // Quick Play can be gated if there's a live game in progress.
    if (mode === 'quick' && opts && opts.gateIfLiveGame) {
      maybeGateQuickPlayWithLiveGame();
      return;
    }

    // Show loading screen during navigation transition
    showAuthLoadingScreen();

    // Ensure the loader stays up until the destination has rendered a usable first state.
    try { if (mode === 'quick' && typeof window.resetQuickPlayReady === 'function') window.resetQuickPlayReady(); } catch (_) {}

    (async () => {
      try {
        enterAppFromLaunch(mode, opts);
        if (mode === 'quick' && typeof window.waitForQuickPlayReady === 'function') {
          await window.waitForQuickPlayReady({ timeoutMs: 15000 });
        }
      } finally {
        hideAuthLoadingScreen();
      }
    })();
  };

  // Quick Play can be gated if there's already a live game in progress.
  // In that case we keep the game running in the background and show a chooser.
  quickBtn?.addEventListener('click', () => requireAuthThen('quick', { gateIfLiveGame: true }));
  tournBtn?.addEventListener('click', () => requireAuthThen('tournament'));
  bracketsBtn?.addEventListener('click', () => requireAuthThen('tournament', { panel: 'panel-brackets' }));
  practiceBtn?.addEventListener('click', () => requireAuthThen('tournament', { panel: 'panel-practice' }));
  animBtn?.addEventListener('click', () => {
    const u = auth.currentUser;
    const name = getUserName();
    if (!u || !name) {
      try { showAuthScreen(); } catch (_) {}
      if (hint) hint.textContent = 'Sign in to continue.';
      return;
    }
    if (!isAdminUser()) {
      if (hint) hint.textContent = 'Animations tab is admin-only.';
      return;
    }
    if (hint) hint.textContent = '';
    setLaunchAnimationLabOpen(true);
  });
  animBackBtn?.addEventListener('click', () => setLaunchAnimationLabOpen(false));

  // Auth UI on launch (username + password)
  const loginForm = document.getElementById('launch-login-form');
  const createForm = document.getElementById('launch-create-form');
  const loginUserInput = document.getElementById('launch-username-login');
  const loginPassInput = document.getElementById('launch-password-login');
  const createUserInput = document.getElementById('launch-username-create');
  const createPassInput = document.getElementById('launch-password-create');
  const loginHint = document.getElementById('launch-name-hint');
  const createHint = document.getElementById('launch-name-hint-create');
  const showLoginBtn = document.getElementById('launch-show-login');
  const showCreateBtn = document.getElementById('launch-show-create');
  const modeLogoutBtn = document.getElementById('mode-logout-btn');

  // Username/password helpers live at the top of this file.

  function setAuthTab(which) {
    const loginOn = which === 'login';
    if (loginForm) loginForm.style.display = loginOn ? '' : 'none';
    if (createForm) createForm.style.display = loginOn ? 'none' : '';
    if (showLoginBtn) showLoginBtn.classList.toggle('primary', loginOn);
    if (showCreateBtn) showCreateBtn.classList.toggle('primary', !loginOn);
    try { (loginOn ? loginUserInput : createUserInput)?.focus?.(); } catch (_) {}
  }
  showLoginBtn?.addEventListener('click', () => setAuthTab('login'));
  showCreateBtn?.addEventListener('click', () => setAuthTab('create'));

  loginForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = normalizeUsername(loginUserInput?.value);
    const pass = String(loginPassInput?.value || '');
    if (!username || !pass) {
      if (loginHint) loginHint.textContent = 'Enter username + password.';
      return;
    }
    if (!isValidUsername(username)) {
      if (loginHint) loginHint.textContent = 'Invalid username.';
      return;
    }
    if (loginHint) loginHint.textContent = '';
    try {
      showAuthLoadingScreen('Logging in');
      const handle = await lookupAuthHandleForUsername(username);
      if (!handle) {
        if (loginHint) loginHint.textContent = 'No account found. Try creating one.';
        return;
      }
      await auth.signInWithEmailAndPassword(handle, passwordForAuth(pass));
      // Best-effort: ensure display name is set (older accounts).
      const u = auth.currentUser;
      if (u && !String(u.displayName || '').trim()) {
        try { await u.updateProfile({ displayName: username }); } catch (_) {}
      }
      await refreshAdminClaims();
      try { refreshNameUI(); } catch (_) {}
    } catch (err) {
      console.warn('Login failed', err);
      const ec = String(err?.code || '');
      if (ec === 'auth/configuration-not-found') {
        if (loginHint) loginHint.textContent = 'Sign-in is not enabled for this Firebase project. Enable Email/Password in Firebase Console → Authentication.';
      } else if (ec === 'auth/network-request-failed') {
        if (loginHint) loginHint.textContent = 'Network error. Check your connection and try again.';
      } else {
        if (loginHint) loginHint.textContent = 'Login failed. Check username/password.';
      }
    } finally {
      hideAuthLoadingScreen();
    }
  });

  createForm?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = normalizeUsername(createUserInput?.value);
    const pass = String(createPassInput?.value || '');
    const display = username; // username == name
    if (!username || !pass) {
      if (createHint) createHint.textContent = 'Enter username + password.';
      return;
    }
    if (!isValidUsername(username)) {
      if (createHint) createHint.textContent = 'Username must be 3–20 chars: a-z, 0-9, _';
      return;
    }
    if (createHint) createHint.textContent = '';
    try {
      showAuthLoadingScreen('Creating account');
      // Mark provisioning to prevent false "corrupted" enforcement while
      // Firestore username/profile docs are being written.
      setProvisioning(username);
      // Fast pre-check to give a nice message.
      // (The transaction below is the real enforcement.)
      try {
        const existsSnap = await db.collection('usernames').doc(username).get();
        if (existsSnap.exists) throw new Error('USERNAME_TAKEN');
      } catch (e) {
        if (String(e?.message || '').includes('USERNAME_TAKEN')) throw e;
      }

      // Create the auth user using a non-deterministic handle.
      const authHandle = makeAuthHandle(username);
      await auth.createUserWithEmailAndPassword(authHandle, passwordForAuth(pass));

      const u = auth.currentUser;
      if (!u) throw new Error('No auth user after signup');

      // Claim the username atomically.
      const unameRef = db.collection('usernames').doc(username);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(unameRef);
        if (snap.exists) {
          throw new Error('USERNAME_TAKEN');
        }
        tx.set(unameRef, {
          uid: u.uid,
          authHandle,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      });

      // Store a user profile doc (handy for admin tooling + future features).
      try {
        await db.collection('users').doc(u.uid).set({
          username,
          name: display,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) {}

      // Set display name used everywhere in the UI.
      try { await u.updateProfile({ displayName: display }); } catch (_) {}
      // Mirror display name into players/<uid>.
      try {
        await db.collection('players').doc(u.uid).set({
          name: display,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) {}

      // Provisioning complete.
      clearProvisioning();

      await refreshAdminClaims();
      try { refreshNameUI(); } catch (_) {}
      // Provisioning completed successfully.
      clearProvisioning();
    } catch (err) {
      console.warn('Signup failed', err);
      const msg = String(err?.message || '');
      const ec = String(err?.code || '');

      // Prefer friendly, specific errors.
      if (msg.includes('USERNAME_TAKEN') || ec === 'auth/email-already-in-use') {
        if (createHint) createHint.textContent = "There's already an account. Try logging in.";
      } else if (ec === 'auth/invalid-email') {
        // Usually means our internal handle format was rejected.
        if (createHint) createHint.textContent = 'Could not create account. Username not allowed.';
      } else if (ec === 'auth/operation-not-allowed') {
        if (createHint) createHint.textContent = 'Account creation is disabled right now.';
      } else if (ec === 'auth/weak-password') {
        // Should be rare because we transform short passwords before sending
        // them to Auth, but keep a friendly fallback.
        if (createHint) createHint.textContent = 'Password is too weak. Try a different one.';
      } else if (ec === 'auth/configuration-not-found') {
        // This happens when Email/Password is disabled for the Firebase project.
        if (createHint) createHint.textContent = 'Account creation is not enabled for this Firebase project. In Firebase Console → Authentication, enable Email/Password and try again.';
      } else if (ec === 'permission-denied') {
        if (createHint) createHint.textContent = 'Signup is blocked by server rules.';
      } else if (ec === 'auth/network-request-failed') {
        if (createHint) createHint.textContent = 'Network error. Check your connection and try again.';
      } else {
        // Last resort: show a compact hint so debugging is possible without exposing internals.
        const codeHint = ec ? ` (${ec})` : '';
        if (createHint) createHint.textContent = `Could not create account. Please try again.${codeHint}`;
      }

      // Best-effort cleanup if we created an auth user but failed to claim the username.
      try {
        const u = auth.currentUser;
        if (u) await u.delete();
      } catch (_) {
        // If delete fails (rare), leave the account; admin can clean up later.
      }
      clearProvisioning();
      try { await auth.signOut(); } catch (_) {}
      clearProvisioning();
    } finally {
      hideAuthLoadingScreen();
    }
  });

  modeLogoutBtn?.addEventListener('click', () => requestLogout());

  // Default tab
  setAuthTab('login');

  refreshNameUI();
}

const GAME_RUNTIME_CORE_APIS = ['showQuickPlayLobby', 'startGameListener', 'createPracticeGame'];
let _gameRuntimeBootstrapPromise = null;

function hasGameRuntimeApis(required = GAME_RUNTIME_CORE_APIS) {
  const list = Array.isArray(required) && required.length ? required : GAME_RUNTIME_CORE_APIS;
  return list.every((name) => typeof window?.[name] === 'function');
}

function showQuickPlayFallbackState(statusText = '') {
  const setDisplay = (id, display) => {
    const el = document.getElementById(id);
    if (el) el.style.display = display;
  };

  setDisplay('play-mode-select', 'none');
  setDisplay('quick-play-lobby', 'block');
  setDisplay('tournament-lobby', 'none');
  setDisplay('game-board-container', 'none');

  const hasName = !!getUserName();
  const nameCheck = document.getElementById('quick-name-check');
  const setup = document.getElementById('quick-setup');
  if (nameCheck) nameCheck.style.display = hasName ? 'none' : 'block';
  if (setup) setup.style.display = hasName ? 'block' : 'none';

  const hint = document.getElementById('quick-lobby-hint');
  if (hint) hint.textContent = String(statusText || '').trim();
}

async function ensureGameRuntimeApis(required = GAME_RUNTIME_CORE_APIS, opts = {}) {
  if (hasGameRuntimeApis(required)) return true;

  if (_gameRuntimeBootstrapPromise) {
    await _gameRuntimeBootstrapPromise.catch(() => {});
    return hasGameRuntimeApis(required);
  }

  _gameRuntimeBootstrapPromise = (async () => {
    const settleMs = Number.isFinite(opts?.settleMs) ? Math.max(0, opts.settleMs) : 450;
    const timeoutMs = Number.isFinite(opts?.timeoutMs) ? Math.max(1000, opts.timeoutMs) : 3800;
    const startAt = Date.now();

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const waitUntil = async (limitMs) => {
      while ((Date.now() - startAt) < limitMs) {
        if (hasGameRuntimeApis(required)) return true;
        await wait(60);
      }
      return hasGameRuntimeApis(required);
    };

    if (await waitUntil(settleMs)) return true;

    try {
      const existingRetry = document.querySelector('script[data-ct-game-runtime-retry="1"]');
      if (!existingRetry) {
        const script = document.createElement('script');
        script.src = `game.js?retry=${Date.now()}`;
        script.async = true;
        script.dataset.ctGameRuntimeRetry = '1';
        (document.body || document.head || document.documentElement)?.appendChild(script);
      }
    } catch (e) {
      console.warn('Failed to retry-load game runtime:', e);
    }

    return waitUntil(timeoutMs);
  })();

  try {
    return await _gameRuntimeBootstrapPromise;
  } finally {
    _gameRuntimeBootstrapPromise = null;
  }
}

function enterAppFromLaunch(mode, opts = {}) {
  const screen = document.getElementById('launch-screen');
  if (screen) screen.style.display = 'none';
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';

  // Default: leave launch state.
  document.body.classList.remove('launch');
  document.body.classList.remove('tournament');
  document.body.classList.remove('practice');

  // QUICK PLAY
  // - Full-screen lobby/game
  // - No tabs (top band stays)
  if (mode === 'quick') {
    // Persist mode so a refresh keeps the user in Quick Play.
    safeLSSet(LS_NAV_MODE, 'quick');
    safeLSSet(LS_NAV_PANEL, 'panel-game');
    document.body.classList.add('quickplay');
    document.body.classList.remove('tournament');
    // Ensure any tournament-only chrome (team glow/text) is off.
    try { refreshHeaderIdentity?.(); } catch (_) {}
    setBrowserTitle('quick');
    if (opts && opts.skipQuickLobby) {
      skipQuickPlayLobbyOnce = true;
    }
    switchToPanel('panel-game');

    const hasQuickLobbyApi = (typeof window.showQuickPlayLobby === 'function');
    if (!hasQuickLobbyApi) {
      try { showQuickPlayFallbackState('Loading multiplayer…'); } catch (_) {}
      void ensureGameRuntimeApis(['showQuickPlayLobby'], { timeoutMs: 4200 }).then((ok) => {
        if (!ok) return;
        if (!document.body.classList.contains('quickplay')) return;
        if (activePanelId !== 'panel-game') return;
        try { window.showQuickPlayLobby?.(); } catch (_) {}
      });
    }

    // Defensive: ensure the generic mode chooser is never visible in Quick Play.
    // (On slow loads or if game.js hasn't initialized yet, the default UI can
    // briefly show the Quick/Tournament chooser, which looks like the click
    // "didn't work".)
    if (!opts || !opts.skipQuickLobby) {
      try {
        const chooser = document.getElementById('play-mode-select');
        if (chooser && hasQuickLobbyApi) chooser.style.display = 'none';
      } catch (_) {}
    }
    try { window.bumpPresence?.(); } catch (_) {}
    return;
  }

  // TOURNAMENT
  // - Normal navigation visible
  document.body.classList.remove('quickplay');
  document.body.classList.add('tournament');
  // Persist mode so a refresh keeps the user in Tournament.
  safeLSSet(LS_NAV_MODE, 'tournament');
  // Apply team color/theme immediately on entry (no need to edit color).
  try { refreshHeaderIdentity?.(); } catch (_) {}
  setBrowserTitle('tournament');

  // By default we land on Home, but allow callers to request a specific panel.
  const requestedPanel = (opts && typeof opts.panel === 'string') ? opts.panel : null;
  if (!opts || !opts.restore) {
    const target = requestedPanel || 'panel-home';
    switchToPanel(target);
    safeLSSet(LS_NAV_PANEL, target);
  }

  try { window.bumpPresence?.(); } catch (_) {}
}

/* =========================
   Auth gate
   - All Firestore listeners and writes assume request.auth.uid is present
========================= */
function initAuthGate() {
  try {
    auth.onAuthStateChanged(async (u) => {
      const isBoot = !bootAuthResolvedOnce;
      if (isBoot) {
        bootAuthResolvedOnce = true;
        // Loader is already shown during init(). Don't increment again or it can get stuck.
        try {
          if (typeof setAuthLoadingMessage === 'function') setAuthLoadingMessage('Loading');
          else if (typeof showAuthLoadingScreen === 'function' && (_authLoadingCount | 0) === 0) showAuthLoadingScreen('Loading');
        } catch (_) {}
      }
      // Refresh admin claims best-effort.
      try { await refreshAdminClaims(); } catch (_) {}

      // Update header name immediately.
      try { refreshNameUI(); } catch (_) {}

      // Signed out: stop listeners + show auth page.
      if (!u) {
        // Stop presence + clear timers when signed out.
        try { stopPresenceListener(); } catch (_) {}
        try { if (presenceUpdateInterval) clearInterval(presenceUpdateInterval); } catch (_) {}
        presenceUpdateInterval = null;
        presenceInitialized = false;

        try { teamsUnsub?.(); } catch (_) {}
        try { playersUnsub?.(); } catch (_) {}
        teamsUnsub = null;
        playersUnsub = null;
        teamsCache = [];
        playersCache = [];
        // Stop DM thread listener + clear caches so badges reset.
        try { stopDmInboxListener(); } catch (_) {}
        unreadPersonalCount = 0;
        try { clearLastNavigation(); } catch (_) {}
        try { showAuthScreen(); } catch (_) {}
        if (isBoot) finishBootAuthLoading(750);
        return;
      }

      // Signed in: immediately hide the auth UI so it never flashes behind
      // the loading screen during refresh.
      try {
        const authScreen = document.getElementById('auth-screen');
        if (authScreen) authScreen.style.display = 'none';
      } catch (_) {}

      // Ensure we can resolve a stable username for UI/presence.
      // During signup, this may briefly be missing; we retry a few times.
      let resolvedUsername = null;
      try {
        resolvedUsername = await ensureUserDisplayName(u);
      } catch (_) {}

      
// Account self-heal:
// If someone deleted Firestore docs (usernames/users/players) but the user is still signed in,
// we recreate the missing pieces instead of treating it as corruption.
try {
  let integrity = null;
  const prov = getProvisioning();
  const retries = prov ? 10 : 5;

  for (let i = 0; i < retries; i++) {
    integrity = await checkAccountIntegrity(u, resolvedUsername);

    if (!integrity || integrity.ok !== false) break;

    // Repairable: missing registry (or name during early boot).
    if (integrity.canRepair) {
      await new Promise(r => setTimeout(r, 180));
      const repaired = await repairAccountDocs(u, integrity.username || resolvedUsername);
      if (repaired && repaired.ok) {
        resolvedUsername = repaired.username || resolvedUsername;
        // Re-check on next loop.
        continue;
      }
    }

    // During provisioning (signup), allow a little extra time for writes to land.
    if (prov && ['Missing username registry', 'Missing account name'].includes(integrity.reason)) {
      await new Promise(r => setTimeout(r, 250));
      try { resolvedUsername = await ensureUserDisplayName(u) || resolvedUsername; } catch (_) {}
      continue;
    }

    break;
  }

  
if (integrity && integrity.ok === false) {
  // If an account is truly corrupted and we cannot repair it client-side, automatically delete it
  // so the username can be reused and the app doesn’t get stuck in a broken state.
  try {
    await showSystemDialog({
      title: 'Account removed',
      message: `This account appears corrupted (${integrity.reason}).\n\nWe removed it so the username can be reused.`,
      okText: 'OK'
    });
  } catch (_) {}

  try { await purgeCorruptedAccountEverywhere(u, { username: integrity.username }); } catch (e) {
    console.warn('Auto-purge corrupted account failed (best-effort)', e);
  }
  try { await auth.signOut(); } catch (_) {}
  try { showAuthScreen(); } catch (_) {}
  if (isBoot) finishBootAuthLoading(750);
  return;
}
} catch (e) {
  console.warn('Integrity self-heal skipped (best-effort)', e);
}

// Ensure player profile exists.
      try {
        const uid = String(u?.uid || '').trim();
        if (uid) {
          const ref = db.collection('players').doc(uid);
          const displayName = String(u?.displayName || '').trim() || 'Player';

          // IMPORTANT: createdAt should reflect the day the account was created.
          // Never overwrite it once it exists.
          await db.runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const data = snap.exists ? (snap.data() || {}) : {};
            const patch = {
              name: displayName,
              updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
            };
            if (!data.createdAt) {
              // Prefer Auth creation time for the signed-in user; fall back to server time.
              const ct = u?.metadata?.creationTime ? new Date(u.metadata.creationTime) : null;
              patch.createdAt = ct && !isNaN(ct.getTime())
                ? firebase.firestore.Timestamp.fromDate(ct)
                : firebase.firestore.FieldValue.serverTimestamp();
            }
            tx.set(ref, patch, { merge: true });
          });
        }
      } catch (e) {
        console.warn('Failed to ensure player profile (best-effort)', e);
      }

      // Start listeners once.
      try { listenToTeams(); } catch (_) {}
      try { listenToPlayers(); } catch (_) {}

      // Start DM thread listener so personal messages contribute to the
      // unread badge count even when the Personal tab isn't open.
      try { startDmInboxListener(); } catch (_) {}

      // Presence must start after sign-in. Without this, "Who's Online" can't
      // mark anyone as online/idle.
      try {
        if (!presenceInitialized && getUserName()) {
          presenceInitialized = true;
          initPresence();
        }
      } catch (_) {}

      // Restore last navigation if available; otherwise show the mode chooser.
      // If this tab is a Practice deep link, jump straight into that game.
      try {
        const didPractice = (typeof handlePracticeDeepLink === 'function') ? handlePracticeDeepLink() : false;
        if (!didPractice) {
          restoreLastNavigation();
          const inMode = document.body.classList.contains('quickplay') || document.body.classList.contains('tournament');
          if (!inMode) showLaunchScreen();
        }
      } catch (_) {
        try { showLaunchScreen(); } catch (_) {}
      }

      if (isBoot) finishBootAuthLoading(750);
    });
  } catch (e) {
    console.error('Auth init failed:', e);
  }
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

  // Mark *all* tabs that point at the target panel as active (desktop + mobile)
  tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === targetId));
  panels.forEach(p => p.classList.toggle('active', p.id === targetId));

  activePanelId = targetId;

  // Brackets + Practice are immersive pages; hide primary tabs while viewing them.
  try {
    const noTabs = (targetId === 'panel-brackets' || targetId === 'panel-practice');
    document.body.classList.toggle('no-primary-tabs', !!noTabs);
    document.body.classList.toggle('brackets-mobile-no-tabs', !!noTabs);
  } catch (_) {}

  // If a game board is visible, we don't show the messages drawer.
  if (isInGameBoardView() && chatDrawerOpen) {
    try { setChatDrawerOpen(false); } catch (_) {}
  }

  recomputeUnreadBadges();
  try { window.bumpPresence?.(); } catch (_) {}

  // Persist the user's last-viewed panel in Tournament mode (and mode itself), so refresh restores it.
  // In Quick Play we still store the mode so the launch screen is skipped on refresh.
  persistLastNavigation();

  // In tournament mode, the Play panel should always render the tournament lobby.
  if (targetId === 'panel-game') {
    try {
      if (document.body.classList.contains('tournament') && typeof window.showTournamentLobby === 'function') {
        window.showTournamentLobby();
      }
      if (document.body.classList.contains('quickplay') && typeof window.showQuickPlayLobby === 'function') {
        if (!skipQuickPlayLobbyOnce) {
          window.showQuickPlayLobby();
        }
        skipQuickPlayLobbyOnce = false;
      } else if (document.body.classList.contains('quickplay')) {
        showQuickPlayFallbackState('Loading multiplayer…');
        void ensureGameRuntimeApis(['showQuickPlayLobby'], { timeoutMs: 4200 }).then((ok) => {
          if (!ok) return;
          if (!document.body.classList.contains('quickplay')) return;
          if (activePanelId !== 'panel-game') return;
          try { window.showQuickPlayLobby?.(); } catch (_) {}
        });
      }
    } catch (_) {}
  }

  if (targetId === 'panel-brackets') {
    try { renderBrackets(teamsCache); } catch (_) {}
  }

  // Keep header icons in sync with current view
  try { updateHeaderIconVisibility(); } catch (_) {}
}



/* =========================
   Device-local navigation restore
========================= */

function clearLastNavigation() {
  try { localStorage.removeItem(LS_NAV_MODE); } catch (_) {}
  try { localStorage.removeItem(LS_NAV_PANEL); } catch (_) {}
  // Also clear any "resume game" hint (game.js will re-set this when a game is joined).
  try { localStorage.removeItem(LS_ACTIVE_GAME_ID); } catch (_) {}
  try { localStorage.removeItem(LS_ACTIVE_GAME_SPECTATOR); } catch (_) {}
}

function persistLastNavigation() {
  try {
    if (document.body.classList.contains('tournament')) {
      safeLSSet(LS_NAV_MODE, 'tournament');
      safeLSSet(LS_NAV_PANEL, activePanelId || 'panel-home');
      return;
    }
    if (document.body.classList.contains('quickplay')) {
      safeLSSet(LS_NAV_MODE, 'quick');
      safeLSSet(LS_NAV_PANEL, 'panel-game');
      return;
    }
    // Launch mode: don't persist a resume target.
  } catch (_) {}
}

function restoreLastNavigation() {
  // Only restore after Firebase Auth has hydrated.
  if (!auth.currentUser) return;
  const mode = (safeLSGet(LS_NAV_MODE) || '').trim();
  if (!mode) return;

  // Capture the saved panel *synchronously* before any other init logic might touch localStorage (best-effort).
  const savedPanel = (mode === 'tournament')
    ? String(safeLSGet(LS_NAV_PANEL) || 'panel-home').trim()
    : '';

  // If they haven't set a name yet, don't auto-enter a mode.
  const name = (getUserName() || '').trim();
  if (!name) {
    clearLastNavigation();
    return;
  }

  // QUICK PLAY restore:
  // - Avoid flashing the Quick Play lobby on refresh.
  // - If a live Quick Play game is in progress, show the smooth "live game" chooser.
  if (mode === 'quick') {
    // Practice games are local-only and should resume directly from local storage.
    try {
      const resumeId = String(safeLSGet(LS_ACTIVE_GAME_ID) || '').trim();
      const isLocalPractice = !!(
        resumeId &&
        typeof window.isLocalPracticeGameId === 'function' &&
        window.isLocalPracticeGameId(resumeId)
      );
      const hasPracticeState = !isLocalPractice
        ? false
        : (typeof window.hasLocalPracticeGame === 'function'
            ? !!window.hasLocalPracticeGame(resumeId)
            : true);
      if (isLocalPractice && !hasPracticeState) {
        try { localStorage.removeItem(LS_ACTIVE_GAME_ID); } catch (_) {}
        try { localStorage.removeItem(LS_ACTIVE_GAME_SPECTATOR); } catch (_) {}
      }
      if (isLocalPractice && hasPracticeState) {
        showAuthLoadingScreen('Restoring');
        setTimeout(() => {
          try {
            enterAppFromLaunch('quick', { restore: true, skipQuickLobby: true });
            try { window.showGameBoard?.(); } catch (_) {}
            try { window.startGameListener?.(resumeId, { spectator: false, ephemeral: true }); } catch (_) {}
            try { document.body.classList.add('practice'); } catch (_) {}
          } finally {
            hideAuthLoadingScreen();
          }
        }, 0);
        return;
      }
    } catch (_) {}

    try {
      maybeGateQuickPlayWithLiveGame({
        showLoading: true,
        loadingLabel: 'Loading',
        minDelayMs: 300,
        onProceed: () => {
          // No live game in progress -> enter Quick Play normally.
          enterAppFromLaunch('quick', { restore: true });
        }
      });
    } catch (e) {
      console.warn('Quick Play restore failed (best-effort)', e);
      showAuthLoadingScreen('Loading');
      setTimeout(() => {
        try { enterAppFromLaunch('quick', { restore: true }); }
        finally { hideAuthLoadingScreen(); }
      }, 0);
    }
    return;
  }

  // TOURNAMENT restore:
  // Avoid showing the launch screen when we know where the user was.
  showAuthLoadingScreen('Restoring');

  // Let the DOM settle, then restore.
  setTimeout(() => {
    try {
      enterAppFromLaunch('tournament', { restore: true });
      if (savedPanel) {
        switchToPanel(savedPanel);
        // Some init code can fire shortly after load; re-assert the saved tab once.
        setTimeout(() => {
          try {
            if (savedPanel && activePanelId !== savedPanel) switchToPanel(savedPanel);
          } catch (_) {}
        }, 60);
      }

      // If the user was in an active game, resume it (best-effort).
      try { window.restoreLastGameFromStorage?.(); } catch (_) {}
    } finally {
      hideAuthLoadingScreen();
    }
  }, 0);
}


function initHomeActions() {
  const openBrackets = document.getElementById('home-open-brackets');
  const openPractice = document.getElementById('home-open-practice');
  openBrackets?.addEventListener('click', () => {
    try { switchToPanel('panel-brackets'); } catch (_) { activatePanel('panel-brackets'); }
  });
  openPractice?.addEventListener('click', () => {
    try { switchToPanel('panel-practice'); } catch (_) { activatePanel('panel-practice'); }
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

function getUserId() {
  // Primary identity is Firebase Auth uid.
  return String(auth.currentUser?.uid || '').trim();
}

function getUserName() {
  // Display name lives on the Firebase Auth user.
  return String(auth.currentUser?.displayName || '').trim();
}

async function setUserName(name, opts = {}) {
  // In this app, "name" == "username" and is used for login.
  // Renaming requires migrating the username registry key.
  const nextName = normalizeUsername(name);
  const u = auth.currentUser;
  if (!u) throw new Error('Not signed in');
  if (!nextName) return { changed: false, name: '' };
  if (!isValidUsername(nextName)) {
    throw new Error('Username must be 3–20 chars: a-z, 0-9, _');
  }

  showAuthLoadingScreen('Updating name');

  // Used to avoid profile listener bouncing the UI during a local rename.
  lastLocalNameSetAtMs = Date.now();

  const uid = String(u.uid || '').trim();
  const usernamesCol = db.collection('usernames');
  const usersCol = db.collection('users');
  const playersCol = db.collection('players');

  // IMPORTANT:
  // Do NOT trust auth.displayName as the canonical previous username.
  // Some older accounts (or repaired accounts) may have a stale/missing displayName.
  // We resolve the current registry username for this uid and treat that as canonical.
  let prevName = normalizeUsername(getUserName());
  let canonicalPrevName = prevName;

  try {
    const resolved = await resolveUsernameForUid(uid);
    if (resolved) canonicalPrevName = normalizeUsername(resolved);
  } catch (_) {}

  // If we already are on that name, still ensure local caches are updated.
  if (canonicalPrevName && canonicalPrevName === nextName) {
    try { await u.updateProfile({ displayName: nextName }); } catch (_) {}
    try { safeLSSet(LS_LAST_USERNAME, nextName); } catch (_) {}
    try { refreshNameUI(); } catch (_) {}
    hideAuthLoadingScreen();
    return { changed: false, name: nextName };
  }

  const oldRef = canonicalPrevName ? usernamesCol.doc(canonicalPrevName) : null;
  const newRef = usernamesCol.doc(nextName);

  try {
    await db.runTransaction(async (tx) => {
      const newSnap = await tx.get(newRef);
      if (newSnap.exists) {
        throw new Error('USERNAME_TAKEN');
      }

      let authHandle = String(u.email || '').trim();
      // Preserve the original account creation date across renames.
      // (The "Date joined" UI reads from the usernames registry.)
      let createdAtValue = firebase.firestore.FieldValue.serverTimestamp();

      // If we have a canonical previous username doc, carry forward its authHandle/createdAt,
      // then delete it so resolveUsernameForUid doesn't "snap back" on refresh.
      if (oldRef) {
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists) {
          const d = oldSnap.data() || {};
          if (d.uid && String(d.uid) !== uid) {
            throw new Error('USERNAME_CONFLICT');
          }
          authHandle = String(d.authHandle || authHandle).trim();
          if (d.createdAt) createdAtValue = d.createdAt;
          tx.delete(oldRef);
        }
      }

      tx.set(newRef, {
        uid,
        authHandle,
        createdAt: createdAtValue,
        renamedFrom: canonicalPrevName || null,
        renamedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(usersCol.doc(uid), {
        username: nextName,
        name: nextName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      tx.set(playersCol.doc(uid), {
        name: nextName,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });

    // Update auth profile display name (used throughout the UI).
    try { await u.updateProfile({ displayName: nextName }); } catch (_) {}

    // Persist the last known username locally so boot/self-heal paths can resolve identity.
    try { safeLSSet(LS_LAST_USERNAME, nextName); } catch (_) {}

    // Best-effort: keep team rosters up to date (for older docs that store embedded names).
    try { updateNameInAllTeams(getUserId(), nextName).catch(() => {}); } catch (_) {}
    try { refreshNameUI(); } catch (_) {}

    // Admin log (best-effort)
    try {
      const from = canonicalPrevName ? canonicalPrevName : '(new)';
      logEvent('rename', `${from} → ${nextName}`, { from: canonicalPrevName || null, to: nextName });
    } catch (_) {}

    return { changed: true, name: nextName };
  } finally {
    hideAuthLoadingScreen();
  }
}

function initName(
) {
  // Username == name. We don't allow in-app renaming (it would desync login identity).

  // Header name pill - single click opens your profile
  const headerNamePill = document.getElementById('header-name-pill');
  headerNamePill?.addEventListener('click', () => {
    playSound('click');
    const uid = getUserId();
    if (!uid || !getUserName()) {
      try { showAuthScreen(); } catch (_) {}
      return;
    }
    showProfilePopup('player', uid, headerNamePill);
  });
  headerNamePill?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      playSound('click');
      const uid = getUserId();
      if (!uid || !getUserName()) {
        try { showAuthScreen(); } catch (_) {}
        return;
      }
      showProfilePopup('player', uid, headerNamePill);
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

  // Teammates modal + profile modal still used.
  initTeammatesModal();
}

function startProfileNameSync() {
  try { profileUnsub?.(); } catch (_) {}
  profileUnsub = null;

  const uid = getUserId();
  if (!uid) return;

  // Best-effort UI sync: if the players/<uid> profile gets updated (e.g. from
  // another device), refresh the UI. We do not write to localStorage.
  profileUnsub = db.collection('players').doc(uid).onSnapshot((snap) => {
    if (!snap?.exists) return;
    const remoteName = String(snap.data()?.name || '').trim();
    if (!remoteName) return;
    const localName = getUserName();
    if (remoteName !== localName) {
      const now = Date.now();
      if (now - lastLocalNameSetAtMs < 750) return;
      // If auth profile is stale, try to update it (best-effort).
      try { auth.currentUser?.updateProfile({ displayName: remoteName }); } catch (_) {}
      refreshNameUI();
    }
  }, (err) => console.warn('Profile sync error (best-effort)', err));
}

function refreshNameUI() {
  const name = getUserName();

  // Mobile header is extremely space constrained.
  const isTightMobile = window.matchMedia && window.matchMedia('(max-width: 520px)').matches;
  const compact4 = (s) => {
    const str = String(s || '').trim();
    if (!str) return '—';
    return str.length > 4 ? (str.slice(0, 4) + '…') : str;
  };

  const savedDisplay = document.getElementById('name-saved-display');
  const headerDisplay = document.getElementById('user-name-display');
  const signedAs = document.getElementById('launch-signed-as');

  if (savedDisplay) savedDisplay.textContent = name || '—';
  // Header name pill is compact on mobile.
  if (headerDisplay) headerDisplay.textContent = isTightMobile ? compact4(name) : (name || '—');
  const headerNamePill = document.getElementById('header-name-pill');
  if (headerNamePill) headerNamePill.title = name || '';
  // Launch screen: style the username distinctly for a cleaner, centered look.
  if (signedAs) signedAs.innerHTML = `Signed in as <span class="signed-as-name">${esc(name || '—')}</span>`;

  // Home screen name editor is disabled (username == name).
  const cardForm = document.getElementById('name-form');
  const saved = document.getElementById('name-saved');
  if (cardForm) cardForm.style.display = 'none';
  if (saved) saved.style.display = name ? 'block' : 'none';

  // Enable mode buttons only when signed in.
  const launchQuick = document.getElementById('launch-quick-play');
  const launchTourn = document.getElementById('launch-tournament');
  const canEnter = !!auth.currentUser && !!name;
  if (launchQuick) launchQuick.disabled = !canEnter;
  if (launchTourn) launchTourn.disabled = !canEnter;
  const launchBrackets = document.getElementById('launch-brackets');
  const launchPractice = document.getElementById('launch-practice');
  const launchAnimations = document.getElementById('launch-animations');
  const canUseAnimationLab = canEnter && !!isAdminUser();
  if (launchBrackets) launchBrackets.disabled = !canEnter;
  if (launchPractice) launchPractice.disabled = !canEnter;
  if (launchAnimations) {
    launchAnimations.disabled = !canUseAnimationLab;
    launchAnimations.style.display = isAdminUser() ? '' : 'none';
  }
  if (!isAdminUser()) setLaunchAnimationLabOpen(false);

  // Hide account-only header controls until signed in.
  // Re-query headerNamePill to avoid variable shadowing.
  const headerNamePill2 = document.getElementById('header-name-pill');
  const headerTeamPill = document.getElementById('header-team-pill');
  const settingsGear = document.getElementById('settings-gear-btn');
  if (headerNamePill2) headerNamePill2.style.display = canEnter ? '' : 'none';
  if (headerTeamPill) headerTeamPill.style.display = canEnter ? '' : 'none';
  if (settingsGear) settingsGear.style.display = '';

  // Update UI that depends on name (join buttons etc)
  renderTeams(teamsCache);
  try { renderBrackets(teamsCache); } catch (_) {}
  renderMyTeam(teamsCache);
  recomputeMyTeamTabBadge();
  refreshHeaderIdentity();
}

function refreshHeaderIdentity() {
  const st = computeUserState(teamsCache);
  // Only show team name if actually on a team (not pending) - pending requests don't count
  const teamDisplayEl = document.getElementById('user-team-display');
  if (teamDisplayEl) {
    const isTightMobile = window.matchMedia && window.matchMedia('(max-width: 520px)').matches;
    if (st.team) {
      const rawTeamName = String(st.team.teamName || 'My team');
      let shownTeamName = rawTeamName;
      if (isTightMobile) {
        shownTeamName = rawTeamName.length > 4 ? (rawTeamName.slice(0, 4) + '…') : rawTeamName;
      } else {
        shownTeamName = truncateTeamName(rawTeamName, 20);
      }
      teamDisplayEl.innerHTML = `<span class="profile-link" data-profile-type="team" data-profile-id="${esc(st.team.id)}" title="${esc(rawTeamName)}">${esc(shownTeamName)}</span>`;
    } else {
      // Keep the same tight header truncation rule even for the "No team" state.
      // (User requested the 4-char rule + "..." on mobile.)
      teamDisplayEl.textContent = isTightMobile ? ('No t' + '...') : 'No team';
    }
  }

  // Apply team theme (glow + accent) for the team you're ON.
  applyTeamThemeFromState(st);
}

/* =========================
   Real-time data
========================= */
function listenToTeams() {
  if (teamsUnsub) return;
  teamsUnsub = db.collection('teams')
    .orderBy('createdAt', 'asc')
    .onSnapshot((snapshot) => {
      teamsCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));

      // Admin-only hygiene: auto-archive teams that have become empty (no members, no pending).
      // This keeps the tournament / lobby views clean even if old/legacy data had orphan teams.
      try {
        if (isAdminUser()) {
          const now = Date.now();
          for (const t of (teamsCache || [])) {
            const tid = String(t?.id || '').trim();
            if (!tid) continue;
            if (t?.archived) continue;
            if (!teamIsEmpty(t)) continue;
            const last = emptyTeamCleanupAttempts.get(tid) || 0;
            if (now - last < 30_000) continue; // 30s throttle per team
            emptyTeamCleanupAttempts.set(tid, now);
            archiveTeamIfEmpty(tid);
          }
        }
      } catch (_) {}

      // Legacy migration: ensure the team you lead has a stable creatorUserId.
      // Some older teams were created with only creatorName, which breaks request management
      // if names change. We infer the creator from the roster and write it once.
      try {
        const st = computeUserState(teamsCache);
        if (st?.team && st.isCreator) {
          const t = st.team;
          const tid = String(t.id || '').trim();
          const creatorUserId = String(t.creatorUserId || '').trim();
          if (tid && !creatorUserId && !migratedCreatorIds.has(tid)) {
            migratedCreatorIds.add(tid);
            db.collection('teams').doc(tid).update({
              creatorUserId: st.userId,
              creatorName: (st.name || '').trim() || (t.creatorName || '').trim() || (getUserName() || '').trim()
            }).catch(() => {});
          }
        }
      } catch (_) {}

      refreshHeaderIdentity();
      refreshUnreadTeamListener();
      recomputeUnreadBadges();
      recomputeMyTeamTabBadge();
      updateHomeStats(teamsCache);
      renderTeams(teamsCache);
      renderBrackets(teamsCache);
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
  if (playersUnsub) return;
  playersUnsub = db.collection('players')
    .orderBy('name', 'asc')
    .onSnapshot((snapshot) => {
      playersCache = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
      // Duplicate player docs are no longer expected with Firebase Auth (uid keys).
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
  // Count "eligible" tournament teams (3+ members AND not over the recommended cap).
  // Teams can exceed the cap, but they become ineligible and should not consume a slot.
  const fullTeams = (teams || []).filter(t => {
    if (t?.archived) return false;
    if (teamIsEmpty(t)) return false;
    const n = getMembers(t).length;
    return n >= TEAM_MIN && n <= SOFT_TEAM_MAX;
  }).length;
  const players = (teams || []).reduce((sum, t) => {
    if (t?.archived) return sum;
    if (teamIsEmpty(t)) return sum;
    return sum + getMembers(t).length;
  }, 0);

  const teamCountStr = `${fullTeams} / ${SOFT_MAX_TEAMS}`;
  setText('players-count', players);
  setText('team-count', teamCountStr);
  setText('team-count-pill', teamCountStr);

  // Overboard indicators (soft limits only)
  const overTeams = fullTeams > SOFT_MAX_TEAMS;

  const teamCountEl = document.getElementById('team-count');
  teamCountEl?.classList.toggle('overboard', overTeams);

  const teamCountPill = document.getElementById('team-count-pill');
  teamCountPill?.classList.toggle('overboard', overTeams);

  // Home "spots" = remaining recommended full-team slots (or how far over we are)
  const spotsDisplay = document.querySelector('#panel-home .spots-display');
  const spotsLabel = document.querySelector('#panel-home .spots-label');

  if (!overTeams) {
    const spotsLeft = Math.max(0, SOFT_MAX_TEAMS - fullTeams);
    setText('spots-left', spotsLeft);
    if (spotsLabel) spotsLabel.textContent = 'team slots left';
    spotsDisplay?.classList.remove('overboard');
  } else {
    const overBy = fullTeams - SOFT_MAX_TEAMS;
    setText('spots-left', overBy);
    if (spotsLabel) spotsLabel.textContent = `teams over (recommended ${SOFT_MAX_TEAMS})`;
    spotsDisplay?.classList.add('overboard');
  }
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

function teamIsEmpty(team) {
  const members = getMembers(team);
  const pending = getPending(team);
  return members.length === 0 && pending.length === 0;
}

// Archive (soft-delete) teams that have no members and no pending requests.
// Also cleans up the team-name registry mapping when it points at the archived team.
// This is best-effort and safe to call repeatedly.
async function archiveTeamIfEmpty(teamId) {
  const tid = String(teamId || '').trim();
  if (!tid) return;

  const teamRef = db.collection('teams').doc(tid);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(teamRef);
      if (!snap.exists) return;
      const t = { id: snap.id, ...snap.data() };

      // Already archived or not empty -> nothing to do.
      if (t.archived) return;
      if (!teamIsEmpty(t)) return;

      const teamName = String(t.teamName || '').trim();
      const key = teamNameToKey(teamName);

      if (key) {
        const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
        const nameSnap = await tx.get(nameRef);
        const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
        if (mappedId === tid) tx.delete(nameRef);
      }

      tx.update(teamRef, {
        archived: true,
        archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    // Best-effort; rules may block this for non-admin/non-member contexts.
    // We still hide empty teams in the UI regardless.
    console.warn('archiveTeamIfEmpty failed', e);
  }
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

// Robust creator id resolution for legacy teams.
// - Prefer explicit creatorUserId
// - Fallback to matching creatorName against a member
// - Final fallback: first member in the roster
function getTeamCreatorAccountId(team) {
  const uid = String(team?.creatorUserId || '').trim();
  if (uid) return uid;

  const creatorKey = nameToAccountId((team?.creatorName || '').trim());
  if (creatorKey) {
    const m = getMembers(team).find(mm => nameToAccountId((mm?.name || '').trim()) === creatorKey);
    const inferred = m ? entryAccountId(m) : '';
    if (inferred) return inferred;
  }

  const members = getMembers(team);
  if (members.length) return entryAccountId(members[0]);
  return '';
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
  // A user can temporarily appear in multiple teams (e.g., when switching).
  // Prefer the most recently updated team so the UI consistently picks the
  // latest roster change.
  const memberTeams = [];
  const pendingTeams = [];
  for (const t of teams) {
    if (findUserInMembers(t, userId)) memberTeams.push(t);
    if (findUserInPending(t, userId)) pendingTeams.push(t);
  }

  let team = null;
  if (memberTeams.length === 1) team = memberTeams[0];
  else if (memberTeams.length > 1) {
    team = memberTeams.slice().sort((a, b) => {
      const am = tsToMs(a?.updatedAt) || tsToMs(a?.createdAt) || 0;
      const bm = tsToMs(b?.updatedAt) || tsToMs(b?.createdAt) || 0;
      return bm - am;
    })[0];
  }
  // Creator detection:
  // - Prefer explicit creatorUserId
  // - Otherwise infer from creatorName/member roster
  // - Otherwise fallback to first member
  const creatorId = team ? getTeamCreatorAccountId(team) : '';
  const isCreator = !!(team && creatorId && String(creatorId).trim() === String(userId || '').trim());
  const pendingTeamIds = pendingTeams.map(t => t?.id).filter(Boolean);
  return {
    userId,
    name: getUserName(),
    team,
    teamId: team?.id || null,
    isCreator,
    pendingTeams,
    pendingTeamIds,
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

  // Admin quick access (Players tab)
  try {
    const adminBar = document.getElementById('admin-assign-bar');
    if (adminBar) adminBar.style.display = isAdminUser() ? 'flex' : 'none';
    if (!isAdminUser()) setHint('admin-assign-bar-hint', '');
  } catch (_) {}

  const st = computeUserState(teams);
  const roster = buildRosterIndex(teams);
  const myTeam = st?.team;
  // Anyone on a team can send invites (not just the creator).
  const canManageInvites = !!(st.teamId && myTeam);

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
      const teamName = team ? truncateTeamName(team.teamName || 'Team') : '—';
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
        ? `<span class="player-tag profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}" ${teamPillStyle}>${esc(teamName)}</span>`
        : `<span class="player-tag ok">Available</span>`;

      let invitePillHtml = '';
      if (canManageInvites && uid !== st.userId) {
        if (isTeammate) {
          invitePillHtml = `<button class="player-tag pill-action invite" type="button" disabled title="Already on your team">Invite</button>`;
        } else {
          const mode = alreadyInvitedByMe ? 'cancel' : 'send';
          const disabled = inviteDisabledBase;
          const title = inviteDisabledBase ? 'Set your name on Home first.' : '';
          invitePillHtml = `
            <button class="player-tag pill-action ${alreadyInvitedByMe ? 'cancel' : 'invite'}" type="button" data-invite="${esc(uid)}" data-invite-mode="${mode}" ${disabled ? 'disabled' : ''} ${title ? `title="${esc(title)}"` : ''}>
              ${alreadyInvitedByMe ? 'Cancel invite' : 'Invite'}
            </button>
          `;
        }
      }

      const adminDeleteBtn = (isAdminUser() && uid)
        ? `<button class="player-tag pill-action danger" type="button" data-admin-delete-player="${esc(uid)}">Delete</button>`
        : '';

      return `
        <div class="player-row player-directory-row">
          <div class="player-left">
            <span class="player-name profile-link" data-profile-type="player" data-profile-id="${esc(uid)}" ${nameStyle}>${esc(name)}</span>
          </div>
          <div class="player-right">
            ${statusPillHtml}
            ${invitePillHtml}
            ${adminDeleteBtn}
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

  container.querySelectorAll('[data-admin-delete-player]')?.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const uid = btn.getAttribute('data-admin-delete-player');
      if (!uid) return;
      await adminDeletePlayer(uid);
    });
  });

  // Helpful hint for teammates
  if (st.teamId) {
    if (!st.name) setHint('players-hint', 'Set your name on Home first.');
    else setHint('players-hint', 'Tap Invite to send a team invite.');
  }

  // If the admin modal is open, keep it in sync with the latest snapshots.
  try { if (adminAssignModalOpen) renderAdminAssignModal(); } catch (_) {}
}
function renderInvites(players, teams) {
  const card = document.getElementById('invites-card');
  const list = document.getElementById('invites-list');
  if (!card || !list) return;

  // Invites are now shown via the Invites modal (opened from the My Team tab).
  // Keep the legacy inline card hidden so there isn't duplicate UI.
  card.style.display = 'none';
  list.innerHTML = '';
  setHint('invites-hint', '');
  return;
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
    try {
      const teamName = String(st?.team?.teamName || '').trim();
      const targetName = findKnownUserName(targetUserId) || fallbackName || '—';
      logEvent('invite_sent', `${normalizeUsername(getUserName()) || st.name || 'user'} invited ${normalizeUsername(targetName)}${teamName ? (' to ' + teamName) : ''}`, {
        teamId: String(teamId || '').trim(),
        teamName,
        targetUserId: String(targetUserId || '').trim(),
        targetName: normalizeUsername(targetName)
      });
    } catch (_) {}
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
    try {
      const teamName = String(st?.team?.teamName || '').trim();
      const targetName = findKnownUserName(targetUserId) || '—';
      logEvent('invite_cancel', `${normalizeUsername(getUserName()) || st.name || 'user'} canceled invite for ${normalizeUsername(targetName)}${teamName ? (' to ' + teamName) : ''}`, {
        teamId: String(st.teamId || '').trim(),
        teamName,
        targetUserId: String(targetUserId || '').trim(),
        targetName: normalizeUsername(targetName)
      });
    } catch (_) {}
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
  const teamRef = db.collection('teams').doc(String(teamId || '').trim());
  setHint('invites-hint', 'Joining…');

  try {
    await db.runTransaction(async (tx) => {
      const [playerSnap, teamSnap] = await Promise.all([tx.get(playerRef), tx.get(teamRef)]);
      if (!playerSnap.exists) throw new Error('Player not found.');
      if (!teamSnap.exists) throw new Error('Team not found.');

      const team = { id: teamSnap.id, ...teamSnap.data() };
      const members = getMembers(team);
      const pending = getPending(team);

      // Add to team (idempotent)
      const nextMembers = dedupeRosterByAccount(members.concat([{ userId: st.userId, name: st.name }]));
      const nextPending = pending.filter(r => !isSameAccount(r, st.userId));
      tx.update(teamRef, {
        members: nextMembers,
        pending: nextPending,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });

      // Remove the invite from the player's doc.
      const player = { id: playerSnap.id, ...playerSnap.data() };
      const invites = Array.isArray(player.invites) ? player.invites : [];
      const nextInvites = invites.filter(i => String(i?.teamId || '').trim() !== String(teamId || '').trim());
      tx.update(playerRef, {
        invites: nextInvites,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    setHint('invites-hint', 'Joined!');
    try {
      const t = (teamsCache || []).find(x => String(x?.id || '').trim() === String(teamId || '').trim());
      const teamName = String(t?.teamName || '').trim();
      logEvent('invite_accept', `${normalizeUsername(getUserName()) || st.name || 'user'} joined${teamName ? (' ' + teamName) : ' a team'}`, { teamId: String(teamId || '').trim(), teamName });
    } catch (_) {}
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
    try {
      const t = (teamsCache || []).find(x => String(x?.id || '').trim() === String(teamId || '').trim());
      const teamName = String(t?.teamName || '').trim();
      logEvent('invite_decline', `${normalizeUsername(getUserName()) || st.name || 'user'} declined invite${teamName ? (' from ' + teamName) : ''}`, { teamId: String(teamId || '').trim(), teamName });
    } catch (_) {}
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
  const adminCreateBtn = document.getElementById('teams-admin-create-team');
  if (adminCreateBtn) {
    const show = !!isAdminUser();
    const disableCreate = !st.name || !!st.teamId;
    adminCreateBtn.style.display = show ? 'inline-flex' : 'none';
    adminCreateBtn.disabled = !show || disableCreate;
    adminCreateBtn.classList.toggle('disabled', !show || disableCreate);
  }
  const visibleTeams = (teams || []).filter(t => !t?.archived && !teamIsEmpty(t));

  if (visibleTeams.length === 0) {
    container.innerHTML = '<div class="empty-state">No teams yet</div>';
    return;
  }

  // Sort teams by member count (most players first)
  const sortedTeams = [...visibleTeams].sort((a, b) => getMembers(b).length - getMembers(a).length);

  // Sharp, simple list: team name + member names. Click for details / request.
  container.innerHTML = sortedTeams.map((t) => {
    const members = getMembers(t);
    const memberNamesHtml = members.length
      ? members.map(m => {
          const memberId = entryAccountId(m);
          const memberName = (m?.name || '—').trim();
          return memberId ? createProfileLink('player', memberId, memberName, null) : esc(memberName);
        }).join(', ')
      : 'No members yet';

    const isMine = st.teamId === t.id;
    const isReady = members.length >= TEAM_MIN && members.length <= SOFT_TEAM_MAX;
    const isOver = members.length > SOFT_TEAM_MAX;
    const isFull = members.length >= TEAM_MIN; // 3+ members = "full" team

    const tc = getDisplayTeamColor(t);
    const nameStyle = tc ? `style="color:${esc(tc)}"` : '';
    const itemStyle = isFull && tc ? `style="--team-accent:${esc(tc)}"` : '';
    const pillClass = isOver ? 'pill-overboard' : (isReady ? 'pill-full' : 'pill-incomplete');
    const overSize = isOver;

    return `
      <button class="team-list-item ${isMine ? 'is-mine' : ''} ${isFull ? 'is-full' : ''}" type="button" data-team="${esc(t.id)}" ${itemStyle}>
        <div class="team-list-left">
          <div class="team-list-name ${isMine ? 'team-accent' : ''}">
            <span class="team-list-name-text profile-link" data-profile-type="team" data-profile-id="${esc(t.id)}" ${nameStyle}>${esc(truncateTeamName(t.teamName || 'Unnamed'))}</span>
          </div>
          <div class="team-list-members" ${nameStyle}>${memberNamesHtml}</div>
        </div>
        <div class="team-list-right">
          <div class="team-list-count ${pillClass}">${members.length}/${SOFT_TEAM_MAX}</div>
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
   Brackets page
========================= */
let bracketRandomizeInFlight = false;
let bracketAdminModalOpen = false;
let bracketAdminSaveInFlight = false;
let bracketAdminDraft = null;

const BRACKET_MATCH_IDS = ['QF1', 'QF2', 'QF3', 'QF4', 'SF1', 'SF2', 'F'];
const BRACKET_MATCH_ID_SET = new Set(BRACKET_MATCH_IDS);

function normalizeBracketMatchId(raw) {
  const id = String(raw || '').trim().toUpperCase();
  return BRACKET_MATCH_ID_SET.has(id) ? id : '';
}

function sortBracketTeamsBySeed(teams) {
  return [...(teams || [])].sort((a, b) => {
    const da = getMembers(a).length;
    const db = getMembers(b).length;
    if (db !== da) return db - da;
    return String(a?.teamName || '').localeCompare(String(b?.teamName || ''));
  });
}

function getBracketTeamPool(teams, opts = {}) {
  const slotOrderByTeamId = opts?.slotOrderByTeamId instanceof Map ? opts.slotOrderByTeamId : null;
  const visible = (teams || []).filter(t => !t?.archived && !teamIsEmpty(t));
  const seeded = sortBracketTeamsBySeed(visible);
  const seedById = new Map();
  seeded.forEach((team, idx) => {
    const id = String(team?.id || '').trim();
    if (id) seedById.set(id, idx + 1);
  });

  const getTeamOrder = (team) => {
    const tid = String(team?.id || '').trim();
    if (slotOrderByTeamId && tid && slotOrderByTeamId.has(tid)) {
      return Number(slotOrderByTeamId.get(tid));
    }
    return Number(team?.bracketSlotOrder);
  };

  const hasCustomOrder = visible.some((team) => Number.isFinite(getTeamOrder(team)));
  const sorted = hasCustomOrder
    ? [...visible].sort((a, b) => {
      const ao = getTeamOrder(a);
      const bo = getTeamOrder(b);
      const aHas = Number.isFinite(ao);
      const bHas = Number.isFinite(bo);
      if (aHas && bHas && ao !== bo) return ao - bo;
      if (aHas !== bHas) return aHas ? -1 : 1;

      const aSeed = seedById.get(String(a?.id || '').trim()) || Number.MAX_SAFE_INTEGER;
      const bSeed = seedById.get(String(b?.id || '').trim()) || Number.MAX_SAFE_INTEGER;
      if (aSeed !== bSeed) return aSeed - bSeed;
      return String(a?.teamName || '').localeCompare(String(b?.teamName || ''));
    })
    : seeded;

  return { visible, sorted, seeded, seedById, hasCustomOrder };
}

function buildBracketSlot(team, seed, st) {
  if (!team) {
    return { kind: 'tbd', seed, name: 'TBD', members: 0, id: '', color: '', isMine: false };
  }
  return {
    kind: 'team',
    seed,
    name: truncateTeamName(team.teamName || 'Unnamed', 24),
    fullName: String(team.teamName || 'Unnamed'),
    members: getMembers(team).length,
    id: String(team.id || ''),
    color: getDisplayTeamColor(team) || '',
    isMine: !!(st && st.teamId === team.id),
  };
}

function buildPlaceholderSlot(name, source) {
  return {
    kind: 'placeholder',
    seed: '',
    name: String(name || 'TBD'),
    source: String(source || ''),
    members: 0,
    id: '',
    color: '',
    isMine: false,
  };
}

function getBracketWinnerSelections(teams, overrideWinnerByMatchId = null) {
  const visible = (teams || []).filter(t => !t?.archived && !teamIsEmpty(t));
  const visibleIds = new Set(
    visible
      .map(t => String(t?.id || '').trim())
      .filter(Boolean)
  );

  if (overrideWinnerByMatchId && typeof overrideWinnerByMatchId === 'object') {
    const out = {};
    BRACKET_MATCH_IDS.forEach((matchId) => {
      const teamId = String(overrideWinnerByMatchId[matchId] || '').trim();
      out[matchId] = (teamId && visibleIds.has(teamId)) ? teamId : '';
    });
    return out;
  }

  const claims = {};
  const conflicts = new Set();
  visible.forEach((team) => {
    const tid = String(team?.id || '').trim();
    if (!tid) return;
    const wins = Array.isArray(team?.bracketWins) ? team.bracketWins : [];
    wins.forEach((raw) => {
      const matchId = normalizeBracketMatchId(raw);
      if (!matchId) return;
      if (!claims[matchId]) claims[matchId] = tid;
      else if (claims[matchId] !== tid) conflicts.add(matchId);
    });
  });
  conflicts.forEach((matchId) => { claims[matchId] = ''; });
  BRACKET_MATCH_IDS.forEach((matchId) => {
    if (!claims[matchId] || !visibleIds.has(claims[matchId])) claims[matchId] = '';
  });
  return claims;
}

function clampBracketSeriesWins(value) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 2) return 2;
  return n;
}

function sanitizeBracketBestOf3Pair(aWins, bWins, preferredWinner = '') {
  let a = clampBracketSeriesWins(aWins);
  let b = clampBracketSeriesWins(bWins);

  if (a === 2 && b === 2) {
    if (preferredWinner === 'b') a = 1;
    else b = 1;
  }

  if (a + b > 3) {
    if (preferredWinner === 'b') a = Math.max(0, 3 - b);
    else b = Math.max(0, 3 - a);
  }

  if (a === 2 && b > 1) b = 1;
  if (b === 2 && a > 1) a = 1;
  return [a, b];
}

function emptyBracketScoreMap() {
  return BRACKET_MATCH_IDS.reduce((acc, matchId) => {
    acc[matchId] = {};
    return acc;
  }, {});
}

function cloneBracketScoreMap(scoreByMatchId) {
  const out = emptyBracketScoreMap();
  BRACKET_MATCH_IDS.forEach((matchId) => {
    const raw = (scoreByMatchId && typeof scoreByMatchId === 'object')
      ? scoreByMatchId[matchId]
      : null;
    const row = (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    const next = {};
    Object.entries(row).forEach(([rawTeamId, rawWins]) => {
      const teamId = String(rawTeamId || '').trim();
      const wins = clampBracketSeriesWins(rawWins);
      if (!teamId || wins <= 0) return;
      next[teamId] = wins;
    });
    out[matchId] = next;
  });
  return out;
}

function getBracketSeriesScores(teams, overrideScoreByMatchId = null) {
  const visible = (teams || []).filter(t => !t?.archived && !teamIsEmpty(t));
  const visibleIds = new Set(
    visible
      .map(t => String(t?.id || '').trim())
      .filter(Boolean)
  );
  const out = emptyBracketScoreMap();
  const assignScore = (rawMatchId, rawTeamId, rawWins) => {
    const matchId = normalizeBracketMatchId(rawMatchId);
    const teamId = String(rawTeamId || '').trim();
    const wins = clampBracketSeriesWins(rawWins);
    if (!matchId || !teamId || wins <= 0) return;
    if (!visibleIds.has(teamId)) return;
    out[matchId][teamId] = wins;
  };

  if (overrideScoreByMatchId && typeof overrideScoreByMatchId === 'object') {
    BRACKET_MATCH_IDS.forEach((matchId) => {
      const row = overrideScoreByMatchId[matchId];
      if (!row || typeof row !== 'object' || Array.isArray(row)) return;
      Object.entries(row).forEach(([rawTeamId, rawWins]) => {
        assignScore(matchId, rawTeamId, rawWins);
      });
    });
    return out;
  }

  visible.forEach((team) => {
    const teamId = String(team?.id || '').trim();
    if (!teamId) return;
    const rawSeries = (team && typeof team.bracketSeriesWins === 'object' && !Array.isArray(team.bracketSeriesWins))
      ? team.bracketSeriesWins
      : null;
    if (!rawSeries) return;
    Object.entries(rawSeries).forEach(([rawMatchId, rawWins]) => {
      assignScore(rawMatchId, teamId, rawWins);
    });
  });

  const fallbackWinners = getBracketWinnerSelections(teams);
  BRACKET_MATCH_IDS.forEach((matchId) => {
    if (Object.keys(out[matchId] || {}).length > 0) return;
    const teamId = String(fallbackWinners?.[matchId] || '').trim();
    if (!teamId || !visibleIds.has(teamId)) return;
    out[matchId] = { [teamId]: 2 };
  });

  return out;
}

function cloneBracketSlot(slot) {
  return slot ? { ...slot } : null;
}

function resolveBracketMatchOutcome(match, scoreSelections, winnerSelections) {
  const matchId = normalizeBracketMatchId(match?.id);
  const slots = Array.isArray(match?.slots) ? match.slots : [];
  const a = slots?.[0] || null;
  const b = slots?.[1] || null;
  const aId = (a && a.kind === 'team' && a.id) ? String(a.id || '').trim() : '';
  const bId = (b && b.kind === 'team' && b.id) ? String(b.id || '').trim() : '';
  const row = (matchId && scoreSelections && typeof scoreSelections === 'object' && scoreSelections[matchId]
    && typeof scoreSelections[matchId] === 'object' && !Array.isArray(scoreSelections[matchId]))
    ? scoreSelections[matchId]
    : {};

  let aWins = aId ? clampBracketSeriesWins(row[aId]) : 0;
  let bWins = bId ? clampBracketSeriesWins(row[bId]) : 0;
  [aWins, bWins] = sanitizeBracketBestOf3Pair(aWins, bWins);

  let winnerTeamId = '';
  if (aId && aWins === 2 && aWins > bWins) winnerTeamId = aId;
  else if (bId && bWins === 2 && bWins > aWins) winnerTeamId = bId;

  if (!winnerTeamId && matchId) {
    const fallbackTeamId = String(winnerSelections?.[matchId] || '').trim();
    if (fallbackTeamId && (fallbackTeamId === aId || fallbackTeamId === bId)) {
      winnerTeamId = fallbackTeamId;
      if (winnerTeamId === aId) {
        aWins = 2;
        if (bWins > 1) bWins = 1;
      } else if (winnerTeamId === bId) {
        bWins = 2;
        if (aWins > 1) aWins = 1;
      }
    }
  }

  const winnerSlot = winnerTeamId
    ? slots.find((slot) => slot && slot.kind === 'team' && String(slot.id || '').trim() === winnerTeamId)
    : null;

  const scoreByTeamId = {};
  if (aId && aWins > 0) scoreByTeamId[aId] = aWins;
  if (bId && bWins > 0) scoreByTeamId[bId] = bWins;

  return {
    winnerSlot: winnerSlot ? cloneBracketSlot(winnerSlot) : null,
    winnerTeamId,
    series: { aWins, bWins },
    scoreByTeamId,
  };
}

function buildBracketModel(teams, opts = {}) {
  const safeTeams = Array.isArray(teams) ? teams : [];
  const st = computeUserState(safeTeams);
  const pool = getBracketTeamPool(safeTeams, { slotOrderByTeamId: opts?.slotOrderByTeamId || null });
  const hasScoreOverride = !!(opts && Object.prototype.hasOwnProperty.call(opts, 'scoreByMatchId'));
  const winnerOverride = (opts && Object.prototype.hasOwnProperty.call(opts, 'winnerByMatchId'))
    ? opts.winnerByMatchId
    : (hasScoreOverride ? {} : null);
  const scoreSelections = getBracketSeriesScores(safeTeams, opts?.scoreByMatchId || null);
  const winnerSelections = getBracketWinnerSelections(safeTeams, winnerOverride);
  const slottedTeams = Array.from({ length: 8 }, (_, i) => pool.sorted[i] || null);
  const seededSlots = slottedTeams.map((t, idx) => {
    const tid = String(t?.id || '').trim();
    const seed = tid ? (pool.seedById.get(tid) || (idx + 1)) : (idx + 1);
    return buildBracketSlot(t, seed, st);
  });

  const match = (id, label, round, a, b) => ({
    id,
    label,
    round,
    bestOf: 3,
    slots: [a, b],
    winnerTeamId: '',
    series: { aWins: 0, bWins: 0 },
    scoreByTeamId: {},
  });

  const qf1 = match('QF1', 'Quarterfinal 1', 'Quarterfinals', seededSlots[0], seededSlots[7]);
  const qf2 = match('QF2', 'Quarterfinal 2', 'Quarterfinals', seededSlots[3], seededSlots[4]);
  const qf3 = match('QF3', 'Quarterfinal 3', 'Quarterfinals', seededSlots[1], seededSlots[6]);
  const qf4 = match('QF4', 'Quarterfinal 4', 'Quarterfinals', seededSlots[2], seededSlots[5]);

  const qf1Outcome = resolveBracketMatchOutcome(qf1, scoreSelections, winnerSelections);
  const qf2Outcome = resolveBracketMatchOutcome(qf2, scoreSelections, winnerSelections);
  const qf3Outcome = resolveBracketMatchOutcome(qf3, scoreSelections, winnerSelections);
  const qf4Outcome = resolveBracketMatchOutcome(qf4, scoreSelections, winnerSelections);
  qf1.winnerTeamId = String(qf1Outcome?.winnerTeamId || '');
  qf2.winnerTeamId = String(qf2Outcome?.winnerTeamId || '');
  qf3.winnerTeamId = String(qf3Outcome?.winnerTeamId || '');
  qf4.winnerTeamId = String(qf4Outcome?.winnerTeamId || '');
  qf1.series = qf1Outcome?.series || { aWins: 0, bWins: 0 };
  qf2.series = qf2Outcome?.series || { aWins: 0, bWins: 0 };
  qf3.series = qf3Outcome?.series || { aWins: 0, bWins: 0 };
  qf4.series = qf4Outcome?.series || { aWins: 0, bWins: 0 };
  qf1.scoreByTeamId = qf1Outcome?.scoreByTeamId || {};
  qf2.scoreByTeamId = qf2Outcome?.scoreByTeamId || {};
  qf3.scoreByTeamId = qf3Outcome?.scoreByTeamId || {};
  qf4.scoreByTeamId = qf4Outcome?.scoreByTeamId || {};

  const qf1Winner = qf1Outcome?.winnerSlot || null;
  const qf2Winner = qf2Outcome?.winnerSlot || null;
  const qf3Winner = qf3Outcome?.winnerSlot || null;
  const qf4Winner = qf4Outcome?.winnerSlot || null;

  const sf1 = match(
    'SF1',
    'Semifinal 1',
    'Semifinals',
    qf1Winner || buildPlaceholderSlot('Winner QF1', 'QF1'),
    qf2Winner || buildPlaceholderSlot('Winner QF2', 'QF2')
  );
  const sf2 = match(
    'SF2',
    'Semifinal 2',
    'Semifinals',
    qf3Winner || buildPlaceholderSlot('Winner QF3', 'QF3'),
    qf4Winner || buildPlaceholderSlot('Winner QF4', 'QF4')
  );

  const sf1Outcome = resolveBracketMatchOutcome(sf1, scoreSelections, winnerSelections);
  const sf2Outcome = resolveBracketMatchOutcome(sf2, scoreSelections, winnerSelections);
  sf1.winnerTeamId = String(sf1Outcome?.winnerTeamId || '');
  sf2.winnerTeamId = String(sf2Outcome?.winnerTeamId || '');
  sf1.series = sf1Outcome?.series || { aWins: 0, bWins: 0 };
  sf2.series = sf2Outcome?.series || { aWins: 0, bWins: 0 };
  sf1.scoreByTeamId = sf1Outcome?.scoreByTeamId || {};
  sf2.scoreByTeamId = sf2Outcome?.scoreByTeamId || {};

  const sf1Winner = sf1Outcome?.winnerSlot || null;
  const sf2Winner = sf2Outcome?.winnerSlot || null;

  const final = match(
    'F',
    'Grand Final',
    'Final',
    sf1Winner || buildPlaceholderSlot('Winner SF1', 'SF1'),
    sf2Winner || buildPlaceholderSlot('Winner SF2', 'SF2')
  );
  const finalOutcome = resolveBracketMatchOutcome(final, scoreSelections, winnerSelections);
  final.winnerTeamId = String(finalOutcome?.winnerTeamId || '');
  final.series = finalOutcome?.series || { aWins: 0, bWins: 0 };
  final.scoreByTeamId = finalOutcome?.scoreByTeamId || {};
  const finalWinner = finalOutcome?.winnerSlot || null;

  const matches = [qf1, qf2, qf3, qf4, sf1, sf2, final];
  const matchById = Object.fromEntries(matches.map((m) => [String(m.id || ''), m]));
  const resolvedWinnerSelections = BRACKET_MATCH_IDS.reduce((acc, matchId) => {
    acc[matchId] = String(matchById?.[matchId]?.winnerTeamId || '').trim();
    return acc;
  }, {});
  const resolvedScoreSelections = BRACKET_MATCH_IDS.reduce((acc, matchId) => {
    acc[matchId] = { ...(matchById?.[matchId]?.scoreByTeamId || {}) };
    return acc;
  }, {});
  const slotTeamIds = slottedTeams.map((team) => String(team?.id || '').trim());
  const teamOptions = pool.seeded
    .map((team) => {
      const tid = String(team?.id || '').trim();
      if (!tid) return null;
      return {
        id: tid,
        name: String(team?.teamName || 'Unnamed').trim() || 'Unnamed',
        seed: pool.seedById.get(tid) || null,
      };
    })
    .filter(Boolean);

  return {
    state: st,
    visibleCount: pool.visible.length,
    seededCount: Math.min(8, pool.visible.length),
    hasCustomOrder: !!pool.hasCustomOrder,
    winnerSelections: resolvedWinnerSelections,
    scoreSelections: resolvedScoreSelections,
    matches,
    matchById,
    slotTeamIds,
    teamOptions,
    champion: finalWinner ? cloneBracketSlot(finalWinner) : null,
    rounds: {
      quarterfinals: [qf1, qf2, qf3, qf4],
      semifinals: [sf1, sf2],
      final,
    },
  };
}

function setBracketRandomizeButtonState(model = null) {
  const btn = document.getElementById('brackets-randomize-btn');
  if (!btn) return;

  const admin = !!isAdminUser();
  btn.style.display = admin ? '' : 'none';
  if (!admin) return;

  const visibleCount = Number(model?.visibleCount || 0);
  const canRandomize = !bracketRandomizeInFlight && visibleCount > 1;
  btn.disabled = !canRandomize;
  btn.classList.toggle('disabled', !canRandomize);
  btn.textContent = bracketRandomizeInFlight ? 'Randomizing...' : 'Randomize';
  if (bracketRandomizeInFlight) {
    btn.title = 'Randomizing bracket...';
  } else if (visibleCount <= 1) {
    btn.title = 'Need at least 2 teams to randomize.';
  } else {
    btn.title = 'Randomize who plays who in the bracket.';
  }
}

function setBracketAdminEditButtonState(model = null) {
  const btn = document.getElementById('brackets-admin-edit-btn');
  if (!btn) return;

  const admin = !!isAdminUser();
  btn.style.display = admin ? '' : 'none';
  if (!admin) {
    if (bracketAdminModalOpen) closeBracketAdminModal();
    return;
  }

  const visibleCount = Number(model?.visibleCount || 0);
  const canEdit = !bracketAdminSaveInFlight && visibleCount > 0;
  btn.disabled = !canEdit;
  btn.classList.toggle('disabled', !canEdit);
  btn.textContent = bracketAdminSaveInFlight ? 'Saving...' : 'Edit Bracket';
  if (bracketAdminSaveInFlight) btn.title = 'Saving bracket changes...';
  else if (visibleCount <= 0) btn.title = 'Need at least 1 team to edit bracket slots.';
  else btn.title = 'Manually set bracket slots and BO3 results.';
}

function shuffleTeams(list) {
  const arr = Array.isArray(list) ? [...list] : [];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function randomizeBracketMatchups() {
  if (!isAdminUser()) {
    showToast('Admin only.');
    return;
  }
  if (bracketRandomizeInFlight) return;

  const visible = (teamsCache || [])
    .filter(t => !t?.archived && !teamIsEmpty(t))
    .filter(t => String(t?.id || '').trim());
  if (visible.length < 2) {
    showToast('Need at least 2 teams.');
    return;
  }

  bracketRandomizeInFlight = true;
  setBracketRandomizeButtonState({ visibleCount: visible.length });
  try {
    const shuffled = shuffleTeams(visible);
    let batch = db.batch();
    let writes = 0;
    for (let idx = 0; idx < shuffled.length; idx++) {
      const team = shuffled[idx];
      const tid = String(team?.id || '').trim();
      if (!tid) continue;
      batch.update(db.collection('teams').doc(tid), {
        bracketSlotOrder: idx + 1,
        bracketSlotUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
      writes++;
      if (writes >= 400) {
        await batch.commit();
        batch = db.batch();
        writes = 0;
      }
    }
    if (writes > 0) await batch.commit();

    try {
      logEvent('bracket_randomize', `Admin randomized bracket matchups (${shuffled.length} teams).`, {
        teamCount: shuffled.length,
      });
    } catch (_) {}
    showToast('Bracket randomized.');
  } catch (err) {
    console.error('Bracket randomize failed:', err);
    showToast(err?.message || 'Could not randomize bracket.');
  } finally {
    bracketRandomizeInFlight = false;
    try { renderBrackets(teamsCache); } catch (_) {}
  }
}

function bracketSlotLabel(slot) {
  if (!slot) return 'TBD';
  if (slot.kind === 'team') return `${slot.seed}. ${slot.name}`;
  if (slot.kind === 'placeholder') return slot.name;
  return 'TBD';
}

function renderBracketSlot(slot, opts = {}) {
  const safe = slot || { kind: 'tbd', seed: '', name: 'TBD', members: 0, id: '', color: '', isMine: false };
  const cls = ['brx-slot', `is-${safe.kind}`];
  if (safe.isMine) cls.push('is-mine');
  if (safe.kind === 'team' && opts?.isWinner) cls.push('is-winner');

  const attrs = [];
  if (safe.kind === 'team' && safe.id) {
    attrs.push(`data-team-id="${esc(safe.id)}"`);
    attrs.push('role="button" tabindex="0"');
    attrs.push(`aria-label="Open team ${esc(safe.fullName || safe.name || 'details')}"`);
  }
  if (safe.kind === 'team' && safe.fullName) attrs.push(`title="${esc(safe.fullName)}"`);
  if (safe.kind === 'placeholder' && safe.source) attrs.push(`data-source="${esc(safe.source)}"`);
  if (safe.color) attrs.push(`style="--team-accent:${esc(safe.color)}"`);

  const seed = safe.seed ? `<span class="brx-slot-seed">#${esc(String(safe.seed))}</span>` : '<span class="brx-slot-seed">—</span>';
  const hasRoundWins = Number.isFinite(Number(opts?.roundWins));
  const roundWins = hasRoundWins ? clampBracketSeriesWins(opts.roundWins) : null;
  const meta = safe.kind === 'team'
    ? `<span class="brx-slot-meta">${esc(roundWins == null ? String(safe.members) + 'p' : String(roundWins))}</span>`
    : '<span class="brx-slot-meta">—</span>';
  const mine = safe.isMine ? '<span class="brx-slot-you">Your team</span>' : '';

  return `
    <div class="${cls.join(' ')}" ${attrs.join(' ')}>
      ${seed}
      <span class="brx-slot-name">${esc(safe.name || 'TBD')}</span>
      ${meta}
      ${mine}
    </div>
  `;
}

function renderBracketMatchCard(m, opts = {}) {
  const match = m || { id: '', label: 'Match', round: '', bestOf: 3, slots: [null, null] };
  const a = match.slots?.[0] || null;
  const b = match.slots?.[1] || null;
  const aId = (a && a.kind === 'team' && a.id) ? String(a.id) : '';
  const bId = (b && b.kind === 'team' && b.id) ? String(b.id) : '';
  const aName = (a && a.kind === 'team')
    ? String(a.fullName || a.name || 'TBD')
    : String(a?.name || 'TBD');
  const bName = (b && b.kind === 'team')
    ? String(b.fullName || b.name || 'TBD')
    : String(b?.name || 'TBD');
  const aSeed = (a && a.kind === 'team' && Number.isFinite(Number(a.seed))) ? String(a.seed) : '';
  const bSeed = (b && b.kind === 'team' && Number.isFinite(Number(b.seed))) ? String(b.seed) : '';
  const aRoundWins = clampBracketSeriesWins(match?.series?.aWins || 0);
  const bRoundWins = clampBracketSeriesWins(match?.series?.bWins || 0);
  const attrs = [
    `data-brx-match-id="${esc(match.id || '')}"`,
    `data-brx-round="${esc(match.round || '')}"`,
    `data-brx-bestof="${esc(String(match.bestOf || 3))}"`,
    `data-brx-a="${esc(bracketSlotLabel(a))}"`,
    `data-brx-b="${esc(bracketSlotLabel(b))}"`,
    `data-brx-a-id="${esc(aId)}"`,
    `data-brx-b-id="${esc(bId)}"`,
    `data-brx-a-name="${esc(aName)}"`,
    `data-brx-b-name="${esc(bName)}"`,
    `data-brx-a-seed="${esc(aSeed)}"`,
    `data-brx-b-seed="${esc(bSeed)}"`,
    `data-brx-a-wins="${esc(String(aRoundWins))}"`,
    `data-brx-b-wins="${esc(String(bRoundWins))}"`,
    `data-brx-winner-id="${esc(String(match.winnerTeamId || ''))}"`,
  ];

  return `
    <article class="brx-match ${opts.isFinal ? 'is-final' : ''}" ${attrs.join(' ')} role="button" tabindex="0" aria-label="Open ${esc(match.label || 'match')} details">
      <header class="brx-match-head">
        <span class="brx-match-title">${esc(match.label || 'Match')}</span>
        <span class="brx-match-badge">BO${esc(String(match.bestOf || 3))}</span>
      </header>
      <div class="brx-match-slots">
        ${renderBracketSlot(a, {
          isWinner: !!(match.winnerTeamId && aId && match.winnerTeamId === aId),
          roundWins: aRoundWins,
        })}
        ${renderBracketSlot(b, {
          isWinner: !!(match.winnerTeamId && bId && match.winnerTeamId === bId),
          roundWins: bRoundWins,
        })}
      </div>
    </article>
  `;
}

function renderBrackets(teams) {
  const board = document.getElementById('brackets-board');
  const pill = document.getElementById('brackets-count-pill');
  if (!board) return;

  const model = buildBracketModel(teams);
  if (pill) pill.textContent = String(model.visibleCount);
  setBracketRandomizeButtonState(model);
  setBracketAdminEditButtonState(model);

  board.innerHTML = `
    <div class="brx-shell" aria-label="Tournament bracket">
      <div class="brx-grid">
        <section class="brx-round brx-round-qf" aria-label="Quarterfinals">
          <div class="brx-match-stack">
            ${model.rounds.quarterfinals.map(m => renderBracketMatchCard(m)).join('')}
          </div>
        </section>

        <section class="brx-round brx-round-sf" aria-label="Semifinals">
          <div class="brx-match-stack is-spread">
            ${model.rounds.semifinals.map(m => renderBracketMatchCard(m)).join('')}
          </div>
        </section>

        <section class="brx-round brx-round-f" aria-label="Final">
          <div class="brx-match-stack is-final">
            ${renderBracketMatchCard(model.rounds.final, { isFinal: true })}
          </div>
        </section>
      </div>
    </div>
  `;

  board.querySelectorAll('.brx-slot.is-team[data-team-id]')?.forEach(el => {
    const open = () => {
      const teamId = String(el.getAttribute('data-team-id') || '').trim();
      if (teamId) openTeamModal(teamId);
    };
    el.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      open();
    });
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        open();
      }
    });
  });

  board.querySelectorAll('.brx-match[data-brx-match-id]')?.forEach(el => {
    const open = () => {
      showBracketMatchPopup({
        matchId: el.getAttribute('data-brx-match-id') || '',
        round: el.getAttribute('data-brx-round') || '',
        bestOf: el.getAttribute('data-brx-bestof') || '3',
        aName: el.getAttribute('data-brx-a-name') || el.getAttribute('data-brx-a') || 'TBD',
        bName: el.getAttribute('data-brx-b-name') || el.getAttribute('data-brx-b') || 'TBD',
        aTeamId: el.getAttribute('data-brx-a-id') || '',
        bTeamId: el.getAttribute('data-brx-b-id') || '',
        aSeed: el.getAttribute('data-brx-a-seed') || '',
        bSeed: el.getAttribute('data-brx-b-seed') || '',
        aWins: el.getAttribute('data-brx-a-wins') || '0',
        bWins: el.getAttribute('data-brx-b-wins') || '0',
      });
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        open();
      }
    });
  });

  if (bracketAdminModalOpen) {
    renderBracketAdminModal();
  }
}

function buildBracketSlotOrderMap(slotTeamIds) {
  const map = new Map();
  const arr = Array.isArray(slotTeamIds) ? slotTeamIds : [];
  for (let i = 0; i < 8; i++) {
    const teamId = String(arr[i] || '').trim();
    if (!teamId) continue;
    map.set(teamId, i + 1);
  }
  return map;
}

function bracketScoreRowEqual(a, b) {
  const normalize = (row) => {
    const out = {};
    if (!row || typeof row !== 'object' || Array.isArray(row)) return out;
    Object.entries(row).forEach(([rawTeamId, rawWins]) => {
      const teamId = String(rawTeamId || '').trim();
      const wins = clampBracketSeriesWins(rawWins);
      if (!teamId || wins <= 0) return;
      out[teamId] = wins;
    });
    return out;
  };
  const left = normalize(a);
  const right = normalize(b);
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;
  for (let i = 0; i < leftKeys.length; i++) {
    const key = leftKeys[i];
    if (key !== rightKeys[i]) return false;
    if (left[key] !== right[key]) return false;
  }
  return true;
}

function bracketAdminMatchSideLabel(slot) {
  if (!slot) return 'TBD';
  if (slot.kind === 'team') {
    const seed = Number.isFinite(Number(slot.seed)) ? `#${slot.seed} ` : '';
    return `${seed}${String(slot.fullName || slot.name || 'Team').trim()}`;
  }
  if (slot.kind === 'placeholder') return String(slot.name || 'TBD');
  return 'TBD';
}

function createBracketAdminDraft() {
  const model = buildBracketModel(teamsCache);
  return {
    slotTeamIds: Array.from({ length: 8 }, (_, idx) => String(model?.slotTeamIds?.[idx] || '').trim()),
    scoreByMatchId: cloneBracketScoreMap(model?.scoreSelections || null),
  };
}

function sanitizeBracketAdminDraft(draft) {
  const next = {
    slotTeamIds: Array.from({ length: 8 }, (_, idx) => String(draft?.slotTeamIds?.[idx] || '').trim()),
    scoreByMatchId: cloneBracketScoreMap(draft?.scoreByMatchId || null),
  };

  const visibleIds = new Set(
    (teamsCache || [])
      .filter(t => !t?.archived && !teamIsEmpty(t))
      .map(t => String(t?.id || '').trim())
      .filter(Boolean)
  );

  next.slotTeamIds = next.slotTeamIds.map((teamId) => (visibleIds.has(teamId) ? teamId : ''));
  BRACKET_MATCH_IDS.forEach((matchId) => {
    const row = next.scoreByMatchId[matchId] || {};
    const filtered = {};
    Object.entries(row).forEach(([rawTeamId, rawWins]) => {
      const teamId = String(rawTeamId || '').trim();
      const wins = clampBracketSeriesWins(rawWins);
      if (!teamId || !visibleIds.has(teamId) || wins <= 0) return;
      filtered[teamId] = wins;
    });
    next.scoreByMatchId[matchId] = filtered;
  });

  let changed = true;
  while (changed) {
    changed = false;
    const model = buildBracketModel(teamsCache, {
      slotOrderByTeamId: buildBracketSlotOrderMap(next.slotTeamIds),
      scoreByMatchId: next.scoreByMatchId,
    });
    BRACKET_MATCH_IDS.forEach((matchId) => {
      const match = model?.matchById?.[matchId];
      const aId = (match?.slots?.[0] && match.slots[0].kind === 'team' && match.slots[0].id)
        ? String(match.slots[0].id || '').trim()
        : '';
      const bId = (match?.slots?.[1] && match.slots[1].kind === 'team' && match.slots[1].id)
        ? String(match.slots[1].id || '').trim()
        : '';

      const row = next.scoreByMatchId[matchId] || {};
      let aWins = aId ? clampBracketSeriesWins(row[aId]) : 0;
      let bWins = bId ? clampBracketSeriesWins(row[bId]) : 0;
      [aWins, bWins] = sanitizeBracketBestOf3Pair(aWins, bWins);

      const normalized = {};
      if (aId && aWins > 0) normalized[aId] = aWins;
      if (bId && bWins > 0) normalized[bId] = bWins;
      if (!bracketScoreRowEqual(row, normalized)) {
        next.scoreByMatchId[matchId] = normalized;
        changed = true;
      }
    });
  }

  return next;
}

function adjustBracketAdminSeriesScore(matchId, teamId, delta) {
  const mid = normalizeBracketMatchId(matchId);
  const tid = String(teamId || '').trim();
  const amount = Number(delta);
  if (!mid || !tid || !Number.isFinite(amount) || amount === 0) return;
  if (!bracketAdminDraft) bracketAdminDraft = createBracketAdminDraft();

  bracketAdminDraft = sanitizeBracketAdminDraft(bracketAdminDraft);
  const previewModel = buildBracketModel(teamsCache, {
    slotOrderByTeamId: buildBracketSlotOrderMap(bracketAdminDraft.slotTeamIds),
    scoreByMatchId: bracketAdminDraft.scoreByMatchId,
  });
  const match = previewModel?.matchById?.[mid];
  if (!match) return;
  const aId = (match?.slots?.[0] && match.slots[0].kind === 'team' && match.slots[0].id)
    ? String(match.slots[0].id || '').trim()
    : '';
  const bId = (match?.slots?.[1] && match.slots[1].kind === 'team' && match.slots[1].id)
    ? String(match.slots[1].id || '').trim()
    : '';
  if (!aId && !bId) return;
  if (tid !== aId && tid !== bId) return;

  const row = { ...(bracketAdminDraft?.scoreByMatchId?.[mid] || {}) };
  let aWins = aId ? clampBracketSeriesWins(row[aId]) : 0;
  let bWins = bId ? clampBracketSeriesWins(row[bId]) : 0;
  if (tid === aId) aWins = clampBracketSeriesWins(aWins + amount);
  if (tid === bId) bWins = clampBracketSeriesWins(bWins + amount);
  [aWins, bWins] = sanitizeBracketBestOf3Pair(aWins, bWins, tid === bId ? 'b' : 'a');

  const nextRow = {};
  if (aId && aWins > 0) nextRow[aId] = aWins;
  if (bId && bWins > 0) nextRow[bId] = bWins;
  bracketAdminDraft.scoreByMatchId[mid] = nextRow;
}

function renderBracketAdminModal() {
  if (!bracketAdminModalOpen) return;
  if (!isAdminUser()) {
    closeBracketAdminModal();
    return;
  }

  bracketAdminDraft = sanitizeBracketAdminDraft(bracketAdminDraft || createBracketAdminDraft());
  const slotsHost = document.getElementById('bracket-admin-slots');
  const winnersHost = document.getElementById('bracket-admin-winners');
  const saveBtn = document.getElementById('bracket-admin-save');
  if (!slotsHost || !winnersHost) return;

  const previewModel = buildBracketModel(teamsCache, {
    slotOrderByTeamId: buildBracketSlotOrderMap(bracketAdminDraft.slotTeamIds),
    scoreByMatchId: bracketAdminDraft.scoreByMatchId,
  });
  const teamOptions = Array.isArray(previewModel?.teamOptions) ? previewModel.teamOptions : [];

  const slotRows = Array.from({ length: 8 }, (_, idx) => {
    const selectedId = String(bracketAdminDraft?.slotTeamIds?.[idx] || '').trim();
    const options = [
      '<option value="">-- Empty --</option>',
      ...teamOptions.map((team) => {
        const tid = String(team?.id || '').trim();
        const isSelected = selectedId && tid && selectedId === tid;
        const seed = Number.isFinite(Number(team?.seed)) ? `#${team.seed} ` : '';
        const label = `${seed}${String(team?.name || 'Unnamed')}`;
        return `<option value="${esc(tid)}" ${isSelected ? 'selected' : ''}>${esc(label)}</option>`;
      }),
    ].join('');
    return `
      <label class="bracket-admin-row">
        <span class="bracket-admin-row-label">Slot ${idx + 1}</span>
        <select class="input" data-bracket-slot="${idx}">${options}</select>
      </label>
    `;
  }).join('');
  slotsHost.innerHTML = slotRows;

  const resultRows = BRACKET_MATCH_IDS.map((matchId) => {
    const match = previewModel?.matchById?.[matchId];
    const slotA = match?.slots?.[0] || null;
    const slotB = match?.slots?.[1] || null;
    const aId = (slotA && slotA.kind === 'team' && slotA.id) ? String(slotA.id || '').trim() : '';
    const bId = (slotB && slotB.kind === 'team' && slotB.id) ? String(slotB.id || '').trim() : '';
    const aWins = clampBracketSeriesWins(match?.series?.aWins || 0);
    const bWins = clampBracketSeriesWins(match?.series?.bWins || 0);
    const aWinner = !!(match?.winnerTeamId && aId && String(match.winnerTeamId) === aId);
    const bWinner = !!(match?.winnerTeamId && bId && String(match.winnerTeamId) === bId);
    const canEditA = !!aId && !bracketAdminSaveInFlight;
    const canEditB = !!bId && !bracketAdminSaveInFlight;
    const canReset = (aWins > 0 || bWins > 0) && !bracketAdminSaveInFlight;
    return `
      <div class="bracket-admin-row bracket-admin-series-row">
        <span class="bracket-admin-row-label">${esc(String(match?.label || matchId))}</span>
        <div class="bracket-admin-series">
          <div class="bracket-admin-series-side ${aWinner ? 'is-winner' : ''} ${aId ? 'is-team' : 'is-empty'}">
            <span class="bracket-admin-series-name">${esc(bracketAdminMatchSideLabel(slotA))}</span>
            <div class="bracket-admin-series-controls">
              <button type="button" class="bracket-admin-score-btn" data-bracket-series-dec="${esc(matchId)}" data-team-id="${esc(aId)}" ${canEditA ? '' : 'disabled'}>-1</button>
              <span class="bracket-admin-series-score">${aWins}</span>
              <button type="button" class="bracket-admin-score-btn" data-bracket-series-inc="${esc(matchId)}" data-team-id="${esc(aId)}" ${canEditA ? '' : 'disabled'}>+1</button>
            </div>
          </div>
          <span class="bracket-admin-series-vs">vs</span>
          <div class="bracket-admin-series-side ${bWinner ? 'is-winner' : ''} ${bId ? 'is-team' : 'is-empty'}">
            <span class="bracket-admin-series-name">${esc(bracketAdminMatchSideLabel(slotB))}</span>
            <div class="bracket-admin-series-controls">
              <button type="button" class="bracket-admin-score-btn" data-bracket-series-dec="${esc(matchId)}" data-team-id="${esc(bId)}" ${canEditB ? '' : 'disabled'}>-1</button>
              <span class="bracket-admin-series-score">${bWins}</span>
              <button type="button" class="bracket-admin-score-btn" data-bracket-series-inc="${esc(matchId)}" data-team-id="${esc(bId)}" ${canEditB ? '' : 'disabled'}>+1</button>
            </div>
          </div>
          <button type="button" class="bracket-admin-series-reset" data-bracket-series-reset="${esc(matchId)}" ${canReset ? '' : 'disabled'}>Reset</button>
        </div>
      </div>
    `;
  }).join('');
  winnersHost.innerHTML = resultRows;

  slotsHost.querySelectorAll('[data-bracket-slot]')?.forEach((sel) => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-bracket-slot'));
      if (!Number.isFinite(idx) || idx < 0 || idx >= 8) return;
      bracketAdminDraft.slotTeamIds[idx] = String(sel.value || '').trim();
      renderBracketAdminModal();
    });
  });

  winnersHost.querySelectorAll('[data-bracket-series-inc]')?.forEach((btn) => {
    btn.addEventListener('click', () => {
      const matchId = btn.getAttribute('data-bracket-series-inc');
      const teamId = btn.getAttribute('data-team-id');
      adjustBracketAdminSeriesScore(matchId, teamId, 1);
      renderBracketAdminModal();
    });
  });
  winnersHost.querySelectorAll('[data-bracket-series-dec]')?.forEach((btn) => {
    btn.addEventListener('click', () => {
      const matchId = btn.getAttribute('data-bracket-series-dec');
      const teamId = btn.getAttribute('data-team-id');
      adjustBracketAdminSeriesScore(matchId, teamId, -1);
      renderBracketAdminModal();
    });
  });
  winnersHost.querySelectorAll('[data-bracket-series-reset]')?.forEach((btn) => {
    btn.addEventListener('click', () => {
      const matchId = normalizeBracketMatchId(btn.getAttribute('data-bracket-series-reset'));
      if (!matchId) return;
      if (!bracketAdminDraft) bracketAdminDraft = createBracketAdminDraft();
      bracketAdminDraft.scoreByMatchId[matchId] = {};
      renderBracketAdminModal();
    });
  });

  if (saveBtn) {
    saveBtn.disabled = !!bracketAdminSaveInFlight;
    saveBtn.classList.toggle('disabled', !!bracketAdminSaveInFlight);
    saveBtn.textContent = bracketAdminSaveInFlight ? 'Saving...' : 'Save';
  }
}

function openBracketAdminModal() {
  if (!isAdminUser()) {
    showToast('Admin only.');
    return;
  }
  const modal = document.getElementById('bracket-admin-modal');
  if (!modal) return;
  bracketAdminModalOpen = true;
  bracketAdminDraft = createBracketAdminDraft();
  setHint('bracket-admin-hint', '');
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));
  renderBracketAdminModal();
}

function closeBracketAdminModal() {
  const modal = document.getElementById('bracket-admin-modal');
  bracketAdminModalOpen = false;
  bracketAdminDraft = null;
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }
  setHint('bracket-admin-hint', '');
}

function clearBracketAdminWinners() {
  if (!bracketAdminModalOpen) return;
  if (!bracketAdminDraft) bracketAdminDraft = createBracketAdminDraft();
  bracketAdminDraft.scoreByMatchId = emptyBracketScoreMap();
  renderBracketAdminModal();
}

async function saveBracketAdminChanges() {
  if (!isAdminUser()) {
    showToast('Admin only.');
    return;
  }
  if (!bracketAdminModalOpen || bracketAdminSaveInFlight) return;

  bracketAdminDraft = sanitizeBracketAdminDraft(bracketAdminDraft || createBracketAdminDraft());
  const slotTeamIds = Array.isArray(bracketAdminDraft?.slotTeamIds)
    ? bracketAdminDraft.slotTeamIds.map(v => String(v || '').trim())
    : [];

  const seen = new Set();
  for (const teamId of slotTeamIds) {
    if (!teamId) continue;
    if (seen.has(teamId)) {
      setHint('bracket-admin-hint', 'Each team can only appear once in slots.');
      return;
    }
    seen.add(teamId);
  }

  const slotOrderByTeamId = buildBracketSlotOrderMap(slotTeamIds);
  const previewModel = buildBracketModel(teamsCache, {
    slotOrderByTeamId,
    scoreByMatchId: bracketAdminDraft.scoreByMatchId,
  });
  const winnerByMatchId = {};
  BRACKET_MATCH_IDS.forEach((matchId) => {
    winnerByMatchId[matchId] = String(previewModel?.matchById?.[matchId]?.winnerTeamId || '').trim();
  });
  const scoreByMatchId = cloneBracketScoreMap(previewModel?.scoreSelections || null);

  const visibleTeams = (teamsCache || [])
    .filter(t => !t?.archived && !teamIsEmpty(t))
    .filter(t => String(t?.id || '').trim());
  if (!visibleTeams.length) {
    setHint('bracket-admin-hint', 'No teams available.');
    return;
  }

  const winsByTeam = new Map();
  BRACKET_MATCH_IDS.forEach((matchId) => {
    const winnerTeamId = String(winnerByMatchId[matchId] || '').trim();
    if (!winnerTeamId) return;
    const list = winsByTeam.get(winnerTeamId) || [];
    list.push(matchId);
    winsByTeam.set(winnerTeamId, list);
  });
  const seriesByTeam = new Map();
  BRACKET_MATCH_IDS.forEach((matchId) => {
    const row = (scoreByMatchId && typeof scoreByMatchId[matchId] === 'object' && !Array.isArray(scoreByMatchId[matchId]))
      ? scoreByMatchId[matchId]
      : {};
    Object.entries(row).forEach(([rawTeamId, rawWins]) => {
      const teamId = String(rawTeamId || '').trim();
      const wins = clampBracketSeriesWins(rawWins);
      if (!teamId || wins <= 0) return;
      const current = seriesByTeam.get(teamId) || {};
      current[matchId] = wins;
      seriesByTeam.set(teamId, current);
    });
  });

  bracketAdminSaveInFlight = true;
  setHint('bracket-admin-hint', 'Saving…');
  renderBracketAdminModal();
  setBracketAdminEditButtonState(previewModel);

  try {
    let batch = db.batch();
    let writes = 0;
    for (const team of visibleTeams) {
      const tid = String(team?.id || '').trim();
      if (!tid) continue;

      const preservedWins = (Array.isArray(team?.bracketWins) ? team.bracketWins : [])
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .filter((matchId) => !BRACKET_MATCH_ID_SET.has(normalizeBracketMatchId(matchId)));

      const assignedWins = winsByTeam.get(tid) || [];
      const nextWins = Array.from(new Set([...preservedWins, ...assignedWins]));
      const preservedSeries = {};
      const rawSeries = (team && typeof team.bracketSeriesWins === 'object' && !Array.isArray(team.bracketSeriesWins))
        ? team.bracketSeriesWins
        : null;
      if (rawSeries) {
        Object.entries(rawSeries).forEach(([rawMatchId, rawWins]) => {
          const matchId = normalizeBracketMatchId(rawMatchId);
          if (matchId) return;
          const wins = clampBracketSeriesWins(rawWins);
          if (wins <= 0) return;
          preservedSeries[String(rawMatchId)] = wins;
        });
      }
      const assignedSeries = seriesByTeam.get(tid) || {};
      const nextSeries = { ...preservedSeries, ...assignedSeries };

      const slotOrder = slotOrderByTeamId.get(tid);
      const updates = {
        bracketSlotUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        bracketWinsUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        bracketSeriesUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      };
      if (Number.isFinite(Number(slotOrder))) updates.bracketSlotOrder = Number(slotOrder);
      else updates.bracketSlotOrder = firebase.firestore.FieldValue.delete();
      if (nextWins.length) updates.bracketWins = nextWins;
      else updates.bracketWins = firebase.firestore.FieldValue.delete();
      if (Object.keys(nextSeries).length > 0) updates.bracketSeriesWins = nextSeries;
      else updates.bracketSeriesWins = firebase.firestore.FieldValue.delete();

      batch.update(db.collection('teams').doc(tid), updates);
      writes++;
      if (writes >= 400) {
        await batch.commit();
        batch = db.batch();
        writes = 0;
      }
    }
    if (writes > 0) await batch.commit();

    try {
      const winnerCount = BRACKET_MATCH_IDS.reduce((acc, matchId) => acc + (winnerByMatchId[matchId] ? 1 : 0), 0);
      logEvent('bracket_admin_update', 'Admin updated bracket slots and BO3 results.', {
        slottedCount: slotTeamIds.filter(Boolean).length,
        winnerCount,
      });
    } catch (_) {}

    showToast('Bracket updated.');
    closeBracketAdminModal();
  } catch (err) {
    console.error('Bracket admin save failed:', err);
    setHint('bracket-admin-hint', err?.message || 'Could not save bracket.');
    showToast(err?.message || 'Could not save bracket.');
  } finally {
    bracketAdminSaveInFlight = false;
    setBracketAdminEditButtonState(buildBracketModel(teamsCache));
    if (bracketAdminModalOpen) renderBracketAdminModal();
  }
}

// Back-compat no-op for older code paths that still reference this helper.
function drawBracketWires() {}

function initBracketsUI() {
  const randomizeBtn = document.getElementById('brackets-randomize-btn');
  const editBtn = document.getElementById('brackets-admin-edit-btn');
  const adminModal = document.getElementById('bracket-admin-modal');
  const adminCloseBtn = document.getElementById('bracket-admin-close');
  const adminCancelBtn = document.getElementById('bracket-admin-cancel');
  const adminSaveBtn = document.getElementById('bracket-admin-save');
  const adminClearWinnersBtn = document.getElementById('bracket-admin-clear-winners');

  randomizeBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    randomizeBracketMatchups();
  });
  editBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    openBracketAdminModal();
  });
  adminCloseBtn?.addEventListener('click', closeBracketAdminModal);
  adminCancelBtn?.addEventListener('click', closeBracketAdminModal);
  adminSaveBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    saveBracketAdminChanges();
  });
  adminClearWinnersBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    clearBracketAdminWinners();
  });
  adminModal?.addEventListener('click', (e) => {
    if (e.target === adminModal) closeBracketAdminModal();
  });

  let raf = null;
  const rerenderIfVisible = () => {
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = null;
      const panel = document.getElementById('panel-brackets');
      if (!panel || !panel.classList.contains('active')) return;
      try { renderBrackets(teamsCache); } catch (_) {}
    });
  };

  window.addEventListener('resize', rerenderIfVisible);
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(rerenderIfVisible).catch(() => {});
  }
  const model = buildBracketModel(teamsCache);
  setBracketRandomizeButtonState(model);
  setBracketAdminEditButtonState(model);
}

let _bracketsPopupEl = null;
let _bracketsPopupTeardown = null;

function closeBracketMatchPopup() {
  if (_bracketsPopupTeardown) {
    try { _bracketsPopupTeardown(); } catch (_) {}
    _bracketsPopupTeardown = null;
  }
  if (_bracketsPopupEl) _bracketsPopupEl.style.display = 'none';
}

function getBracketPopupTeam(teamId, fallbackName, fallbackSeed = '') {
  const tid = String(teamId || '').trim();
  const seedText = String(fallbackSeed || '').trim();
  const fallback = String(fallbackName || 'TBD').trim() || 'TBD';
  const fallbackData = { id: tid, name: fallback, seed: seedText, color: '', players: [] };
  if (!tid) return fallbackData;

  const team = (teamsCache || []).find(t => String(t?.id || '').trim() === tid && !t?.archived);
  if (!team) return fallbackData;

  const members = getMembers(team);
  const players = members
    .map((m, i) => {
      const accountId = entryAccountId(m);
      const byMember = String(m?.name || '').trim();
      const byKnown = accountId ? String(findKnownUserName(accountId) || '').trim() : '';
      const name = byMember || byKnown || `Player ${i + 1}`;
      return name;
    })
    .filter(Boolean);

  return {
    id: tid,
    name: String(team.teamName || fallback).trim() || fallback,
    seed: seedText,
    color: getDisplayTeamColor(team) || '',
    players
  };
}

function renderBracketPopupRosterItems(players) {
  const list = Array.isArray(players) ? players : [];
  if (!list.length) return '<li class="is-empty">Roster TBD</li>';
  return list.map((name) => `<li>${esc(name)}</li>`).join('');
}

function showBracketMatchPopup({ matchId, round, bestOf, aName, bName, aTeamId, bTeamId, aSeed, bSeed, aWins, bWins }) {
  try {
    closeBracketMatchPopup();

    if (!_bracketsPopupEl) {
      _bracketsPopupEl = document.createElement('div');
      _bracketsPopupEl.className = 'brx-popup';
      _bracketsPopupEl.style.display = 'none';
      document.body.appendChild(_bracketsPopupEl);
    }

    const sideA = getBracketPopupTeam(aTeamId, aName, aSeed);
    const sideB = getBracketPopupTeam(bTeamId, bName, bSeed);
    const roundLabel = String(round || 'Match').trim() || 'Match';
    const bo = String(bestOf || '3').trim() || '3';
    const idLabel = String(matchId || '').trim() || '—';
    const aDisplay = sideA.seed ? `#${sideA.seed} ${sideA.name}` : sideA.name;
    const bDisplay = sideB.seed ? `#${sideB.seed} ${sideB.name}` : sideB.name;
    const scoreA = clampBracketSeriesWins(aWins || 0);
    const scoreB = clampBracketSeriesWins(bWins || 0);
    const scoreLabel = `${scoreA}-${scoreB}`;

    _bracketsPopupEl.innerHTML = `
      <div class="brx-pop-card" role="dialog" aria-modal="true" aria-label="Bracket match details">
        <div class="brx-pop-top">
          <div class="brx-pop-kicker">Game Day Matchup</div>
          <button class="icon-btn small" type="button" data-brx-pop-close aria-label="Close">✕</button>
        </div>
        <div class="brx-pop-title">${esc(aDisplay)} <span class="brx-pop-vs">vs</span> ${esc(bDisplay)}</div>
        <div class="brx-pop-subline">
          <span>${esc(roundLabel)}</span>
          <span>BO${esc(bo)}</span>
          <span class="brx-pop-score">Score ${esc(scoreLabel)}</span>
          <span class="mono">${esc(idLabel)}</span>
        </div>
        <div class="brx-pop-lineup">
          <section class="brx-pop-team" style="${sideA.color ? `--brx-team-accent:${esc(sideA.color)};` : ''}">
            <div class="brx-pop-team-name">${esc(aDisplay)}</div>
            <ol class="brx-pop-roster">
              ${renderBracketPopupRosterItems(sideA.players)}
            </ol>
          </section>
          <div class="brx-pop-lineup-vs">VS</div>
          <section class="brx-pop-team" style="${sideB.color ? `--brx-team-accent:${esc(sideB.color)};` : ''}">
            <div class="brx-pop-team-name">${esc(bDisplay)}</div>
            <ol class="brx-pop-roster">
              ${renderBracketPopupRosterItems(sideB.players)}
            </ol>
          </section>
        </div>
      </div>
    `;

    _bracketsPopupEl.style.display = 'flex';

    const onDocDown = (e) => {
      if (!_bracketsPopupEl) return;
      if (!_bracketsPopupEl.querySelector('.brx-pop-card')?.contains(e.target)) closeBracketMatchPopup();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') closeBracketMatchPopup();
    };

    _bracketsPopupEl.querySelector('[data-brx-pop-close]')?.addEventListener('click', (e) => {
      e.preventDefault();
      closeBracketMatchPopup();
    });

    document.addEventListener('mousedown', onDocDown);
    document.addEventListener('keydown', onKey);
    _bracketsPopupTeardown = () => {
      document.removeEventListener('mousedown', onDocDown);
      document.removeEventListener('keydown', onKey);
    };
  } catch (_) {
    // no-op
  }
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
    if ((st.pendingTeamIds || []).includes(openTeamId)) {
      await cancelJoinRequest(openTeamId);
      // Update UI immediately; snapshot listener will also re-render.
      renderTeamModal(openTeamId);
      return;
    }
    await requestToJoin(openTeamId);
    renderTeamModal(openTeamId);
  });

  document.getElementById('team-modal-admin-delete')?.addEventListener('click', async () => {
    if (!openTeamId || !isAdminUser()) return;
    const tid = String(openTeamId || '').trim();
    if (!tid) return;
    await adminDeleteTeam(tid);
    const stillExists = (teamsCache || []).some(t => String(t?.id || '').trim() === tid && !t?.archived);
    if (!stillExists) closeTeamModal();
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
  const team = teamsCache.find(t => t.id === teamId && !t?.archived);
  if (!team) {
    if (openTeamId === teamId) closeTeamModal();
    return;
  }

  const tc = getDisplayTeamColor(team);
  setHTML('team-modal-title', `<span class="team-title-inline profile-link" data-profile-type="team" data-profile-id="${esc(teamId)}" style="color:${esc(tc)}">${esc(truncateTeamName(team.teamName || 'Team'))}</span>`);

  const membersEl = document.getElementById('team-modal-members');
  const members = getMembers(team);
  const tcMember = getDisplayTeamColor(team);
  if (membersEl) {
    membersEl.innerHTML = members.length
      ? members.map(m => {
          const memberId = entryAccountId(m);
          const memberName = m.name || '—';
          return `
          <div class="player-row">
            <div class="player-left">
              <span class="player-name profile-link" data-profile-type="player" data-profile-id="${esc(memberId)}" style="color:${esc(tcMember)}">${esc(memberName)}</span>
            </div>
          </div>
        `;
        }).join('')
      : '<div class="empty-state">No members yet</div>';
  }

  const st = computeUserState(teamsCache);
  const joinBtn = document.getElementById('team-modal-join');
  const full = members.length >= SOFT_TEAM_MAX;
  const iAmMember = st.teamId === teamId;
  const iAmPendingHere = (st.pendingTeamIds || []).includes(teamId);
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

  const adminDeleteBtn = document.getElementById('team-modal-admin-delete');
  if (adminDeleteBtn) {
    const showDelete = !!isAdminUser();
    adminDeleteBtn.style.display = showDelete ? '' : 'none';
    adminDeleteBtn.disabled = !showDelete;
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
      tx.update(ref, { pending: next, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
    });
    setHint(opts.hintElId || 'team-modal-hint', 'Request canceled.');
    try {
      const t = (teamsCache || []).find(x => String(x?.id || '').trim() === String(teamId || '').trim());
      const teamName = String(t?.teamName || '').trim();
      logEvent('team_request_cancel', `${normalizeUsername(getUserName()) || st.name || 'user'} canceled request${teamName ? (' for ' + teamName) : ''}`, { teamId: String(teamId || '').trim(), teamName });
    } catch (_) {}
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
        pending: dedupeRosterByAccount(pending.concat([{ userId: st.userId, name: st.name, requestedAt: firebase.firestore.Timestamp.now() }])),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
    });
    setHint(opts.hintElId || 'team-modal-hint', 'Request sent.');
    try {
      const t = (teamsCache || []).find(x => String(x?.id || '').trim() === String(teamId || '').trim());
      const teamName = String(t?.teamName || '').trim();
      logEvent('team_request', `${normalizeUsername(getUserName()) || st.name || 'user'} requested to join${teamName ? (' ' + teamName) : ' a team'}`, { teamId: String(teamId || '').trim(), teamName });
    } catch (_) {}
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

  document.getElementById('teams-admin-create-team')?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    openCreateTeamModal();
  });

  document.getElementById('leave-or-delete')?.addEventListener('click', async () => {
    const st = computeUserState(teamsCache);
    if (!st.teamId) return;

    if (st.isCreator) {
      const ok = await showCustomConfirm({
        title: 'Delete team?',
        message: 'Are you sure you want to delete your team? This cannot be undone.',
        okText: 'Delete',
        danger: true
      });
      if (!ok) return;
      await deleteTeam(st.teamId);
    } else {
      const ok = await showCustomConfirm({
        title: 'Leave team?',
        message: 'Are you sure you want to leave this team?',
        okText: 'Leave',
        danger: true
      });
      if (!ok) return;
      await leaveTeam(st.teamId, st.userId);
    }
  });

  document.getElementById('open-requests')?.addEventListener('click', () => {
    openRequestsModal();
  });

  document.getElementById('open-invites')?.addEventListener('click', () => {
    openInvitesModal();
  });

  // Invites button in the My Team tab header (useful even when you're not on a team).
  document.getElementById('open-invites-top')?.addEventListener('click', () => {
    openInvitesModal();
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
  const invitesTopBtn = document.getElementById('open-invites-top');
  const membersEl = document.getElementById('myteam-members');
  const actionsEl = document.getElementById('myteam-actions');
  const requestsBtn = document.getElementById('open-requests');
  const invitesBtn = document.getElementById('open-invites');
  const chatBtn = document.getElementById('open-chat');
  const leaveDeleteBtn = document.getElementById('leave-or-delete');
  const sub = document.getElementById('myteam-subtitle');
  const colorRow = document.getElementById('team-color-row');
  const colorInput = document.getElementById('team-color-input');

  const hasTeam = !!st.teamId;

  // Invites are relevant whether or not you're on a team.
  const me = (playersCache || []).find(p => p?.id === st.userId);
  const invites = Array.isArray(me?.invites) ? me.invites : [];
  if (invitesTopBtn) {
    invitesTopBtn.style.display = 'inline-flex';
    invitesTopBtn.textContent = invites.length ? `Invites (${invites.length})` : 'Invites';
  }

  if (joinBtn) {
    // Only show when you're named and not currently on a team.
    const show = !!st.name && !hasTeam;
    joinBtn.style.display = show ? 'inline-flex' : 'none';
  }
  if (createBtn) {
    // Create button is only relevant if you're not on a team.
    // Pending requests don't block team creation - only being on an actual team does.
    // Check if 8 full teams exist (not just 8 teams total)
    const disableCreate = !st.name || hasTeam;
    createBtn.disabled = disableCreate;
    createBtn.classList.toggle('disabled', disableCreate);
    createBtn.style.display = hasTeam ? 'none' : 'inline-flex';
  }
  if (sub) {
    if (!st.name) sub.textContent = 'Set your name first (Home tab).';
    else if (hasTeam) {
      const sz = getMembers(st.team || {}).length;
      if (sz > SOFT_TEAM_MAX) sub.textContent = 'Too many players — this team is not eligible.';
      else sub.textContent = st.isCreator
        ? 'Double click the team name to rename. You can kick teammates and manage requests.'
        : 'You are on a team. You can manage requests.';
    }
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
  setText('myteam-name', truncateTeamName(st.team.teamName || 'Unnamed'));
  const myNameEl = document.getElementById('myteam-name');
  if (myNameEl) myNameEl.style.color = getDisplayTeamColor(st.team);
  const mySize = getMembers(st.team).length;
  setText('myteam-size', `${mySize}/${SOFT_TEAM_MAX}`);
  document.getElementById('myteam-size')?.classList.toggle('overboard', mySize > SOFT_TEAM_MAX);

  // Footer buttons
  if (leaveDeleteBtn) {
    leaveDeleteBtn.style.display = 'inline-flex';
    leaveDeleteBtn.textContent = st.isCreator ? 'Delete team' : 'Leave team';
  }
  if (requestsBtn) {
    requestsBtn.style.display = hasTeam ? 'inline-flex' : 'none';
    if (hasTeam) requestsBtn.textContent = `Requests (${getPending(st.team).length})`;
  }

  // Invites button (shows your pending invites in a modal)
  if (invitesBtn) {
    // Only shown inside the team card footer (when you're already on a team).
    if (invites.length) {
      invitesBtn.style.display = 'inline-flex';
      invitesBtn.textContent = `Invites (${invites.length})`;
    } else {
      invitesBtn.style.display = 'none';
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
      const memberId = entryAccountId(m);
      return `
        <div class="player-row">
          <div class="player-left">
            <span class="player-name profile-link" data-profile-type="player" data-profile-id="${esc(memberId)}" style="color:${esc(getDisplayTeamColor(st.team))}">${esc(m.name || '—')}</span>
          </div>
          ${canKick ? `<button class="icon-btn danger" type="button" data-kick="${esc(memberId)}" title="Kick">×</button>` : ''}
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
  if (!st.teamId) return;
  const modal = document.getElementById('requests-modal');
  if (!modal) return;
  // Use the same animated modal system as other modals (team/settings/etc.).
  // The global .modal CSS keeps modals hidden unless the .modal-open class is applied.
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));
  renderRequestsModal();
}

function closeRequestsModal() {
  const modal = document.getElementById('requests-modal');
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }
  setHint('requests-modal-hint', '');
}

function renderRequestsModal() {
  const st = computeUserState(teamsCache);
  const list = document.getElementById('requests-modal-list');
  if (!list) return;
  if (!st.team) {
    list.innerHTML = '<div class="empty-state">No team</div>';
    return;
  }

  const pending = getPending(st.team);
  list.innerHTML = pending.length
    ? pending.map(r => {
        const requesterId = entryAccountId(r);
        return `
          <div class="request-row">
            <div class="player-left">
              <span class="player-name profile-link" data-profile-type="player" data-profile-id="${esc(requesterId)}">${esc(r.name || '—')}</span>
            </div>
            <div class="request-actions">
              <button class="btn primary small" type="button" data-accept="${esc(requesterId)}">Accept</button>
              <button class="btn danger small" type="button" data-decline="${esc(requesterId)}">Decline</button>
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
   Invites modal
========================= */
function initInvitesModal() {
  const modal = document.getElementById('invites-modal');
  document.getElementById('invites-modal-close')?.addEventListener('click', closeInvitesModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeInvitesModal();
  });
}

function openInvitesModal() {
  const modal = document.getElementById('invites-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));
  renderInvitesModal();
}

function closeInvitesModal() {
  const modal = document.getElementById('invites-modal');
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }
  setHint('invites-modal-hint', '');
}

function renderInvitesModal() {
  const st = computeUserState(teamsCache);
  const list = document.getElementById('invites-modal-list');
  if (!list) return;

  const me = (playersCache || []).find(p => p?.id === st.userId);
  const invites = Array.isArray(me?.invites) ? me.invites : [];

  // Hide (and clean up) invites to teams that no longer exist / are archived / are empty.
  const validInvites = invites.filter(inv => {
    const teamId = String(inv?.teamId || '').trim();
    if (!teamId) return false;
    const t = (teamsCache || []).find(x => String(x?.id || '').trim() === teamId);
    if (!t) return false;
    if (t?.archived) return false;
    if (teamIsEmpty(t)) return false;
    return true;
  });

  if (validInvites.length !== invites.length) {
    try {
      const st = computeUserState(teamsCache);
      if (st?.userId) {
        db.collection('players').doc(st.userId).update({
          invites: validInvites,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    } catch (_) {}
  }

  if (!validInvites.length) {
    list.innerHTML = '<div class="empty-state">No invites</div>';
    return;
  }

  const noName = !st.name;
  if (noName) setHint('invites-modal-hint', 'Set your name on Home first.');
  else setHint('invites-modal-hint', '');

  list.innerHTML = validInvites.map(inv => {
    const teamName = truncateTeamName(inv?.teamName || 'Team');
    const teamId = inv?.teamId || '';
    const t = (teamsCache || []).find(x => x?.id === teamId);
    const c = t ? getDisplayTeamColor(t) : null;
    const nameStyle = c ? `style="color:${esc(c)}"` : '';
    return `
      <div class="invite-row">
        <div class="invite-left">
          <div class="invite-title profile-link" data-profile-type="team" data-profile-id="${esc(teamId)}" ${nameStyle}>${esc(teamName)}</div>
          <div class="invite-sub">You've been invited to join</div>
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
      renderInvitesModal();
    });
  });

  list.querySelectorAll('[data-invite-decline]')?.forEach(btn => {
    btn.addEventListener('click', async () => {
      const teamId = btn.getAttribute('data-invite-decline');
      if (!teamId) return;
      await declineInvite(teamId);
      renderInvites(playersCache, teamsCache);
      renderInvitesModal();
      renderMyTeam(teamsCache);
    });
  });
}

/* =========================
   Admin: Assign players to teams
========================= */

let adminAssignModalOpen = false;
let adminAssignFilter = '';

function initAdminAssignModal() {
  const bar = document.getElementById('admin-assign-bar');
  const openBtn = document.getElementById('open-admin-assign');
  const closeBtn = document.getElementById('admin-assign-close');
  const modal = document.getElementById('admin-assign-modal');
  const search = document.getElementById('admin-assign-search');
  const refreshBtn = document.getElementById('admin-assign-refresh');

  // Bar is only shown for admins, but we still wire handlers defensively.
  openBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!isAdminUser()) {
      setHint('admin-assign-bar-hint', 'Admin only.');
      return;
    }
    openAdminAssignModal();
  });

  closeBtn?.addEventListener('click', closeAdminAssignModal);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeAdminAssignModal();
  });

  refreshBtn?.addEventListener('click', () => {
    if (!adminAssignModalOpen) return;
    renderAdminAssignModal();
  });

  search?.addEventListener('input', () => {
    adminAssignFilter = String(search.value || '').trim();
    if (!adminAssignModalOpen) return;
    renderAdminAssignModal();
  });

  // Hide bar by default; renderPlayers() will toggle it on for admins.
  if (bar) bar.style.display = 'none';
}

function openAdminAssignModal() {
  const modal = document.getElementById('admin-assign-modal');
  if (!modal) return;
  if (!isAdminUser()) return;
  adminAssignModalOpen = true;
  modal.style.display = 'flex';
  requestAnimationFrame(() => modal.classList.add('modal-open'));

  const search = document.getElementById('admin-assign-search');
  if (search) {
    // Preserve last filter so repeated opens feel fast.
    search.value = adminAssignFilter || '';
    setTimeout(() => { try { search.focus(); } catch (_) {} }, 0);
  }
  setHint('admin-assign-hint', '');
  renderAdminAssignModal();
}

function closeAdminAssignModal() {
  const modal = document.getElementById('admin-assign-modal');
  adminAssignModalOpen = false;
  if (modal) {
    modal.classList.remove('modal-open');
    setTimeout(() => { modal.style.display = 'none'; }, 200);
  }
  setHint('admin-assign-hint', '');
}

function formatTeamPill(team) {
  if (!team) return `<span class="admin-assign-pill"><span class="admin-assign-dot"></span>Unassigned</span>`;
  const tc = getDisplayTeamColor(team) || null;
  const dotStyle = tc ? `style="background:${esc(tc)}"` : '';
  const pillStyle = tc
    ? `style="border-color:${esc(hexToRgba(tc, 0.35))}; background:${esc(hexToRgba(tc, 0.10))}"`
    : '';
  return `<span class="admin-assign-pill" ${pillStyle}><span class="admin-assign-dot" ${dotStyle}></span>${esc(truncateTeamName(team.teamName || 'Team'))}</span>`;
}

function renderAdminAssignModal() {
  if (!adminAssignModalOpen) return;
  if (!isAdminUser()) {
    setHint('admin-assign-hint', 'Admin only.');
    return;
  }
  const list = document.getElementById('admin-assign-list');
  if (!list) return;

  const roster = buildRosterIndex(teamsCache);
  const directory = buildPlayersDirectory(playersCache, teamsCache)
    .filter(p => (p?.name || '').trim());

  const filter = (adminAssignFilter || '').toLowerCase();
  const filtered = filter
    ? directory.filter(p => String(p?.name || '').toLowerCase().includes(filter) || String(p?.id || '').toLowerCase().includes(filter))
    : directory;

  // Sort: unassigned first, then by current team, then name.
  const sorted = [...filtered].sort((a, b) => {
    const ta = roster.memberTeamByUserId.get(a.id);
    const tb = roster.memberTeamByUserId.get(b.id);
    const aKey = ta ? String(ta.teamName || '').toLowerCase() : '';
    const bKey = tb ? String(tb.teamName || '').toLowerCase() : '';
    if (!!ta !== !!tb) return ta ? 1 : -1;
    if (aKey !== bKey) return aKey.localeCompare(bKey);
    return String(a?.name || '').toLowerCase().localeCompare(String(b?.name || '').toLowerCase());
  });

  const teamsSorted = [...(teamsCache || [])]
    .filter(t => !t?.archived && !teamIsEmpty(t))
    .sort((a, b) => String(a?.teamName || '').localeCompare(String(b?.teamName || '')));

  if (!sorted.length) {
    list.innerHTML = '<div class="empty-state">No players match your search.</div>';
    return;
  }

  list.innerHTML = sorted.map(p => {
    const uid = String(p.id || '').trim();
    const name = String(p.name || '—').trim();
    const currentTeam = roster.memberTeamByUserId.get(uid) || null;
    const currentTid = currentTeam ? String(currentTeam.id || '') : '';

    const options = [
      `<option value="">Unassigned</option>`,
      ...teamsSorted.map(t => {
        const tid = String(t.id || '').trim();
        const label = truncateTeamName(t.teamName || 'Team');
        return `<option value="${esc(tid)}" ${tid === currentTid ? 'selected' : ''}>${esc(label)}</option>`;
      })
    ].join('');

    return `
      <div class="admin-assign-row" data-admin-assign-row="${esc(uid)}">
        <div class="admin-assign-left">
          <div class="admin-assign-name">${esc(name)}</div>
          <div class="admin-assign-meta">${formatTeamPill(currentTeam)}</div>
        </div>
        <div class="admin-assign-right">
          <select class="input admin-assign-select" data-admin-assign-select="${esc(uid)}">${options}</select>
        </div>
      </div>
    `;
  }).join('');

  // Attach handlers (single assignment action on change)
  list.querySelectorAll('[data-admin-assign-select]')?.forEach(sel => {
    sel.addEventListener('change', async (e) => {
      const uid = sel.getAttribute('data-admin-assign-select');
      const nextTeamId = String(sel.value || '').trim();
      if (!uid) return;

      // UI feedback
      const row = list.querySelector(`[data-admin-assign-row="${CSS.escape(uid)}"]`);
      if (row) row.style.opacity = '0.65';
      setHint('admin-assign-hint', 'Updating…');

      try {
        await adminAssignPlayerToTeam(uid, nextTeamId || null);
        setHint('admin-assign-hint', 'Updated.');
      } catch (err) {
        console.error(err);
        setHint('admin-assign-hint', err?.message || 'Could not update.');
      } finally {
        if (row) row.style.opacity = '';
      }
    });
  });
}

async function adminAssignPlayerToTeam(userId, teamIdOrNull) {
  if (!isAdminUser()) throw new Error('Admin only');
  const uid = String(userId || '').trim();
  if (!uid) return;

  const targetTid = teamIdOrNull ? String(teamIdOrNull || '').trim() : '';
  const targetTeam = targetTid ? (teamsCache || []).find(t => String(t?.id || '').trim() === targetTid) : null;
  if (targetTid && !targetTeam) throw new Error('Team not found.');

  // Resolve player name (best effort)
  const dir = buildPlayersDirectory(playersCache, teamsCache);
  const me = dir.find(p => String(p?.id || '').trim() === uid) || (playersCache || []).find(p => String(p?.id || '').trim() === uid);
  const name = String(me?.name || findKnownUserName(uid) || uid).trim() || uid;

  const batch = db.batch();
  let writes = 0;

  // Remove from any existing team rosters + pending lists
  const updates = new Map(); // tid -> {members, pending}
  for (const t of (teamsCache || [])) {
    const tid = String(t?.id || '').trim();
    if (!tid) continue;
    const members = getMembers(t);
    const pending = getPending(t);
    const hadMember = members.some(m => isSameAccount(m, uid));
    const hadPending = pending.some(r => isSameAccount(r, uid));
    if (!hadMember && !hadPending) continue;

    const nextMembers = members.filter(m => !isSameAccount(m, uid));
    const nextPending = pending.filter(r => !isSameAccount(r, uid));
    updates.set(tid, { members: nextMembers, pending: nextPending });
  }

  // Add to target team (after removal)
  if (targetTid) {
    const base = updates.get(targetTid) || { members: getMembers(targetTeam), pending: getPending(targetTeam) };
    const nextMembers = dedupeRosterByAccount(base.members.concat([{ userId: uid, name }]));
    const nextPending = base.pending.filter(r => !isSameAccount(r, uid));
    updates.set(targetTid, { members: nextMembers, pending: nextPending });
  }

  // Apply updates
  for (const [tid, data] of updates.entries()) {
    batch.update(db.collection('teams').doc(tid), {
      members: data.members,
      pending: data.pending,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    writes++;
    if (writes >= 450) break;
  }

  if (writes === 0) {
    // No-op assignment (e.g., already unassigned)
    return;
  }

  await batch.commit();

  // Auto-archive teams that became empty as a result of reassignment.
  // (Best-effort; if rules block this, the UI will still hide empty teams.)
  try {
    const empties = [];
    for (const [tid, data] of updates.entries()) {
      if ((data?.members?.length || 0) === 0 && (data?.pending?.length || 0) === 0) empties.push(tid);
    }
    if (empties.length) await Promise.all(empties.map(tid => archiveTeamIfEmpty(tid)));
  } catch (_) {}

  try {
    const targetName = targetTid ? String(targetTeam?.teamName || 'Team').trim() : 'Unassigned';
    logEvent('admin_assign', `Admin assigned ${normalizeUsername(name)} → ${targetName}`, {
      targetUserId: uid,
      targetName: normalizeUsername(name),
      teamId: targetTid || null,
      teamName: targetTid ? String(targetTeam?.teamName || '').trim() : null,
    });
  } catch (_) {}
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

  // Personal (DMs) — count unread threads (not individual messages) to avoid
  // expensive per-thread message reads.
  const myId = String(getUserId() || '').trim();
  let p = 0;
  if (myId) {
    for (const thr of (dmThreadsCache || [])) {
      const tid = String(thr?.id || '').trim();
      if (!tid) continue;
      const lastAtMs = tsToMs(thr?.lastAt) || tsToMs(thr?.updatedAt) || 0;
      if (!lastAtMs) continue;
      const readAtMs = getMyPersonalReadMs(tid);
      const lastSenderId = String(thr?.lastSenderId || '').trim();
      const unread = (lastAtMs > readAtMs) && (!!lastSenderId && lastSenderId !== myId);
      if (unread) p += 1;
    }
  }

  // If user is currently viewing a chat, treat it as read.
  if (chatDrawerOpen) {
    if (chatMode === 'global') g = 0;
    if (chatMode === 'team') t = 0;
    if (chatMode === 'personal') p = 0;
  }

  unreadGlobalCount = g;
  unreadTeamCount = t;
  unreadPersonalCount = p;

  setBadge('badge-global', unreadGlobalCount);
  setBadge('badge-team', unreadTeamCount);
  const total = unreadGlobalCount + unreadTeamCount + unreadPersonalCount;
  setBadge('badge-chat-desktop', total);
  setBadge('badge-chat-mobile', total);
  setBadge('badge-header-chat', total);
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
  if (mode === 'personal') return; // no personal unread tracking yet
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
  const btnPersonal = document.getElementById('chat-mode-personal');
  const personalBar = document.getElementById('chat-personal-bar');
  const personalPickerBtn = document.getElementById('chat-personal-picker-btn');
  const personalPopover = document.getElementById('chat-personal-popover');
  const personalSearch = document.getElementById('chat-personal-search');
  const personalList = document.getElementById('chat-personal-list');
  const personalWrap = personalPickerBtn?.closest('.chat-personal-picker-wrap') || null;
  const form = document.getElementById('chat-panel-form');

  const setMode = (mode) => {
    chatMode = (mode === 'team') ? 'team' : (mode === 'personal' ? 'personal' : 'global');
    btnGlobal?.classList.toggle('active', chatMode === 'global');
    btnTeam?.classList.toggle('active', chatMode === 'team');
    btnPersonal?.classList.toggle('active', chatMode === 'personal');
    btnGlobal?.setAttribute('aria-selected', chatMode === 'global' ? 'true' : 'false');
    btnTeam?.setAttribute('aria-selected', chatMode === 'team' ? 'true' : 'false');
    btnPersonal?.setAttribute('aria-selected', chatMode === 'personal' ? 'true' : 'false');

    // Personal behaves like iMessage-style inbox -> thread
    if (chatMode === 'personal') {
    if (dmView === 'inbox') {
      stopChatSubscription();
      showDmInbox();
      return;
    }
      // Show inbox view by default when switching into Personal
      if (chatDrawerOpen) {
        stopChatSubscription();
        showDmInbox();
      }
    } else {
      // Hide DM UI and show the normal chat composer/messenger
      const inbox = document.getElementById('dm-inbox');
      const bar = document.getElementById('dm-thread-bar');
      if (inbox) inbox.style.display = 'none';
      if (bar) bar.style.display = 'none';
      try { closeDmNew(); } catch (_) {}
      const msgs = document.getElementById('chat-panel-messages');
      const form = document.getElementById('chat-panel-form');
      if (msgs) msgs.style.display = 'flex';
      if (form) form.style.display = 'flex';
      const hint = document.getElementById('chat-panel-hint');
      if (hint) hint.style.display = 'block';
    }

    // If drawer is open, resubscribe for non-personal modes.
    if (chatDrawerOpen && chatMode !== 'personal') {
      startChatSubscription();
      if (chatMode === 'global' || chatMode === 'team') markChatRead(chatMode);
    }
    recomputeUnreadBadges();
  };

  btnGlobal?.addEventListener('click', () => setMode('global'));
  btnTeam?.addEventListener('click', () => setMode('team'));
  btnPersonal?.addEventListener('click', () => setMode('personal'));


  // Personal chat recipient picker (custom UI; not a native <select>)
  const closePopover = () => {
    if (!personalPopover || !personalPickerBtn) return;
    personalPopover.style.display = 'none';
    personalPickerBtn.setAttribute('aria-expanded', 'false');
  };
  const openPopover = () => {
    if (!personalPopover || !personalPickerBtn) return;
    personalPopover.style.display = 'block';
    personalPickerBtn.setAttribute('aria-expanded', 'true');
    try { personalSearch?.focus(); } catch (_) {}
    refreshPersonalChatSelect();
  };
  const togglePopover = () => {
    if (!personalPopover) return;
    const open = personalPopover.style.display !== 'none';
    if (open) closePopover();
    else openPopover();
  };

  personalPickerBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (chatMode !== 'personal') setMode('personal');
    togglePopover();
  });

  personalSearch?.addEventListener('input', () => refreshPersonalChatSelect());

  document.addEventListener('click', (e) => {
    if (!personalPopover || personalPopover.style.display === 'none') return;
    const t = e.target;
    if (personalWrap && t instanceof Node && personalWrap.contains(t)) return;
    closePopover();
  });

  personalList?.addEventListener('click', (e) => {
    const item = e.target?.closest?.('[data-uid]');
    const uid = String(item?.getAttribute?.('data-uid') || '').trim();
    if (!uid) return;
    setPersonalChatTarget(uid);
    closePopover();
    if (chatDrawerOpen && chatMode === 'personal') {
      startChatSubscription();
      markChatRead('personal');
    }
    setTimeout(() => { try { document.getElementById('chat-panel-input')?.focus(); } catch (_) {} }, 50);
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendChatTabMessage();
  });

  // DM inbox / New message UI (Personal)
  initDmInboxUi();

  initUnreadListeners();
  recomputeUnreadBadges();

  // Load last selected personal recipient (best-effort)
  try {
    const saved = String(localStorage.getItem(LS_CHAT_PERSONAL) || '').trim();
    if (saved) chatPersonalUserId = saved;
  } catch (_) {}
  refreshPersonalChatSelect();
  if (personalBar) personalBar.style.display = chatMode === 'personal' ? 'flex' : 'none';
}

function dmThreadIdFor(a, b) {
  const x = String(a || '').trim();
  const y = String(b || '').trim();
  if (!x || !y) return '';
  return [x, y].sort().join('__');
}

function getNameForAccount(uid) {
  const id = String(uid || '').trim();
  if (!id) return '';
  // Prefer player profile name
  const p = (playersCache || []).find(pp => String(pp?.id || '').trim() === id);
  if (p?.name) return String(p.name).trim();
  // Fall back to username registry doc id
  const u = (usernamesCache || []).find(x => String(x?.uid || '').trim() === id);
  if (u?.id) return String(u.id).trim();
  return '';
}


function tsToMs(ts) {
  try {
    if (!ts) return 0;
    if (typeof ts === 'number') return ts;
    if (typeof ts.toMillis === 'function') return ts.toMillis();
    if (ts.seconds) return (Number(ts.seconds) * 1000) + Math.floor(Number(ts.nanoseconds || 0) / 1e6);
  } catch (_) {}
  return 0;
}

function getMyPersonalReadMs(threadId) {
  const me = String(getUserId() || '').trim();
  if (!me || !threadId) return 0;
  const p = (playersCache || []).find(pp => String(pp?.id || '').trim() === me);
  const rr = p?.readReceipts?.personal || {};
  const ts = rr?.[threadId];
  return tsToMs(ts);
}

async function markPersonalThreadRead(threadId) {
  const uid = String(getUserId() || '').trim();
  if (!uid || !threadId) return;
  const ref = db.collection('players').doc(uid);
  try {
    await ref.set({
      readReceipts: { personal: { [threadId]: firebase.firestore.FieldValue.serverTimestamp() } },
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (_) {}
}

function stopDmInboxListener() {
  if (dmInboxUnsub) {
    try { dmInboxUnsub(); } catch (_) {}
    dmInboxUnsub = null;
  }
  dmThreadsCache = [];
}

function startDmInboxListener() {
  const uid = String(getUserId() || '').trim();
  if (!uid) return;
  if (dmInboxUnsub) return;

  // IMPORTANT:
  // Using `array-contains` + `orderBy(updatedAt)` can require a composite
  // index. If that index isn't created yet, Firestore throws a
  // failed-precondition error and the inbox looks empty.
  //
  // We avoid that foot-gun by listening without an explicit orderBy and
  // sorting client-side (best-effort).
  dmInboxUnsub = db.collection(DM_THREADS_COLLECTION)
    .where('participants', 'array-contains', uid)
    .limit(60)
    .onSnapshot((snap) => {
      dmThreadsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Keep message badges (and the personal inbox) fresh even when the
      // Personal tab isn't open.
      try { recomputeUnreadBadges(); } catch (_) {}
      // Only render the inbox UI when it's relevant; otherwise avoid extra DOM work.
      if (chatMode === 'personal' && dmView === 'inbox') {
        renderDmInbox();
      }
    }, (err) => {
      console.warn('DM inbox listen failed', err);
    });
}

function renderDmInbox() {
  const list = document.getElementById('dm-thread-list');
  if (!list) return;

  const uid = String(getUserId() || '').trim();
  if (!uid) {
    list.innerHTML = '<div class="empty-state">Sign in to view messages</div>';
    return;
  }

  if (!dmThreadsCache?.length) {
    list.innerHTML = '<div class="empty-state">No messages yet</div>';
    return;
  }

  // Sort newest-first client-side so we don't depend on Firestore composite indexes.
  // Hide "empty" threads (created without any message) so tapping a name once
  // doesn't create a permanent box in the inbox.
  const sorted = (dmThreadsCache || [])
    .filter(t => {
      const lastAtMs = tsToMs(t?.lastAt);
      const lastText = String(t?.lastText || '').trim();
      return !!(lastAtMs || lastText);
    })
    .slice()
    .sort((a, b) => {
    const am = tsToMs(a?.lastAt) || tsToMs(a?.updatedAt) || 0;
    const bm = tsToMs(b?.lastAt) || tsToMs(b?.updatedAt) || 0;
    return bm - am;
  });

  const items = sorted.map(t => {
    const tid = String(t?.id || '').trim();
    const parts = Array.isArray(t?.participants) ? t.participants.map(x => String(x||'').trim()).filter(Boolean) : [];
    const otherId = parts.find(p => p && p !== uid) || '';
    const name = otherId ? (getNameForAccount(otherId) || 'Unknown') : 'Unknown';
    const lastText = String(t?.lastText || '').trim();
    const lastAtMs = tsToMs(t?.lastAt) || tsToMs(t?.updatedAt);
    const readAtMs = getMyPersonalReadMs(tid);
    const unread = !!(lastAtMs && lastAtMs > readAtMs && String(t?.lastSenderId||'').trim() !== uid);

    const preview = lastText ? esc(lastText) : '<span class="dm-preview-muted">Tap to open</span>';
    const unreadDot = unread ? '<span class="dm-unread-dot" aria-label="Unread"></span>' : '';

    const initials = (name || 'U').trim().slice(0, 1).toUpperCase();
    return `
      <button class="dm-thread-row ${unread ? 'unread' : ''}" type="button" data-thread-id="${esc(tid)}" data-other-id="${esc(otherId)}">
        <div class="dm-avatar" aria-hidden="true">${esc(initials)}</div>
        <div class="dm-thread-main">
          <div class="dm-thread-top">
            <div class="dm-thread-name">${esc(name)}</div>
            ${unreadDot}
          </div>
          <div class="dm-thread-preview">${preview}</div>
        </div>
      </button>
    `;
  }).join('');

  list.innerHTML = items;
}

function showDmInbox() {
  dmView = 'inbox';
  const inbox = document.getElementById('dm-inbox');
  const bar = document.getElementById('dm-thread-bar');
  const msgs = document.getElementById('chat-panel-messages');
  const form = document.getElementById('chat-panel-form');
  const hint = document.getElementById('chat-panel-hint');
  if (inbox) inbox.style.display = 'block';
  if (bar) bar.style.display = 'none';
  if (msgs) msgs.style.display = 'none';
  if (form) form.style.display = 'none';
  if (hint) hint.style.display = 'none';

  startDmInboxListener();
  renderDmInbox();
}

function showDmThread(otherId) {
  const oid = String(otherId || '').trim();
  if (!oid) {
    showDmInbox();
    return;
  }
  dmView = 'thread';
  chatMode = 'personal';
  setPersonalChatTarget(oid, getNameForAccount(oid) || '');

  const inbox = document.getElementById('dm-inbox');
  const bar = document.getElementById('dm-thread-bar');
  const title = document.getElementById('dm-thread-title');
  const msgs = document.getElementById('chat-panel-messages');
  const form = document.getElementById('chat-panel-form');
  const hint = document.getElementById('chat-panel-hint');

  if (inbox) inbox.style.display = 'none';
  if (bar) bar.style.display = 'flex';
  if (title) title.textContent = chatPersonalUserName || getNameForAccount(oid) || '—';
  if (msgs) msgs.style.display = 'flex';
  if (form) form.style.display = 'flex';
  if (hint) hint.style.display = 'block';

  startChatSubscription();
  const threadId = dmThreadIdFor(String(getUserId()||'').trim(), oid);
  if (threadId) markPersonalThreadRead(threadId);
}

function openDmNew() {
  dmNewOpen = true;
  const pop = document.getElementById('dm-new-popover');
  const input = document.getElementById('dm-new-search');
  if (pop) pop.style.display = 'block';
  if (input) {
    input.value = '';
    try { input.focus(); } catch (_) {}
  }
  refreshDmNewList();
}

function closeDmNew() {
  dmNewOpen = false;
  const pop = document.getElementById('dm-new-popover');
  if (pop) pop.style.display = 'none';
}

function refreshDmNewList() {
  const list = document.getElementById('dm-new-list');
  const input = document.getElementById('dm-new-search');
  if (!list) return;
  const me = String(getUserId() || '').trim();
  const q = String(input?.value || '').trim().toLowerCase();

  // Don't spam a giant list until the user types at least one character.
  if (!q) {
    list.innerHTML = '<div class="hint" style="padding:10px 6px;">Type a name…</div>';
    return;
  }

  const all = (usernamesCache || [])
    .map(u => ({ uid: String(u?.uid || '').trim(), name: String(u?.id || '').trim() }))
    .filter(u => u.uid && u.name && u.uid !== me)
    .filter(u => u.name.toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name))
    .slice(0, 40);

  if (!all.length) {
    list.innerHTML = '<div class="hint" style="padding:10px 6px;">No matches</div>';
    return;
  }

  list.innerHTML = all.map(u => `
    <button class="dm-new-item" type="button" data-uid="${esc(u.uid)}" role="option">${esc(u.name)}</button>
  `).join('');
}

function initDmInboxUi() {
  const inboxNew = document.getElementById('dm-inbox-new');
  const threadNew = document.getElementById('dm-thread-new');
  const backBtn = document.getElementById('dm-back-btn');
  const newClose = document.getElementById('dm-new-close');
  const newSearch = document.getElementById('dm-new-search');
  const newList = document.getElementById('dm-new-list');
  const threadList = document.getElementById('dm-thread-list');

  inboxNew?.addEventListener('click', (e) => { e.preventDefault(); openDmNew(); });
  threadNew?.addEventListener('click', (e) => { e.preventDefault(); openDmNew(); });
  newClose?.addEventListener('click', (e) => { e.preventDefault(); closeDmNew(); });

  backBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    stopChatSubscription();
    showDmInbox();
  });

  newSearch?.addEventListener('input', () => refreshDmNewList());

  newList?.addEventListener('click', async (e) => {
    const item = e.target?.closest?.('[data-uid]');
    const uid = String(item?.getAttribute?.('data-uid') || '').trim();
    if (!uid) return;
    closeDmNew();

    // IMPORTANT: Don't create a thread doc just by tapping a name.
    // The thread will be created on first send, so the inbox only shows
    // real conversations.

    showDmThread(uid);
    setTimeout(() => { try { document.getElementById('chat-panel-input')?.focus(); } catch (_) {} }, 50);
  });

  threadList?.addEventListener('click', (e) => {
    const row = e.target?.closest?.('[data-other-id]');
    const otherId = String(row?.getAttribute?.('data-other-id') || '').trim();
    if (!otherId) return;
    showDmThread(otherId);
    setTimeout(() => { try { document.getElementById('chat-panel-input')?.focus(); } catch (_) {} }, 50);
  });

  // Close "New" popover if you tap outside of it (inside the drawer)
  document.addEventListener('click', (e) => {
    if (!dmNewOpen) return;
    const pop = document.getElementById('dm-new-popover');
    const btn1 = document.getElementById('dm-inbox-new');
    const btn2 = document.getElementById('dm-thread-new');
    const t = e.target;
    if (pop && t instanceof Node && pop.contains(t)) return;
    if (btn1 && t instanceof Node && btn1.contains(t)) return;
    if (btn2 && t instanceof Node && btn2.contains(t)) return;
    closeDmNew();
  });
}

function setPersonalChatTarget(uid, nameOverride) {
  const me = String(getUserId() || '').trim();
  const target = String(uid || '').trim();
  if (!target || target === me) {
    chatPersonalUserId = '';
    chatPersonalUserName = '';
  } else {
    chatPersonalUserId = target;
    chatPersonalUserName = String(nameOverride || getNameForAccount(target) || '').trim();
  }

  // Persist and sync UI picker
  try { localStorage.setItem(LS_CHAT_PERSONAL, chatPersonalUserId || ''); } catch (_) {}
  const btn = document.getElementById('chat-personal-picker-btn');
  if (btn) {
    btn.textContent = chatPersonalUserName ? chatPersonalUserName : 'Choose a person…';
  }
}


function refreshPersonalChatSelect() {
  const list = document.getElementById('chat-personal-list');
  const btn = document.getElementById('chat-personal-picker-btn');
  const search = document.getElementById('chat-personal-search');
  if (!list || !btn) return;

  const me = String(getUserId() || '').trim();
  const q = String(search?.value || '').trim().toLowerCase();

  // Don't show everyone by default; wait until the user types at least one character.
  if (!q) {
    list.innerHTML = `<div class="hint" style="padding:10px 6px;">Type to search…</div>`;
    // Update picker label
    if (chatPersonalUserId && !chatPersonalUserName) chatPersonalUserName = getNameForAccount(chatPersonalUserId) || '';
    btn.textContent = chatPersonalUserName ? chatPersonalUserName : 'Choose a person…';
    return;
  }

  const all = (usernamesCache || [])
    .map(u => ({ uid: String(u?.uid || '').trim(), name: String(u?.id || '').trim() }))
    .filter(u => u.uid && u.name && u.uid !== me)
    .filter(u => u.name.toLowerCase().startsWith(q))
    .sort((a, b) => a.name.localeCompare(b.name));

  const cur = String(chatPersonalUserId || '').trim();

  if (!all.length) {
    list.innerHTML = `<div class="hint" style="padding:10px 6px;">No matches</div>`;
  } else {
    list.innerHTML = all.map(u => `
      <div class="chat-personal-item ${u.uid === cur ? 'active' : ''}" data-uid="${esc(u.uid)}" role="option" aria-selected="${u.uid === cur ? 'true' : 'false'}">
        <span>${esc(u.name)}</span>
        ${u.uid === cur ? '<small>Selected</small>' : '<small>Tap</small>'}
      </div>
    `).join('');
  }

  // Update picker label
  if (chatPersonalUserId && !chatPersonalUserName) chatPersonalUserName = getNameForAccount(chatPersonalUserId) || '';
  btn.textContent = chatPersonalUserName ? chatPersonalUserName : 'Choose a person…';
}


function openPersonalChatWith(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;

  // Switch chat UI state to Personal + open the drawer
  chatMode = 'personal';
  try {
    document.getElementById('chat-mode-global')?.classList.remove('active');
    document.getElementById('chat-mode-team')?.classList.remove('active');
    document.getElementById('chat-mode-personal')?.classList.add('active');
    document.getElementById('chat-mode-global')?.setAttribute('aria-selected', 'false');
    document.getElementById('chat-mode-team')?.setAttribute('aria-selected', 'false');
    document.getElementById('chat-mode-personal')?.setAttribute('aria-selected', 'true');
  } catch (_) {}

  setChatDrawerOpen(true, { focusInput: true });

  // Jump straight into the DM thread view
  setTimeout(() => {
    try { showDmThread(uid); } catch (_) {}
  }, 0);
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

async function startChatSubscription() {
  const st = computeUserState(teamsCache);

  if (!st.name) {
    stopChatSubscription();
    setHint('chat-panel-hint', 'Set your name on Home first.');
    return;
  }

  // Ensure composer is enabled by default (team mode may disable it below).
  setChatComposerDisabled(false, { hideHint: false });

  // Clear any previous subscription.
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }

  const list = document.getElementById('chat-panel-messages');
  if (list) list.innerHTML = '<div class="empty-state">Loading…</div>';

  if (chatMode === 'personal') {
    if (dmView === 'inbox') {
      stopChatSubscription();
      showDmInbox();
      return;
    }
    const me = String(st.userId || '').trim();
    const otherId = String(chatPersonalUserId || '').trim();
    if (!otherId) {
      chatMessagesCache = [];
      renderChatTabMessages();
      setHint('chat-panel-hint', 'Choose a person to message.');
      return;
    }
    const threadId = dmThreadIdFor(me, otherId);
    if (!threadId) {
      chatMessagesCache = [];
      renderChatTabMessages();
      setHint('chat-panel-hint', 'Choose a person to message.');
      return;
    }

    // Best-effort ensure the thread document exists.
    try {
      await db.collection(DM_THREADS_COLLECTION).doc(threadId).set({
        participants: [me, otherId],
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (_) {}

    setHint('chat-panel-hint', '');

    chatUnsub = db.collection(DM_THREADS_COLLECTION)
      .doc(threadId)
      .collection('messages')
      .orderBy('createdAt', 'asc')
      .limit(200)
      .onSnapshot((snap) => {
        chatMessagesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChatTabMessages();
      }, (err) => {
        console.warn('Personal chat listen failed', err);
        setHint('chat-panel-hint', 'Could not load personal chat.');
      });
    return;
  }

  if (chatMode === 'team') {
    if (!st.teamId) {
      chatMessagesCache = [];
      renderChatTabMessages();
      setChatComposerDisabled(true, { hideHint: true });
      return;
    }

    setChatComposerDisabled(false, { hideHint: false });
    setHint('chat-panel-hint', '');
    chatUnsub = db.collection('teams')
      .doc(st.teamId)
      .collection('chat')
      .orderBy('createdAt', 'asc')
      .limit(200)
      .onSnapshot((snap) => {
        chatMessagesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderChatTabMessages();
        if (chatDrawerOpen && chatMode === 'team') {
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
      if (chatDrawerOpen && chatMode === 'global') {
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

  // For bubble alignment we need to know which messages are mine.
  const st = computeUserState(teamsCache);
  const myId = String(st?.userId || '').trim();

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
    const isMine = !!(myId && senderId && senderId === myId);

    const team = getTeamForMemberId(senderId);
    const teamName = team?.teamName ? truncateTeamName(String(team.teamName)) : '';
    const color = team ? getDisplayTeamColor(team) : '';
    const whoStyle = color ? `style="color:${esc(color)}"` : '';

    // Sender label (only show for non-mine in global/team; DM thread title already shows the person).
    let meta = '';
    if (!isMine && chatMode !== 'personal') {
      const senderHtml = senderId
        ? `<span class="profile-link" data-profile-type="player" data-profile-id="${esc(senderId)}" ${whoStyle}>${esc(senderName)}</span>`
        : `<span ${whoStyle}>${esc(senderName)}</span>`;
      const teamHtml = team
        ? ` <span class="profile-link" data-profile-type="team" data-profile-id="${esc(team.id)}" ${whoStyle}>(${esc(teamName)})</span>`
        : '';
      meta = `<div class="chat-meta">${senderHtml}${teamHtml}</div>`;
    }

    // Bubble classes are used for iMessage-like layout.
    const rowCls = `chat-row ${isMine ? 'mine' : 'other'}`;
    const bubbleCls = `chat-bubble ${isMine ? 'mine' : 'other'}`;
    return `
      <div class="${rowCls}">
        <div class="${bubbleCls}">
          ${meta}
          <div class="chat-bubble-text">${esc(m?.text || '')}</div>
        </div>
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
    if (chatMode === 'personal') {
    if (dmView === 'inbox') {
      stopChatSubscription();
      showDmInbox();
      return;
    }
      const otherId = String(chatPersonalUserId || '').trim();
      if (!otherId) {
        setHint('chat-panel-hint', 'Choose a person to message.');
        return;
      }
      const threadId = dmThreadIdFor(st.userId, otherId);
      if (!threadId) {
        setHint('chat-panel-hint', 'Choose a person to message.');
        return;
      }
      // Best-effort ensure the thread document exists.
      await db.collection(DM_THREADS_COLLECTION).doc(threadId).set({
        participants: [st.userId, otherId],
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      await db.collection(DM_THREADS_COLLECTION)
        .doc(threadId)
        .collection('messages')
        .add({
          senderId: st.userId,
          senderName: st.name,
          toId: otherId,
          text,
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      // Update thread preview metadata (for the iMessage-style inbox list)
      try {
        await db.collection(DM_THREADS_COLLECTION).doc(threadId).set({
          lastText: text,
          lastAt: firebase.firestore.FieldValue.serverTimestamp(),
          lastSenderId: st.userId,
          lastSenderName: st.name,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) {}
    } else if (chatMode === 'team') {
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
  if (st.teamId) {
    setHint('create-team-hint', 'You are already on a team.');
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
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
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
    try {
      logEvent('team_create', `${normalizeUsername(getUserName()) || st.name || 'user'} created team ${teamName}`, {
        teamId: String(teamRef.id || '').trim(),
        teamName: String(teamName || '').trim(),
      });
    } catch (_) {}
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
      const pending = getPending(t);
      const nextMembers = members.filter(m => !isSameAccount(m, userId));
      const nextPending = pending; // leaving doesn't change pending

      // If this was the last member and there are no pending requests, archive the team
      // and release its name in the registry.
      if (nextMembers.length === 0 && nextPending.length === 0 && !t.archived) {
        const teamName = String(t.teamName || '').trim();
        const key = teamNameToKey(teamName);
        if (key) {
          const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
          const nameSnap = await tx.get(nameRef);
          const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
          if (mappedId === String(teamId || '').trim()) tx.delete(nameRef);
        }
        tx.update(ref, {
          members: [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          archived: true,
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(ref, {
          members: nextMembers,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
    try {
      const t = (teamsCache || []).find(x => String(x?.id || '').trim() === String(teamId || '').trim());
      const teamName = String(t?.teamName || '').trim();
      logEvent('team_leave', `${normalizeUsername(getUserName()) || 'user'} left${teamName ? (' ' + teamName) : ' team'}`, { teamId: String(teamId || '').trim(), teamName });
    } catch (_) {}
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
  let teamNameForLog = '';

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(teamRef);
      if (!snap.exists) return;
      const t = { id: snap.id, ...snap.data() };
      teamNameForLog = String(t.teamName || '').trim();
      const key = teamNameToKey(String(t.teamName || '').trim());
      if (key) {
        const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
        const nameSnap = await tx.get(nameRef);
        const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
        if (mappedId === tid) tx.delete(nameRef);
      }
      // Hard deletes are admin-only with locked-down rules. Archive instead.
      tx.update(teamRef, {
        archived: true,
        archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    closeRequestsModal();
    try {
      logEvent('team_delete', `${normalizeUsername(getUserName()) || 'user'} deleted team${teamNameForLog ? (' ' + teamNameForLog) : ''}`, { teamId: tid, teamName: teamNameForLog });
    } catch (_) {}
    activatePanel('panel-teams');
  } catch (e) {
    console.error(e);
    setHint('teams-hint', e?.message || 'Could not delete team.');
  }
}

// Admin: delete any team + clean up invites referencing it
async function adminDeleteTeam(teamId) {
  if (!isAdminUser()) return;
  const tid = String(teamId || '').trim();
  if (!tid) return;
  const ok = await showCustomConfirm({
    title: 'Delete team?',
    message: 'Delete this team for everyone? This cannot be undone.',
    okText: 'Delete',
    danger: true
  });
  if (!ok) return;

  await deleteTeam(tid);

  // Best-effort cleanup: remove team invites from player docs.
  try {
    const batch = db.batch();
    let writes = 0;
    for (const p of (playersCache || [])) {
      const pid = String(p?.id || '').trim();
      if (!pid) continue;
      const invites = Array.isArray(p?.invites) ? p.invites : [];
      if (!invites.some(i => String(i?.teamId || '').trim() === tid)) continue;
      const nextInvites = invites.filter(i => String(i?.teamId || '').trim() !== tid);
      batch.update(db.collection('players').doc(pid), { invites: nextInvites, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      writes++;
      // Keep batches reasonable.
      if (writes >= 450) break;
    }
    if (writes > 0) await batch.commit();
  } catch (e) {
    console.warn('Admin team delete cleanup failed (best-effort):', e);
  }
}

// Admin: delete any player account + remove them from teams/pending/presence
async function adminDeletePlayer(userId) {
  if (!isAdminUser()) return;
  const uid = String(userId || '').trim();
  if (!uid) return;

  const displayName = findKnownUserName(uid) || uid;
  const ok = await showCustomConfirm({
    title: 'Delete account?',
    message: `Delete account "${displayName}"? This will remove them from teams and delete their profile.`,
    okText: 'Delete',
    danger: true
  });
  if (!ok) return;

  // Remove from any teams (members + pending)
  try {
    const batch = db.batch();
    let writes = 0;
    for (const t of (teamsCache || [])) {
      const tid = String(t?.id || '').trim();
      if (!tid) continue;
      const members = getMembers(t);
      const pending = getPending(t);
      const nextMembers = members.filter(m => !isSameAccount(m, uid));
      const nextPending = pending.filter(r => !isSameAccount(r, uid));
      if (nextMembers.length !== members.length || nextPending.length !== pending.length) {
        batch.update(db.collection('teams').doc(tid), { members: nextMembers, pending: nextPending, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
        writes++;
      }
      if (writes >= 450) break;
    }
    // Delete player + presence docs
    batch.delete(db.collection('players').doc(uid));
    batch.delete(db.collection(PRESENCE_COLLECTION).doc(uid));
    writes += 2;
    await batch.commit();
  } catch (e) {
    console.error('Admin delete player failed:', e);
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
  // Any team member can accept requests.
  if (st.teamId !== teamId) return;

  const tid = String(teamId || '').trim();
  if (!tid) return;

  const teamRef = db.collection('teams').doc(tid);

  let teamNameForLog = '';
  let targetNameForLog = '';
  let targetIdForLog = '';

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(teamRef);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };

      const members = getMembers(t);
      const pending = getPending(t);

      // Find the request by account (robust to legacy/migrated ids).
      const req = pending.find(r => isSameAccount(r, userId)) || pending.find(r => String(r.userId || '').trim() === String(userId || '').trim());
      if (!req) return;

      const targetId = entryAccountId(req) || String(userId || '').trim();
      const targetName = (req.name || '—').trim();

      // Capture for admin log (outside tx)
      teamNameForLog = String(t.teamName || '').trim();
      targetNameForLog = targetName;
      targetIdForLog = String(targetId || '').trim();

      const nextPending = pending.filter(r => !isSameAccount(r, targetId));
      const nextMembers = dedupeRosterByAccount(members.concat([{ userId: targetId, name: targetName }]));

      tx.update(teamRef, {
        pending: nextPending,
        members: nextMembers,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    try {
      logEvent('team_request_accept', `${normalizeUsername(getUserName()) || st.name || 'user'} accepted ${normalizeUsername(targetNameForLog || targetIdForLog || 'user')}'s request${teamNameForLog ? (' to ' + teamNameForLog) : ''}`, {
        teamId: tid,
        teamName: teamNameForLog,
        targetUserId: targetIdForLog,
        targetName: normalizeUsername(targetNameForLog)
      });
    } catch (_) {}
  } catch (e) {
    console.error(e);
    setHint('teams-hint', e?.message || 'Could not accept request.');
  }
}

async function declineRequest(teamId, userId) {
  const st = computeUserState(teamsCache);
  // Any team member can decline requests.
  if (st.teamId !== teamId) return;

  const ref = db.collection('teams').doc(teamId);
  let teamNameForLog = '';
  let targetNameForLog = '';
  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw new Error('Team not found.');
      const t = { id: snap.id, ...snap.data() };
      teamNameForLog = String(t.teamName || '').trim();
      const pending = getPending(t);
      const req = pending.find(r => isSameAccount(r, userId)) || pending.find(r => String(r.userId || '').trim() === String(userId || '').trim());
      if (req) targetNameForLog = String(req.name || '').trim();
      const nextPending = pending.filter(r => !isSameAccount(r, userId));

      const members = getMembers(t);
      if (members.length === 0 && nextPending.length === 0 && !t.archived) {
        const teamName = String(t.teamName || '').trim();
        const key = teamNameToKey(teamName);
        if (key) {
          const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
          const nameSnap = await tx.get(nameRef);
          const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
          if (mappedId === String(teamId || '').trim()) tx.delete(nameRef);
        }
        tx.update(ref, {
          pending: [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          archived: true,
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(ref, {
          pending: nextPending,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
    });
    try {
      const target = normalizeUsername(targetNameForLog || findKnownUserName(userId) || String(userId || 'user'));
      logEvent('team_request_decline', `${normalizeUsername(getUserName()) || st.name || 'user'} declined ${target}'s request${teamNameForLog ? (' to ' + teamNameForLog) : ''}`, {
        teamId: String(teamId || '').trim(),
        teamName: teamNameForLog,
        targetUserId: String(userId || '').trim(),
        targetName: target
      });
    } catch (_) {}
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
      const pending = getPending(t);
      const nextMembers = members.filter(m => !isSameAccount(m, userId));

      if (nextMembers.length === 0 && pending.length === 0 && !t.archived) {
        const teamName = String(t.teamName || '').trim();
        const key = teamNameToKey(teamName);
        if (key) {
          const nameRef = db.collection(TEAMNAME_REGISTRY_COLLECTION).doc(key);
          const nameSnap = await tx.get(nameRef);
          const mappedId = nameSnap.exists ? String(nameSnap.data()?.teamId || '').trim() : '';
          if (mappedId === String(teamId || '').trim()) tx.delete(nameRef);
        }
        tx.update(ref, {
          members: [],
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          archived: true,
          archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      } else {
        tx.update(ref, {
          members: nextMembers,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        });
      }
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
      tx.update(ref, { members: updated, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
      // keep creatorName in sync if creator updated
      if (t.creatorUserId === userId || nameToAccountId((t.creatorName || '').trim()) === String(userId || '').trim()) {
        tx.update(ref, { creatorName: name, updatedAt: firebase.firestore.FieldValue.serverTimestamp() });
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

function setChatComposerDisabled(disabled, opts = {}) {
  const form = document.getElementById('chat-panel-form');
  if (!form) return;
  const input = document.getElementById('chat-panel-input') || form.querySelector('input');
  const send = document.getElementById('chat-panel-send') || form.querySelector('button[type="submit"]');
  const hint = document.getElementById('chat-panel-hint');

  const isDis = !!disabled;
  form.classList.toggle('is-disabled', isDis);

  if (input) {
    input.disabled = isDis;
    if (typeof opts.placeholder === 'string') input.placeholder = opts.placeholder;
  }
  if (send) send.disabled = isDis;

  // Optionally suppress the hint (used for "no team" state).
  if (hint && opts.hideHint) {
    hint.textContent = '';
    hint.style.display = 'none';
  } else if (hint) {
    // restore default visibility when not explicitly hidden
    hint.style.display = 'block';
  }
}

// Lightweight toast (no CSS dependency) for short confirmations.
function showToast(message, ms = 1400) {
  const msg = String(message || '').trim();
  if (!msg) return;

  let toast = document.getElementById('app-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'app-toast';
    toast.setAttribute('aria-live', 'polite');
    toast.style.position = 'fixed';
    toast.style.left = '50%';
    toast.style.transform = 'translateX(-50%)';
    toast.style.bottom = 'calc(84px + env(safe-area-inset-bottom, 0px))';
    toast.style.zIndex = '99999';
    toast.style.maxWidth = 'min(92vw, 520px)';
    toast.style.padding = '10px 14px';
    toast.style.borderRadius = '14px';
    toast.style.background = 'rgba(0,0,0,0.85)';
    toast.style.color = '#fff';
    toast.style.fontSize = '14px';
    toast.style.lineHeight = '1.2';
    toast.style.textAlign = 'center';
    toast.style.boxShadow = '0 10px 30px rgba(0,0,0,0.25)';
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 160ms ease';
    document.body.appendChild(toast);
  }

  // Reset any prior hide timer.
  if (toast.__hideTimer) {
    clearTimeout(toast.__hideTimer);
    toast.__hideTimer = null;
  }

  toast.textContent = msg;
  // Force reflow so opacity transition works consistently.
  void toast.offsetWidth;
  toast.style.opacity = '1';

  toast.__hideTimer = setTimeout(() => {
    toast.style.opacity = '0';
  }, Math.max(400, ms));
}


// Queue a toast to be shown after a full page reload.
// Useful when we intentionally reload (e.g., after renaming) but still want
// the user to see a confirmation message.
function queueReloadToast(message) {
  const msg = String(message || '').trim();
  if (!msg) return;
  try {
    safeLSSet(LS_RELOAD_TOAST, JSON.stringify({ m: msg, t: Date.now() }));
  } catch (_) {
    // Fallback: best-effort raw message
    safeLSSet(LS_RELOAD_TOAST, msg);
  }
}

function consumeReloadToast() {
  const raw = safeLSGet(LS_RELOAD_TOAST);
  if (!raw) return;
  safeLSDel(LS_RELOAD_TOAST);

  let msg = '';
  try {
    const obj = JSON.parse(raw);
    msg = String(obj?.m || '').trim();
  } catch (_) {
    msg = String(raw || '').trim();
  }
  if (msg) showToast(msg, 1600);
}

function activatePanel(panelId) {
  const tabs = document.querySelectorAll('.tab');
  const panels = document.querySelectorAll('.panel');
  const targetId = String(panelId || '').trim();
  if (!targetId) return;
  tabs.forEach(t => t.classList.toggle('active', t.dataset.panel === targetId));
  panels.forEach(p => p.classList.toggle('active', p.id === targetId));

  try {
    const noTabs = (targetId === 'panel-brackets' || targetId === 'panel-practice');
    document.body.classList.toggle('no-primary-tabs', !!noTabs);
    document.body.classList.toggle('brackets-mobile-no-tabs', !!noTabs);
  } catch (_) {}
}

function esc(s) {
  return String(s || '').replace(/[&<>'"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' }[c]));
}

function truncateTeamName(name, maxLen = 20) {
  const str = String(name || '');
  return str.length > maxLen ? str.slice(0, maxLen) + '...' : str;
}

function safeLSGet(key) {
  try { return localStorage.getItem(key); } catch (_) { return null; }
}

function safeLSSet(key, value) {
  try { localStorage.setItem(key, value); } catch (_) {}
}

function safeLSDel(key) {
  try { localStorage.removeItem(key); } catch (_) {}
}

function logoutLocal(loadingMessage = 'Logging out') {
  // Show loading screen with appropriate message
  showAuthLoadingScreen(loadingMessage);

  // Firebase Auth logout.
  Promise.resolve()
    .then(() => auth.signOut())
    .catch(() => {})
    .finally(() => {
      setTimeout(() => {
        try { window.location.reload(); } catch (_) {}
      }, 300);
    });
}

async function requestLogout() {
  playSound('click');
  const ok = await showCustomConfirm({
    title: 'Log out?',
    message: 'You will be signed out of this device.',
    okText: 'Log out',
    cancelText: 'Cancel',
    danger: false
  });
  if (!ok) return;
  logoutLocal('Logging out');
}

/* =========================
   Settings & Sound Effects
========================= */

// Settings state
let settingsAnimations = true;
let settingsSounds = true;
let settingsVolume = 70;
let settingsStyleMode = 'online'; // only supported style
let settingsStacking = true;
// Audio context for sound effects
let audioCtx = null;
let audioUnlocked = false;
let audioUnlockListenersAttached = false;

function unlockAudioFromGesture() {
  audioUnlocked = true;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (_) {
      return;
    }
  }
  if (audioCtx.state === 'suspended') {
    try { void audioCtx.resume(); } catch (_) {}
  }
}

function attachAudioUnlockListeners() {
  if (audioUnlockListenersAttached) return;
  audioUnlockListenersAttached = true;
  const onceOpts = { once: true, capture: true };
  document.addEventListener('pointerdown', unlockAudioFromGesture, onceOpts);
  document.addEventListener('touchstart', unlockAudioFromGesture, onceOpts);
  document.addEventListener('keydown', unlockAudioFromGesture, onceOpts);
}

function initSettings() {
  // Load saved settings from localStorage
  const savedAnimations = safeLSGet(LS_SETTINGS_ANIMATIONS);
  const savedSounds = safeLSGet(LS_SETTINGS_SOUNDS);
  const savedVolume = safeLSGet(LS_SETTINGS_VOLUME);
  const savedStyleMode = safeLSGet(LS_SETTINGS_STYLE_MODE);
  const savedStacking = safeLSGet(LS_SETTINGS_STACKING);

  settingsAnimations = savedAnimations !== 'false';
  settingsSounds = savedSounds !== 'false';
  settingsVolume = savedVolume ? parseInt(savedVolume, 10) : 70;
  settingsStacking = savedStacking !== 'false';
  if (savedStacking == null) safeLSSet(LS_SETTINGS_STACKING, 'true');

  // Only Codenames Online style is supported.
  settingsStyleMode = normalizeStyleMode(savedStyleMode);
  if (savedStyleMode !== 'online') safeLSSet(LS_SETTINGS_STYLE_MODE, 'online');

  // Browser autoplay policies require a user gesture before audio playback.
  // We arm listeners early so WebAudio unlocks on the first interaction.
  attachAudioUnlockListeners();

  // Keep legacy keys consistent for older installs
  syncLegacyStyleKeys();

  // Apply initial state
  applyStyleModeSetting();
  applyAnimationsSetting();

  // Get UI elements
  const gearBtn = document.getElementById('settings-gear-btn');
  const modal = document.getElementById('settings-modal');
  const backdrop = document.getElementById('settings-modal-backdrop');
  const closeBtn = document.getElementById('settings-modal-close');
  const animToggle = document.getElementById('settings-animations-toggle');
  const stackingToggle = document.getElementById('settings-stacking-toggle');
  const styleDropdown = document.getElementById('settings-style-dropdown');
  const styleTrigger = document.getElementById('settings-style-trigger');
  const styleValueEl = document.getElementById('settings-style-value');
  const styleMenu = document.getElementById('settings-style-menu');
  const styleOptions = Array.from(document.querySelectorAll('#settings-style-menu .settings-dropdown-option'));
  const soundToggle = document.getElementById('settings-sounds-toggle');
  const volumeSlider = document.getElementById('settings-volume-slider');
  const volumeValue = document.getElementById('settings-volume-value');
  const testSoundBtn = document.getElementById('settings-test-sound');

  if (!gearBtn || !modal) return;

  // Set initial values
  if (animToggle) animToggle.checked = settingsAnimations;
  if (stackingToggle) stackingToggle.checked = settingsStacking;
  const STYLE_MODE_LABELS = { online: 'Codenames Online' };
  const updateStyleDropdownUI = () => {
    const mode = normalizeStyleMode(settingsStyleMode);
    if (styleValueEl) styleValueEl.textContent = STYLE_MODE_LABELS[mode] || 'Codenames Online';
    styleOptions.forEach(opt => {
      const v = (opt?.dataset?.value || '').toLowerCase();
      opt.setAttribute('aria-selected', (v === mode) ? 'true' : 'false');
    });
  };

  const isStyleMenuOpen = () => !!(styleMenu && !styleMenu.hasAttribute('hidden'));
  const openStyleMenu = () => {
    if (!styleMenu || !styleTrigger || !styleDropdown) return;
    styleMenu.removeAttribute('hidden');
    styleTrigger.setAttribute('aria-expanded', 'true');
    styleDropdown.setAttribute('aria-open', 'true');
    // Focus the currently selected option for keyboard users
    const selected = styleOptions.find(o => o.getAttribute('aria-selected') === 'true');
    (selected || styleOptions[0])?.focus?.();
  };
  const closeStyleMenu = () => {
    if (!styleMenu || !styleTrigger || !styleDropdown) return;
    styleMenu.setAttribute('hidden', '');
    styleTrigger.setAttribute('aria-expanded', 'false');
    styleDropdown.removeAttribute('aria-open');
  };
  const toggleStyleMenu = () => {
    if (isStyleMenuOpen()) closeStyleMenu();
    else openStyleMenu();
  };

  updateStyleDropdownUI();
  if (soundToggle) soundToggle.checked = settingsSounds;
  if (volumeSlider) volumeSlider.value = settingsVolume;
  if (volumeValue) volumeValue.textContent = settingsVolume + '%';

  // Admin actions
  const adminSection = document.getElementById('settings-admin');
  const adminBackupBtn = document.getElementById('admin-backup-now-btn');
  const adminRestoreBtn = document.getElementById('admin-restore-5min-btn');
  const adminLogsBtn = document.getElementById('admin-logs-btn');
  const adminHintEl = document.getElementById('admin-restore-hint');

  // Account danger action: delete the current user (frees username).
  const deleteAccountBtn = document.getElementById('settings-delete-account-btn');
  const deleteAccountHint = document.getElementById('settings-delete-account-hint');

  const refreshAdminUI = () => {
    const isAdmin = !!isAdminUser();
    // Admin section is visible to everyone, but actions are disabled unless admin.
    try { if (adminSection) adminSection.style.display = 'block'; } catch (_) {}

    const btns = [adminBackupBtn, adminRestoreBtn, adminLogsBtn].filter(Boolean);
    for (const b of btns) {
      try { b.disabled = !isAdmin; } catch (_) {}
      try {
        if (!isAdmin) b.classList.add('is-disabled');
        else b.classList.remove('is-disabled');
      } catch (_) {}
    }

    if (isAdmin) {
      try { adminEnsureAutoBackupsRunning(); } catch (_) {}
    }
  };

  const setAdminHint = (msg) => {
    if (adminHintEl) adminHintEl.textContent = msg;
  };

  const setDeleteHint = (msg) => {
    if (deleteAccountHint) deleteAccountHint.textContent = String(msg || '');
  };

  refreshAdminUI();

  // (Buttons are disabled for non-admins by refreshAdminUI; click guards remain as defense-in-depth.)

  adminBackupBtn?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    playSound('click');
    adminBackupBtn.disabled = true;
    adminRestoreBtn && (adminRestoreBtn.disabled = true);
    try {
      setAdminHint('Backing up teams/players…');
      const r = await adminCreateBackup('manual');
      if (r) {
        setAdminHint(`Backup created (${r.teams} teams, ${r.players} players). Backup ID: ${r.backupId}`);
      } else {
        setAdminHint('Backup already running…');
      }
    } catch (e) {
      setAdminHint(e?.message || 'Backup failed.');
    } finally {
      adminBackupBtn.disabled = false;
      adminRestoreBtn && (adminRestoreBtn.disabled = false);
    }
  });

  adminLogsBtn?.addEventListener('click', () => {
    if (!isAdminUser()) return;
    playSound('click');
    try { closeSettingsModal(); } catch (_) {}
    try { openLogsPopup(); } catch (_) {}
  });

  adminRestoreBtn?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    playSound('click');

    const ok = await showCustomConfirm({
      title: 'Restore tournament data?',
      message: `This will <b>replace</b> the live <span class="mono">teams</span> and <span class="mono">players</span> collections with the most recent admin backup from <b>at or before ~15 minutes ago</b>.<br><br><b>There is no undo.</b>`,
      okText: 'Restore',
      danger: true
    });
    if (!ok) return;

    adminBackupBtn && (adminBackupBtn.disabled = true);
    adminRestoreBtn.disabled = true;
    try {
      setAdminHint('Restoring teams/players from backup…');
      const r = await adminRestoreFromMinutesAgo(15);
      setAdminHint(`Restored from backup ${r.restoredFromBackupId} (${r.teams} teams, ${r.players} players).`);
    } catch (e) {
      setAdminHint(e?.message || 'Restore failed.');
    } finally {
      adminBackupBtn && (adminBackupBtn.disabled = false);
      adminRestoreBtn.disabled = false;
    }
  });

  deleteAccountBtn?.addEventListener('click', async () => {
    playSound('click');
    const u = auth.currentUser;
    if (!u) {
      setDeleteHint('Sign in to use this.');
      return;
    }

    const ok = await showCustomConfirm({
      title: 'Delete account?',
      message: `This will delete your account and free your username.<br><br><b>This cannot be undone.</b>`,
      okText: 'Delete',
      danger: true
    });
    if (!ok) return;

    deleteAccountBtn.disabled = true;
    setDeleteHint('');
    showAuthLoadingScreen('Deleting account');
    try {
      const uid = String(u.uid || '').trim();
      const username = normalizeUsername(getUserName());

      // Best-effort cleanup of Firestore docs.
      const deletes = [];
      if (uid) {
        deletes.push(db.collection('presence').doc(uid).delete().catch(() => {}));
        deletes.push(db.collection('players').doc(uid).delete().catch(() => {}));
        deletes.push(db.collection('users').doc(uid).delete().catch(() => {}));
      }
      if (username) {
        deletes.push(db.collection('usernames').doc(username).delete().catch(() => {}));
      }
      await Promise.all(deletes);

      // Deleting an auth user may require a recent login.
      try {
        await u.delete();
      } catch (err) {
        const code = String(err?.code || '');
        if (code === 'auth/requires-recent-login') {
          const pw = await showPasswordDialog({
            title: 'Confirm password',
            message: 'For security, please enter your password to delete your account.'
          });
          if (!pw) throw new Error('Password required to delete account.');
          // Password-based auth uses the stored "email" handle internally (not user-facing).
          const identifier = String(u.email || '');
          const cred = firebase.auth.EmailAuthProvider.credential(identifier, passwordForAuth(pw));
          await u.reauthenticateWithCredential(cred);
          await u.delete();
        } else {
          throw err;
        }
      }

      // Signed out now; reload to the auth screen.
      try { await auth.signOut(); } catch (_) {}
      try { clearLastNavigation(); } catch (_) {}
      try { window.location.reload(); } catch (_) {}
    } catch (e) {
      console.warn('Delete account failed', e);
      setDeleteHint(e?.message || 'Delete failed.');
    } finally {
      hideAuthLoadingScreen();
      deleteAccountBtn.disabled = false;
    }
  });

  // Open modal
  gearBtn.addEventListener('click', () => {
    playSound('click');
    refreshAdminUI();
    openSettingsModal();
  });

  // Close modal
  closeBtn?.addEventListener('click', () => {
    playSound('click');
    try { closeStyleMenu && closeStyleMenu(); } catch (_) {}
    closeSettingsModal();
  });
  backdrop?.addEventListener('click', () => {
    playSound('click');
    try { closeStyleMenu && closeStyleMenu(); } catch (_) {}
    closeSettingsModal();
  });

  // Animations toggle
  animToggle?.addEventListener('change', () => {
    settingsAnimations = animToggle.checked;
    safeLSSet(LS_SETTINGS_ANIMATIONS, settingsAnimations ? 'true' : 'false');
    applyAnimationsSetting();
    playSound('toggle');
  });

  stackingToggle?.addEventListener('change', () => {
    settingsStacking = !!stackingToggle.checked;
    safeLSSet(LS_SETTINGS_STACKING, settingsStacking ? 'true' : 'false');
    try {
      window.dispatchEvent(new CustomEvent('codenames:stacking-setting-changed', {
        detail: { enabled: settingsStacking }
      }));
    } catch (_) {}
    playSound('toggle');
  });

  // Style mode (custom dropdown)
  if (styleTrigger && styleMenu) {
    styleTrigger.addEventListener('click', (e) => {
      e.preventDefault();
      toggleStyleMenu();
      playSound('click');
    });

    styleTrigger.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        if (!isStyleMenuOpen()) openStyleMenu();
      } else if (e.key === 'Escape') {
        if (isStyleMenuOpen()) {
          e.preventDefault();
          closeStyleMenu();
        }
      }
    });

    styleOptions.forEach((opt) => {
      opt.addEventListener('click', () => {
        const next = normalizeStyleMode((opt.dataset.value || '').toLowerCase());
        settingsStyleMode = next;
        safeLSSet(LS_SETTINGS_STYLE_MODE, settingsStyleMode);
        syncLegacyStyleKeys();
        applyStyleModeSetting();
        updateStyleDropdownUI();
        closeStyleMenu();
        // Return focus to trigger for a nice modal feel
        try { styleTrigger.focus(); } catch (_) {}
        playSound('toggle');
      });
    });

    // Keyboard navigation inside the menu
    styleMenu.addEventListener('keydown', (e) => {
      const opts = styleOptions;
      const currentIdx = Math.max(0, opts.findIndex(o => o === document.activeElement));
      if (e.key === 'Escape') {
        e.preventDefault();
        closeStyleMenu();
        try { styleTrigger.focus(); } catch (_) {}
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        (opts[currentIdx + 1] || opts[0])?.focus?.();
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        (opts[currentIdx - 1] || opts[opts.length - 1])?.focus?.();
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        opts[0]?.focus?.();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        opts[opts.length - 1]?.focus?.();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const el = document.activeElement;
        if (el && el.classList && el.classList.contains('settings-dropdown-option')) {
          el.click();
        }
      }
    });

    // Click outside closes the dropdown
    document.addEventListener('click', (e) => {
      if (!isStyleMenuOpen()) return;
      const t = e.target;
      if (styleDropdown && t && !styleDropdown.contains(t)) {
        closeStyleMenu();
      }
    });
  }

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
    closeSettingsModal();
    requestLogout();
  });

  // Change Name button in settings
  const settingsChangeNameBtn = document.getElementById('settings-change-name-btn');
  settingsChangeNameBtn?.addEventListener('click', () => {
    playSound('click');
    try { closeStyleMenu && closeStyleMenu(); } catch (_) {}
    closeSettingsModal();
    openNameChangeModal();
  });

  // Change Password button in settings
  const settingsChangePasswordBtn = document.getElementById('settings-change-password-btn');
  settingsChangePasswordBtn?.addEventListener('click', () => {
    playSound('click');
    try { closeStyleMenu && closeStyleMenu(); } catch (_) {}
    closeSettingsModal();
    openPasswordChangeModal();
  });

  // Test sound button
  testSoundBtn?.addEventListener('click', () => {
    playSound('success');
  });

  // Admin backup now
  adminBackupBtn?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    playSound('click');
    adminBackupBtn.disabled = true;
    try {
      setAdminHint('Backing up teams/players…');
      const res = await adminCreateBackup('manual');
      if (res) {
        setAdminHint(`Backup saved (${res.teams} teams, ${res.players} players).`);
      } else {
        setAdminHint('Backup already running…');
      }
      playSound('success');
    } catch (e) {
      console.warn(e);
      setAdminHint(e?.message || 'Backup failed.');
    } finally {
      adminBackupBtn.disabled = false;
    }
  });

  // Admin restore ~5 minutes ago
  adminRestoreBtn?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    playSound('click');
    const ok = await showCustomConfirm({
      title: 'Restore teams/players? (Admin)',
      message: 'This will <b>replace</b> the current <span class="mono">teams</span> and <span class="mono">players</span> collections with the newest admin backup from <b>~5 minutes ago</b> (or earlier).<br><br><b>Only works if an admin backup exists</b>. Continue?',
      okText: 'Restore',
      danger: true
    });
    if (!ok) return;

    adminRestoreBtn.disabled = true;
    try {
      setAdminHint('Restoring from backup…');
      const res = await adminRestoreFromMinutesAgo(5);
      setAdminHint(`Restored from backup ${res.restoredFromBackupId} (${res.teams} teams, ${res.players} players).`);
      playSound('success');
    } catch (e) {
      console.warn(e);
      setAdminHint(e?.message || 'Restore failed.');
    } finally {
      adminRestoreBtn.disabled = false;
    }
  });

  // Keyboard escape to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('modal-open')) {
      try {
        if (typeof isStyleMenuOpen === 'function' && isStyleMenuOpen()) {
          closeStyleMenu();
          try { styleTrigger && styleTrigger.focus(); } catch (_) {}
          return;
        }
      } catch (_) {}
      closeSettingsModal();
    }
  });
}

function openSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  // Toggle account-only controls depending on auth state.
  const signedIn = !!auth.currentUser;
  const logoutBtn = document.getElementById('settings-logout-btn');
  const changePwBtn = document.getElementById('settings-change-password-btn');
  const changeNameBtn = document.getElementById('settings-change-name-btn');
  const deleteBtn = document.getElementById('settings-delete-account-btn');
  const deleteHint = document.getElementById('settings-delete-account-hint');

  if (logoutBtn) logoutBtn.style.display = signedIn ? '' : 'none';
  if (changePwBtn) changePwBtn.style.display = signedIn ? '' : 'none';

  if (changeNameBtn) changeNameBtn.style.display = signedIn ? '' : 'none';
  if (deleteBtn) {
    deleteBtn.style.display = signedIn ? '' : 'none';
    deleteBtn.disabled = !signedIn;
  }
  if (deleteHint && !signedIn) {
    deleteHint.textContent = 'Sign in to use this.';
  }

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

function normalizeStyleMode(_mode) {
  return 'online';
}

function legacyThemeFromStyleMode() {
  return 'dark';
}

function legacyOgFromStyleMode() {
  return true;
}

function applyStyleModeSetting() {
  // Clear all style classes first to ensure only one mode is active.
  document.body.classList.remove('light-mode', 'cozy-mode', 'og-mode');

  settingsStyleMode = 'online';
  document.body.classList.add('og-mode');

  // Update browser theme color if present
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', '#1B2838');
  } catch (_) {}

  // Update clue input placeholder for online-style mode.
  const clueInput = document.getElementById('clue-input');
  if (clueInput) clueInput.placeholder = 'YOUR CLUE';

  // Re-render OG panels if game is active
  if (typeof renderOgPanels === 'function') {
    try { renderOgPanels(); } catch (_) { /* ignore if game not initialized */ }
  }

  // Let game.js refresh any style-dependent runtime UI (clue submit icon, board faces, etc.).
  try { window.refreshStyleSensitiveGameUI?.(); } catch (_) {}
}

function syncLegacyStyleKeys() {
  // Keep old keys in sync so existing installs and older code paths don't get confused.
  // (Safe even if those keys are no longer used elsewhere.)
  try {
    safeLSSet(LS_SETTINGS_THEME, legacyThemeFromStyleMode(settingsStyleMode));
    safeLSSet(LS_SETTINGS_OG_MODE, legacyOgFromStyleMode(settingsStyleMode) ? 'true' : 'false');
  } catch (_) {}
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
  if (!audioUnlocked) return null;
  if (!audioCtx) {
    try {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.warn('Web Audio API not supported');
      return null;
    }
  }
  if (audioCtx.state !== 'running') return null;
  return audioCtx;
}

// Sound definitions using Web Audio synthesis
// Base sounds (used by Dark mode)
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

// Light mode: airy, high-pitched, soft bell-like tones
const SOUNDS_LIGHT = {
  click: { type: 'click', freq: 1400, duration: 0.035, wave: 'sine' },
  toggle: { type: 'toggle', freq: 1100, duration: 0.06, wave: 'sine' },
  success: { type: 'success', freqs: [784, 988, 1175], duration: 0.12 },
  error: { type: 'error', freq: 280, duration: 0.18 },
  hover: { type: 'hover', freq: 1800, duration: 0.02 },
  tabSwitch: { type: 'click', freq: 1500, duration: 0.03, wave: 'sine' },
  modalOpen: { type: 'lightSwoosh', freq: 600, duration: 0.12 },
  modalClose: { type: 'lightSwoosh', freq: 500, duration: 0.08 },
  message: { type: 'lightBell', freq: 1320, duration: 0.12 },
  notification: { type: 'notification', freqs: [988, 1175], duration: 0.1 },
  cardReveal: { type: 'lightReveal', freq: 660, duration: 0.18 },
  cardCorrect: { type: 'success', freqs: [784, 988, 1319], duration: 0.16 },
  cardWrong: { type: 'lightError', freq: 260, duration: 0.22 },
  cardAssassin: { type: 'lightAssassin', freq: 140, duration: 0.4 },
  turnStart: { type: 'turn', freq: 880, duration: 0.12 },
  clueGiven: { type: 'clue', freqs: [660, 784, 988], duration: 0.16 },
  gameStart: { type: 'fanfare', freqs: [784, 988, 1175, 1568], duration: 0.25 },
  gameWin: { type: 'victory', freqs: [784, 988, 1175, 1568, 1976], duration: 0.35 },
  gameLose: { type: 'lightDefeat', freqs: [523, 440, 349], duration: 0.4 },
  timerTick: { type: 'tick', freq: 1400, duration: 0.015 },
  timerWarning: { type: 'warning', freq: 1100, duration: 0.08 },
  buttonHover: { type: 'hover', freq: 1600, duration: 0.02 },
  ready: { type: 'ready', freqs: [660, 784], duration: 0.12 },
  join: { type: 'join', freq: 784, duration: 0.1 },
  leave: { type: 'leave', freq: 494, duration: 0.12 },
  invite: { type: 'notification', freqs: [1175, 1480], duration: 0.12 },
  endTurn: { type: 'lightSwoosh', freq: 500, duration: 0.1 },
};

// Cozy mode: warm, deep, woody/organic, board-game feel
const SOUNDS_COZY = {
  click: { type: 'cozyClick', freq: 400, duration: 0.06 },
  toggle: { type: 'cozyClick', freq: 340, duration: 0.08 },
  success: { type: 'cozyArpeggio', freqs: [330, 415, 494], duration: 0.22 },
  error: { type: 'cozyThud', freq: 120, duration: 0.25 },
  hover: { type: 'hover', freq: 600, duration: 0.04 },
  tabSwitch: { type: 'cozyClick', freq: 440, duration: 0.05 },
  modalOpen: { type: 'cozyWhoosh', freq: 220, duration: 0.18 },
  modalClose: { type: 'cozyWhoosh', freq: 180, duration: 0.12 },
  message: { type: 'cozyKnock', freq: 500, duration: 0.1 },
  notification: { type: 'cozyArpeggio', freqs: [415, 494], duration: 0.14 },
  cardReveal: { type: 'cozyFlip', freq: 280, duration: 0.22 },
  cardCorrect: { type: 'cozyArpeggio', freqs: [330, 415, 523], duration: 0.24 },
  cardWrong: { type: 'cozyThud', freq: 100, duration: 0.35 },
  cardAssassin: { type: 'cozyDoom', freq: 65, duration: 0.6 },
  turnStart: { type: 'cozyKnock', freq: 440, duration: 0.14 },
  clueGiven: { type: 'cozyArpeggio', freqs: [294, 370, 440], duration: 0.24 },
  gameStart: { type: 'cozyFanfare', freqs: [330, 415, 494, 659], duration: 0.35 },
  gameWin: { type: 'cozyFanfare', freqs: [330, 415, 494, 659, 831], duration: 0.45 },
  gameLose: { type: 'cozyDefeat', freqs: [262, 220, 175], duration: 0.55 },
  timerTick: { type: 'cozyClick', freq: 550, duration: 0.025 },
  timerWarning: { type: 'cozyKnock', freq: 600, duration: 0.1 },
  buttonHover: { type: 'hover', freq: 550, duration: 0.03 },
  ready: { type: 'cozyArpeggio', freqs: [294, 370], duration: 0.16 },
  join: { type: 'cozyKnock', freq: 370, duration: 0.12 },
  leave: { type: 'cozyWhoosh', freq: 200, duration: 0.15 },
  invite: { type: 'cozyArpeggio', freqs: [494, 622], duration: 0.16 },
  endTurn: { type: 'cozyThud', freq: 200, duration: 0.14 },
};

// Codenames Online mode: sharp, digital, arcade-like bleeps
const SOUNDS_ONLINE = {
  click: { type: 'onlineBleep', freq: 1000, duration: 0.03 },
  toggle: { type: 'onlineBleep', freq: 800, duration: 0.04 },
  success: { type: 'onlineChime', freqs: [698, 880, 1047], duration: 0.12 },
  error: { type: 'onlineBuzz', freq: 160, duration: 0.18 },
  hover: { type: 'onlineBleep', freq: 1600, duration: 0.015 },
  tabSwitch: { type: 'onlineBleep', freq: 1200, duration: 0.025 },
  modalOpen: { type: 'onlineZap', freq: 500, duration: 0.1 },
  modalClose: { type: 'onlineZap', freq: 380, duration: 0.07 },
  message: { type: 'onlinePing', freq: 1047, duration: 0.08 },
  notification: { type: 'onlineChime', freqs: [880, 1047], duration: 0.1 },
  cardReveal: { type: 'onlineSnap', freq: 520, duration: 0.14 },
  cardCorrect: { type: 'onlineChime', freqs: [698, 880, 1175], duration: 0.14 },
  cardWrong: { type: 'onlineBuzz', freq: 140, duration: 0.22 },
  cardAssassin: { type: 'onlineAlarm', freq: 80, duration: 0.45 },
  turnStart: { type: 'onlinePing', freq: 880, duration: 0.1 },
  clueGiven: { type: 'onlineChime', freqs: [587, 698, 880], duration: 0.14 },
  gameStart: { type: 'onlineFanfare', freqs: [698, 880, 1047, 1397], duration: 0.22 },
  gameWin: { type: 'onlineFanfare', freqs: [698, 880, 1047, 1397, 1760], duration: 0.3 },
  gameLose: { type: 'onlineDefeat', freqs: [349, 294, 233], duration: 0.4 },
  timerTick: { type: 'onlineBleep', freq: 1200, duration: 0.012 },
  timerWarning: { type: 'onlineAlarm', freq: 1000, duration: 0.08 },
  buttonHover: { type: 'onlineBleep', freq: 1400, duration: 0.012 },
  ready: { type: 'onlineChime', freqs: [587, 698], duration: 0.1 },
  join: { type: 'onlinePing', freq: 698, duration: 0.08 },
  leave: { type: 'onlineZap', freq: 300, duration: 0.1 },
  invite: { type: 'onlineChime', freqs: [1047, 1319], duration: 0.1 },
  endTurn: { type: 'onlineZap', freq: 420, duration: 0.08 },
};

function getActiveStyleMode() {
  return 'online';
}

function getSoundForStyle(soundName) {
  const mode = getActiveStyleMode();
  switch (mode) {
    case 'light': return SOUNDS_LIGHT[soundName] || SOUNDS[soundName];
    case 'cozy': return SOUNDS_COZY[soundName] || SOUNDS[soundName];
    case 'online': return SOUNDS_ONLINE[soundName] || SOUNDS[soundName];
    default: return SOUNDS[soundName];
  }
}

function playSound(soundName) {
  if (!settingsSounds) return;

  const ctx = getAudioContext();
  if (!ctx) return;

  const sound = getSoundForStyle(soundName);
  if (!sound) return;

  const volume = settingsVolume / 100;
  const masterGain = ctx.createGain();
  masterGain.gain.value = volume * 0.3;
  masterGain.connect(ctx.destination);

  const now = ctx.currentTime;

  switch (sound.type) {
    case 'click':
    case 'hover':
    case 'toggle':
    case 'tick':
      playSingleTone(ctx, masterGain, sound.freq, sound.duration, now, sound.wave || 'sine');
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

    // --- Light mode types ---
    case 'lightSwoosh':
      playLightSwoosh(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'lightBell':
      playLightBell(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'lightReveal':
      playLightReveal(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'lightError':
      playLightError(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'lightAssassin':
      playLightAssassin(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'lightDefeat':
      playLightDefeat(ctx, masterGain, sound.freqs, sound.duration, now);
      break;

    // --- Cozy mode types ---
    case 'cozyClick':
      playCozyClick(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyArpeggio':
      playCozyArpeggio(ctx, masterGain, sound.freqs, sound.duration, now);
      break;
    case 'cozyThud':
      playCozyThud(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyWhoosh':
      playCozyWhoosh(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyKnock':
      playCozyKnock(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyFlip':
      playCozyFlip(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyDoom':
      playCozyDoom(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'cozyFanfare':
      playCozyFanfare(ctx, masterGain, sound.freqs, sound.duration, now);
      break;
    case 'cozyDefeat':
      playCozyDefeat(ctx, masterGain, sound.freqs, sound.duration, now);
      break;

    // --- Online mode types ---
    case 'onlineBleep':
      playOnlineBleep(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlineChime':
      playOnlineChime(ctx, masterGain, sound.freqs, sound.duration, now);
      break;
    case 'onlineBuzz':
      playOnlineBuzz(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlineZap':
      playOnlineZap(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlinePing':
      playOnlinePing(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlineSnap':
      playOnlineSnap(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlineAlarm':
      playOnlineAlarm(ctx, masterGain, sound.freq, sound.duration, now);
      break;
    case 'onlineFanfare':
      playOnlineFanfare(ctx, masterGain, sound.freqs, sound.duration, now);
      break;
    case 'onlineDefeat':
      playOnlineDefeat(ctx, masterGain, sound.freqs, sound.duration, now);
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

// ========================================
// LIGHT MODE synthesis functions
// Airy, soft, bell-like
// ========================================

function playLightSwoosh(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 0.7, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 1.5, startTime + duration);
  filter.type = 'bandpass';
  filter.frequency.value = freq * 2;
  filter.Q.value = 2;
  gain.gain.setValueAtTime(0.15, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playLightBell(ctx, destination, freq, duration, startTime) {
  // Two detuned sines for a shimmer bell
  [0, 7].forEach(detune => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    osc.detune.value = detune;
    gain.gain.setValueAtTime(0.25, startTime);
    gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(startTime);
    osc.stop(startTime + duration);
  });
}

function playLightReveal(ctx, destination, freq, duration, startTime) {
  // Rising sine with gentle harmonic
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 0.9, startTime);
  osc.frequency.linearRampToValueAtTime(freq * 1.3, startTime + duration * 0.6);
  osc.frequency.linearRampToValueAtTime(freq * 1.1, startTime + duration);
  gain.gain.setValueAtTime(0.3, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playLightError(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq * 1.2, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, startTime + duration);
  gain.gain.setValueAtTime(0.2, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playLightAssassin(ctx, destination, freq, duration, startTime) {
  // Low hum that fades with a high overtone
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'sine';
  osc1.frequency.setValueAtTime(freq, startTime);
  osc1.frequency.exponentialRampToValueAtTime(freq * 0.5, startTime + duration);
  gain1.gain.setValueAtTime(0.3, startTime);
  gain1.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc1.connect(gain1);
  gain1.connect(destination);
  osc1.start(startTime);
  osc1.stop(startTime + duration);

  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'sine';
  osc2.frequency.value = freq * 6;
  gain2.gain.setValueAtTime(0.08, startTime);
  gain2.gain.exponentialRampToValueAtTime(0.01, startTime + duration * 0.4);
  osc2.connect(gain2);
  gain2.connect(destination);
  osc2.start(startTime);
  osc2.stop(startTime + duration * 0.4);
}

function playLightDefeat(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.7;
    gain.gain.setValueAtTime(0.2, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

// ========================================
// COZY MODE synthesis functions
// Warm, woody, tactile, board-game feel
// ========================================

function playCozyClick(ctx, destination, freq, duration, startTime) {
  // Short triangle burst with subtle body (like tapping wood)
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 1.5, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.6, startTime + duration);
  filter.type = 'lowpass';
  filter.frequency.value = freq * 3;
  filter.Q.value = 1.5;
  gain.gain.setValueAtTime(0.45, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playCozyArpeggio(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.45;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.35, noteStart + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

function playCozyThud(ctx, destination, freq, duration, startTime) {
  // Deep thud - triangle wave dropping fast, like something heavy landing
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 2, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.3, startTime + duration * 0.3);
  gain.gain.setValueAtTime(0.5, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playCozyWhoosh(ctx, destination, freq, duration, startTime) {
  // Filtered noise sweep (like shuffling cards)
  const bufferSize = Math.floor(ctx.sampleRate * duration);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * 0.5;
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.setValueAtTime(freq, startTime);
  filter.frequency.exponentialRampToValueAtTime(freq * 3, startTime + duration);
  filter.Q.value = 0.8;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.2, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  noise.start(startTime);
}

function playCozyKnock(ctx, destination, freq, duration, startTime) {
  // Double tap like knocking on wood
  [0, 0.06].forEach(offset => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq * 1.2, startTime + offset);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, startTime + offset + duration * 0.5);
    const ns = startTime + offset;
    gain.gain.setValueAtTime(0.4, ns);
    gain.gain.exponentialRampToValueAtTime(0.01, ns + duration * 0.5);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(ns);
    osc.stop(ns + duration * 0.5);
  });
}

function playCozyFlip(ctx, destination, freq, duration, startTime) {
  // Card flip: quick noise burst + triangle tone (paper sound)
  const bufferSize = Math.floor(ctx.sampleRate * duration * 0.3);
  const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < bufferSize; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp(-i / (bufferSize * 0.15));
  }
  const noise = ctx.createBufferSource();
  noise.buffer = buffer;
  const nFilter = ctx.createBiquadFilter();
  nFilter.type = 'highpass';
  nFilter.frequency.value = 800;
  const nGain = ctx.createGain();
  nGain.gain.setValueAtTime(0.2, startTime);
  nGain.gain.exponentialRampToValueAtTime(0.01, startTime + duration * 0.3);
  noise.connect(nFilter);
  nFilter.connect(nGain);
  nGain.connect(destination);
  noise.start(startTime);

  // Body tone
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq * 1.4, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.8, startTime + duration);
  gain.gain.setValueAtTime(0.3, startTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime + 0.02);
  osc.stop(startTime + duration);
}

function playCozyDoom(ctx, destination, freq, duration, startTime) {
  // Deep ominous rumble with resonance (assassin)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'triangle';
  osc1.frequency.setValueAtTime(freq * 1.5, startTime);
  osc1.frequency.exponentialRampToValueAtTime(freq * 0.2, startTime + duration);
  gain1.gain.setValueAtTime(0.45, startTime);
  gain1.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc1.connect(gain1);
  gain1.connect(destination);
  osc1.start(startTime);
  osc1.stop(startTime + duration);

  // Resonant body
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  const filter = ctx.createBiquadFilter();
  osc2.type = 'sawtooth';
  osc2.frequency.setValueAtTime(freq * 0.5, startTime);
  osc2.frequency.exponentialRampToValueAtTime(freq * 0.15, startTime + duration);
  filter.type = 'lowpass';
  filter.frequency.value = 180;
  filter.Q.value = 4;
  gain2.gain.setValueAtTime(0.25, startTime);
  gain2.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc2.connect(filter);
  filter.connect(gain2);
  gain2.connect(destination);
  osc2.start(startTime);
  osc2.stop(startTime + duration);
}

function playCozyFanfare(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.35;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.3, noteStart + 0.04);
    gain.gain.setValueAtTime(0.3, noteStart + noteDuration * 0.5);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration * 1.4);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration * 1.4);
  });
}

function playCozyDefeat(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.55;
    gain.gain.setValueAtTime(0.3, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

// ========================================
// CODENAMES ONLINE synthesis functions
// Sharp, digital, arcade-like
// ========================================

function playOnlineBleep(ctx, destination, freq, duration, startTime) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.18, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playOnlineChime(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.35;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.2, noteStart + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration * 0.8);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration * 0.8);
  });
}

function playOnlineBuzz(ctx, destination, freq, duration, startTime) {
  // Harsh square wave descending
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq * 1.5, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.4, startTime + duration);
  gain.gain.setValueAtTime(0.2, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playOnlineZap(ctx, destination, freq, duration, startTime) {
  // Quick frequency sweep (zap/laser)
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(freq * 3, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, startTime + duration);
  gain.gain.setValueAtTime(0.15, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playOnlinePing(ctx, destination, freq, duration, startTime) {
  // Clean digital ping
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.22, startTime);
  gain.gain.setValueAtTime(0.22, startTime + duration * 0.15);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  osc.stop(startTime + duration);
}

function playOnlineSnap(ctx, destination, freq, duration, startTime) {
  // Sharp attack + quick ring (digital card snap)
  const osc1 = ctx.createOscillator();
  const gain1 = ctx.createGain();
  osc1.type = 'square';
  osc1.frequency.setValueAtTime(freq * 4, startTime);
  osc1.frequency.exponentialRampToValueAtTime(freq, startTime + 0.02);
  gain1.gain.setValueAtTime(0.3, startTime);
  gain1.gain.exponentialRampToValueAtTime(0.01, startTime + 0.04);
  osc1.connect(gain1);
  gain1.connect(destination);
  osc1.start(startTime);
  osc1.stop(startTime + 0.04);

  // Body
  const osc2 = ctx.createOscillator();
  const gain2 = ctx.createGain();
  osc2.type = 'triangle';
  osc2.frequency.setValueAtTime(freq * 1.2, startTime + 0.015);
  osc2.frequency.exponentialRampToValueAtTime(freq * 0.8, startTime + duration);
  gain2.gain.setValueAtTime(0.25, startTime + 0.015);
  gain2.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc2.connect(gain2);
  gain2.connect(destination);
  osc2.start(startTime + 0.015);
  osc2.stop(startTime + duration);
}

function playOnlineAlarm(ctx, destination, freq, duration, startTime) {
  // Pulsing square wave alarm
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  osc.type = 'square';
  osc.frequency.setValueAtTime(freq, startTime);
  osc.frequency.exponentialRampToValueAtTime(freq * 0.5, startTime + duration);
  lfo.type = 'square';
  lfo.frequency.value = 12;
  lfoGain.gain.value = 0.15;
  lfo.connect(lfoGain);
  lfoGain.connect(gain.gain);
  gain.gain.setValueAtTime(0.2, startTime);
  gain.gain.exponentialRampToValueAtTime(0.01, startTime + duration);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(startTime);
  lfo.start(startTime);
  osc.stop(startTime + duration);
  lfo.stop(startTime + duration);
}

function playOnlineFanfare(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.28;
    gain.gain.setValueAtTime(0, noteStart);
    gain.gain.linearRampToValueAtTime(0.2, noteStart + 0.008);
    gain.gain.setValueAtTime(0.2, noteStart + noteDuration * 0.4);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration);
  });
}

function playOnlineDefeat(ctx, destination, freqs, noteDuration, startTime) {
  freqs.forEach((freq, i) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'square';
    osc.frequency.value = freq;
    const noteStart = startTime + i * noteDuration * 0.5;
    gain.gain.setValueAtTime(0.18, noteStart);
    gain.gain.exponentialRampToValueAtTime(0.01, noteStart + noteDuration * 0.8);
    osc.connect(gain);
    gain.connect(destination);
    osc.start(noteStart);
    osc.stop(noteStart + noteDuration * 0.8);
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
    // Removed: ripple effect (it reads like a weird "expand" animation in multiple styles)
    // addRippleEffect(btn);
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
window.isStackingEnabled = function isStackingEnabled() {
  return !!settingsStacking;
};

/* =========================
   Online Presence System
========================= */

const PRESENCE_COLLECTION = 'presence';
const PRESENCE_INACTIVE_MS = 5 * 60 * 1000;  // 5 minutes
const PRESENCE_OFFLINE_MS = 15 * 60 * 1000;  // 15 minutes
const PRESENCE_UPDATE_INTERVAL_MS = 60 * 1000; // Update every 1 minute


const PRESENCE_WHERE_LABELS = {
  menus: 'In Multiplayer',
  tournament: 'In Teams',
  lobby: 'In Multiplayer',
  game: 'In Multiplayer',
  practice: 'In Singleplayer'
};

function computeLocalPresenceWhereKey() {
  // Presence "where" should reflect the *active* UI, not just elements that exist in the DOM.
  // Panels are often absolutely positioned, so relying on computed display alone can be misleading.
  const isDisplayed = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    // Treat elements as hidden if display/visibility hide them, or if opacity is effectively 0.
    const op = Number(st.opacity || '1');
    return st.display !== 'none' && st.visibility !== 'hidden' && op > 0.01;
  };

  // 1) If the game board is visible, we're either in lobby (waiting) or actively in a game.
  const gameBoard = document.getElementById('game-board-container');
  if (isDisplayed(gameBoard)) {
    try {
      if (typeof window.isPracticeGameActive === 'function' && window.isPracticeGameActive()) {
        return 'practice';
      }
    } catch (_) {}
    const phase = (typeof window.getCurrentGamePhase === 'function') ? window.getCurrentGamePhase() : null;
    if (phase && phase !== 'waiting') return 'game';
    return 'lobby';
  }

  // 2) Dedicated lobbies (these are explicit containers that flip display on/off)
  const tournamentLobby = document.getElementById('tournament-lobby');
  if (isDisplayed(tournamentLobby)) return 'tournament';

  const quickLobby = document.getElementById('quick-play-lobby');
  if (isDisplayed(quickLobby)) return 'lobby';

  // 3) Otherwise, use mode + active panel as the source of truth.
  // Tournament mode: any non-gameboard view is "In Tournament".
  if (document.body.classList.contains('tournament')) {
    return 'tournament';
  }

  // Quick play mode: outside the gameboard/lobby we treat as menus.
  if (document.body.classList.contains('quickplay')) {
    return 'menus';
  }

  // 4) Launch / home menus (mode selection visible)
  const modeSelect = document.getElementById('play-mode-select');
  if (isDisplayed(modeSelect)) return 'menus';

  return 'menus';
}

function getPresencePanelLabel(presence) {
  const panelId = String(presence?.activePanelId || '').trim();
  const whereKey = String(presence?.whereKey || presence?.where || '').trim();
  if (!panelId) return '';
  if (panelId === 'panel-practice') return 'In Singleplayer';
  if (panelId === 'panel-brackets') return 'In Brackets';
  if (panelId === 'panel-teams' || panelId === 'panel-home' || panelId === 'panel-myteam') return 'In Teams';
  if (panelId === 'panel-game' && whereKey === 'practice') return 'In Singleplayer';
  if (panelId === 'panel-game') return 'In Multiplayer';
  return '';
}

function getPresenceWhereLabel(presenceOrUserId) {
  const presence = resolvePresenceArg(presenceOrUserId);
  if (!presence) return '';

  const byPanel = getPresencePanelLabel(presence);
  if (byPanel) return byPanel;

  const key = (presence.whereKey || presence.where || '').toString().trim();
  if (key) return PRESENCE_WHERE_LABELS[key] || key;

  // Legacy docs may only have a freeform whereLabel.
  const legacy = String(presence.whereLabel || '').trim();
  if (!legacy) return '';
  if (/tournament/i.test(legacy)) return 'In Teams';
  if (/(menu|lobby|game)/i.test(legacy)) return 'In Multiplayer';
  return legacy;
}

// Expose for game.js or other modules
window.getPresenceWhereLabel = getPresenceWhereLabel;

// Debounced helper: bump presence after UI state changes
window.bumpPresence = throttle(() => {
  try { updatePresence(); } catch (_) {}
}, 3000);

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
    const whereKey = computeLocalPresenceWhereKey();
    await presenceRef.set({
      odId: userId,
      name: name,
      whereKey: whereKey,
      whereLabel: PRESENCE_WHERE_LABELS[whereKey] || whereKey,
      activePanelId: activePanelId,
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

function initUsernamesRegistryListener() {
  // This registry is readable even before login (so usernames can be checked and listed).
  // We keep a live cache so "Who's Online" can show all known accounts.
  if (usernamesUnsub) return;
  try {
    usernamesUnsub = db.collection('usernames').onSnapshot((snap) => {
      usernamesCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      // Update Personal chat recipient list (best-effort)
      try { refreshPersonalChatSelect(); } catch (_) {}
      // Re-render online widgets if open.
      try { renderOnlineCounter(); } catch (_) {}
      try {
        const modal = document.getElementById('online-modal');
        if (modal && modal.style.display === 'flex') renderOnlineUsersList();
      } catch (_) {}
    }, (err) => {
      console.warn('Usernames registry listener error:', err);
    });
  } catch (e) {
    console.warn('Failed to start usernames registry listener (best-effort):', e);
  }
}

function stopUsernamesRegistryListener() {
  if (usernamesUnsub) {
    try { usernamesUnsub(); } catch (_) {}
    usernamesUnsub = null;
  }
}

function resolvePresenceArg(arg) {
  if (!arg) return null;
  // Allow callers to pass a userId string.
  if (typeof arg === 'string') {
    const uid = String(arg || '').trim();
    if (!uid) return null;
    return presenceCache.find(p => p?.id === uid || p?.odId === uid) || null;
  }
  // If they passed a presence doc object, use it as-is.
  return arg;
}

function tsToMsSafe(ts) {
  if (!ts) return 0;
  // Firestore Timestamp
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  // Some Timestamp shapes expose seconds / nanoseconds
  if (typeof ts.seconds === 'number') return ts.seconds * 1000;
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  // Sometimes stored as number (ms)
  if (typeof ts === 'number') return ts;
  return 0;
}

function getPresenceStatus(presenceOrUserId) {
  const presence = resolvePresenceArg(presenceOrUserId);
  // Support older presence docs that may not have `lastActivity`.
  const ts = presence?.lastActivity || presence?.updatedAt || presence?.lastSeen || null;
  if (!ts) return 'offline';

  const lastMs = tsToMsSafe(ts);
  if (!lastMs) return 'offline';

  const now = Date.now();
  const diff = now - lastMs;

  if (diff < PRESENCE_INACTIVE_MS) return 'online';
  // Rename "inactive" to "idle" in the UI/status model.
  if (diff < PRESENCE_OFFLINE_MS) return 'idle';
  return 'offline';
}

function getTimeSinceActivity(presenceOrUserId) {
  const presence = resolvePresenceArg(presenceOrUserId);
  const ts = presence?.lastActivity || presence?.updatedAt || presence?.lastSeen || null;
  if (!ts) return '';

  const lastMs = tsToMsSafe(ts);
  if (!lastMs) return '';

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


function getAllKnownAccounts() {
  // Build a unified list of accounts using:
  // - /usernames registry (authoritative username list)
  // - presence docs (for status + activity)
  // - playersCache (fallback display names)
  //
  // Result items look like presence docs so existing render logic works.
  const byUid = new Map();

  // 1) Seed from username registry (shows all accounts even if offline).
  for (const u of (usernamesCache || [])) {
    const username = String(u?.id || '').trim(); // doc id is the username
    const uid = String(u?.uid || '').trim();
    if (!uid || !username) continue;
    if (!byUid.has(uid)) {
      byUid.set(uid, { id: uid, odId: uid, name: username });
    } else {
      const cur = byUid.get(uid);
      if (!cur.name) cur.name = username;
    }
  }

  // 2) Merge in players (some older flows may have profiles without registry).
  for (const p of (playersCache || [])) {
    const uid = String(p?.id || '').trim();
    if (!uid) continue;
    const nm = String(p?.name || '').trim();
    if (!byUid.has(uid)) byUid.set(uid, { id: uid, odId: uid, name: nm || 'Unknown' });
    else if (nm && !String(byUid.get(uid)?.name || '').trim()) byUid.get(uid).name = nm;
  }

  // 3) Merge in presence (status/activity + location).
  for (const pr of (presenceCache || [])) {
    const uid = String(pr?.id || pr?.odId || '').trim();
    if (!uid) continue;
    const base = byUid.get(uid) || { id: uid, odId: uid, name: String(pr?.name || '').trim() || 'Unknown' };
    // Copy presence fields onto the object so getPresenceStatus works.
    base.lastActivity = pr?.lastActivity || pr?.updatedAt || pr?.lastSeen || null;
    base.updatedAt = pr?.updatedAt || null;
    base.whereKey = pr?.whereKey || pr?.where || '';
    base.whereLabel = pr?.whereLabel || '';
    base.activePanelId = pr?.activePanelId || '';
    if (String(pr?.name || '').trim()) base.name = String(pr.name).trim();
    byUid.set(uid, base);
  }

  return Array.from(byUid.values());
}

function renderOnlineCounter() {
  const countEl = document.getElementById('online-count');
  const authCountEl = document.getElementById('auth-online-count');
  if (!countEl) return;

  const all = getAllKnownAccounts();
  const online = all.filter(p => getPresenceStatus(p) === 'online');
  countEl.textContent = online.length;
  if (authCountEl) authCountEl.textContent = String(online.length);
}

function initOnlineCounterUI() {
  const btn = document.getElementById('online-counter-btn');
  const modal = document.getElementById('online-modal');
  const backdrop = document.getElementById('online-modal-backdrop');
  const closeBtn = document.getElementById('online-modal-close');

  if (!btn || !modal) return;

  // No static legend text here (the app determines location/status automatically).

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


// (isAdminUser defined near the top)

function initOnlineAdminDeleteHandlers(listEl) {
  if (!listEl || listEl.dataset.adminDeleteBound) return;
  listEl.dataset.adminDeleteBound = '1';

  listEl.addEventListener('click', async (e) => {
    const btn = e.target.closest('.online-user-delete');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();

    if (!isAdminUser()) return;

    const uid = String(btn.getAttribute('data-delete-user') || '').trim();
    const name = String(btn.getAttribute('data-delete-name') || '').trim();
    if (!uid) return;

    playSound('click');
    const label = name || uid;
    const ok = await showCustomConfirm({
      title: 'Delete user?',
      message: `Delete user "${label}"?<br><br>This will remove them from teams and clear their profile/presence.`,
      okText: 'Delete',
      danger: true
    });
    if (!ok) return;

    try {
      await adminDeleteUser(uid, name);
    } catch (err) {
      console.warn('Admin delete failed:', err);
    }
  }, true);
}

async function adminDeleteUser(userId, displayName) {
  if (!isAdminUser()) return;
  const uid = String(userId || '').trim();
  if (!uid) return;

  // 1) Remove from presence (so they disappear from Who's Online)
  try { await db.collection(PRESENCE_COLLECTION).doc(uid).delete(); } catch (_) {}

  // 2) Remove player + user profile
  try { await db.collection('players').doc(uid).delete(); } catch (_) {}
  try { await db.collection('users').doc(uid).delete(); } catch (_) {}

  // 3) Remove from all teams (and transfer ownership / delete empty teams if needed)
  const teams = Array.isArray(teamsCache) ? teamsCache.slice() : [];
  for (const t of teams) {
    const teamId = String(t?.id || '').trim();
    if (!teamId) continue;
    try { await adminRemoveUserFromTeam(teamId, uid); } catch (_) {}
  }

  // 4) Delete personal DM threads involving this user (best-effort)
  try {
    const threadsSnap = await db.collection('dmThreads').where('participants', 'array-contains', uid).get();
    for (const th of threadsSnap.docs) {
      const threadId = th.id;
      // Delete messages in chunks
      while (true) {
        const ms = await db.collection('dmThreads').doc(threadId).collection('messages').limit(250).get();
        if (ms.empty) break;
        const batch = db.batch();
        ms.docs.forEach(d => batch.delete(d.ref));
        await batch.commit();
      }
      await th.ref.delete();
    }
  } catch (e) {
    // best-effort
  }

  // 5) Delete username registry docs for this uid so the username(s) become available
  try {
    const names = new Set();
    // Prefer cache
    try {
      for (const r of (usernamesCache || [])) {
        const rUid = String(r?.uid || '').trim();
        const nm = String(r?.id || '').trim();
        if (rUid && rUid === uid && nm) names.add(nm);
      }
    } catch (_) {}

    // If empty, query directly
    if (names.size === 0) {
      const q = await db.collection('usernames').where('uid', '==', uid).get();
      q.docs.forEach(d => names.add(String(d.id || '').trim()));
    }

    // Last resort: try displayName if it's a plausible username
    const dn = normalizeUsername(displayName || '');
    if (dn && isValidUsername(dn)) names.add(dn);

    for (const nm of names) {
      if (!nm) continue;
      const ref = db.collection('usernames').doc(nm);
      try {
        await db.runTransaction(async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists) return;
          const data = snap.data() || {};
          const owner = String(data.uid || '').trim();
          if (owner && owner === uid) tx.delete(ref);
        });
      } catch (_) {}
    }
  } catch (_) {}

  // Re-render online modal if it's open
  try {
    const modal = document.getElementById('online-modal');
    if (modal && modal.style.display === 'flex') renderOnlineUsersList();
  } catch (_) {}

  // Notify (best-effort)
  try {
    showSystemDialog({ title: 'User deleted', message: 'The account has been removed and the username is now available.' });
  } catch (_) {}
}

async function adminRemoveUserFromTeam(teamId, userId) {
  if (!isAdminUser()) return;
  const tid = String(teamId || '').trim();
  const uid = String(userId || '').trim();
  if (!tid || !uid) return;

  const ref = db.collection('teams').doc(tid);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return;

    const t = { id: snap.id, ...snap.data() };
    const members = getMembers(t);
    const pending = getPending(t);

    const newMembers = members.filter(m => !isSameAccount(m, uid));
    const newPending = pending.filter(p => !isSameAccount(p, uid));

    const creatorId = getTeamCreatorAccountId(t);
    const wasCreator = !!(creatorId && String(creatorId).trim() === uid);

    // No changes needed
    if (!wasCreator && newMembers.length === members.length && newPending.length === pending.length) return;

    // If the deleted user owned the team, either transfer to first remaining member or delete the team if empty
    if (wasCreator) {
      if (newMembers.length === 0) {
        tx.delete(ref);
        return;
      }
      const next = newMembers[0];
      const nextId = entryAccountId(next);
      const nextName = String(next?.name || '').trim();
      tx.update(ref, {
        members: newMembers,
        pending: newPending,
        creatorUserId: nextId || '',
        creatorName: nextName || '—',
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      });
      return;
    }

    tx.update(ref, {
      members: newMembers,
      pending: newPending,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  });
}


function renderOnlineUsersList() {
  const listEl = document.getElementById('online-users-list');
  if (!listEl) return;

  const myId = getUserId();
  const isAdmin = isAdminUser();

  initOnlineAdminDeleteHandlers(listEl);

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
  let filtered = getAllKnownAccounts();
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
    const aMs = tsToMsSafe(a?.lastActivity || a?.updatedAt || a?.lastSeen || 0);
    const bMs = tsToMsSafe(b?.lastActivity || b?.updatedAt || b?.lastSeen || 0);
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
      const teamName = memberTeam ? truncateTeamName(memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = memberTeam ? ` <span class="online-user-team-inline profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}">(${esc(teamName)})</span>` : '';
      const canDelete = isAdmin && !isYou && uid;
      const delBtn = canDelete ? `<button class="online-user-delete" type="button" title="Delete user" aria-label="Delete user" data-delete-user="${esc(uid)}" data-delete-name="${esc(displayName)}">×</button>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot online"></div>
          <div class="online-user-name profile-link" data-profile-type="player" data-profile-id="${esc(uid)}" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">${esc(p.corrupted ? 'Corrupted' : (getPresenceWhereLabel(p) || 'Active'))}</div>
          ${delBtn}
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
      const teamName = memberTeam ? truncateTeamName(memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = memberTeam ? ` <span class="online-user-team-inline profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}">(${esc(teamName)})</span>` : '';
      const canDelete = isAdmin && !isYou && uid;
      const delBtn = canDelete ? `<button class="online-user-delete" type="button" title="Delete user" aria-label="Delete user" data-delete-user="${esc(uid)}" data-delete-name="${esc(displayName)}">×</button>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot inactive"></div>
          <div class="online-user-name profile-link" data-profile-type="player" data-profile-id="${esc(uid)}" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">${esc(getPresenceWhereLabel(p) || 'Idle')} • ${getTimeSinceActivity(p)}</div>
          ${delBtn}
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
      const teamName = memberTeam ? truncateTeamName(memberTeam.teamName || 'Team') : null;
      const teamColor = memberTeam ? getDisplayTeamColor(memberTeam) : null;
      const nameStyle = teamColor ? `style="color:${esc(teamColor)}"` : '';
      const teamSuffix = memberTeam ? ` <span class="online-user-team-inline profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}">(${esc(teamName)})</span>` : '';
      const canDelete = isAdmin && !isYou && uid;
      const delBtn = canDelete ? `<button class="online-user-delete" type="button" title="Delete user" aria-label="Delete user" data-delete-user="${esc(uid)}" data-delete-name="${esc(displayName)}">×</button>` : '';

      html += `
        <div class="online-user-row${isYou ? ' is-you' : ''}">
          <div class="online-user-dot offline"></div>
          <div class="online-user-name profile-link" data-profile-type="player" data-profile-id="${esc(uid)}" ${nameStyle}>${esc(displayName)}${teamSuffix}</div>
          <div class="online-user-status">${esc(p.corrupted ? 'Corrupted' : ('last seen ' + (getTimeSinceActivity(p) || 'never')))}</div>
          ${delBtn}
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
  const hintEl = document.getElementById('name-change-hint');

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
    const raw = String(input?.value || '');
    const newName = normalizeUsername(raw);
    if (!newName) return;

    // From here on we always close the change-name modal and show a single
    // OK dialog with the outcome (success / taken / already your name).
    const closeAndNotify = async (title, message) => {
      try { closeNameChangeModal(); } catch (_) {}
      // Give the close animation a beat so the dialogs don't overlap visually.
      await new Promise((r) => setTimeout(r, 240));
      try {
        await showSystemDialog({ title, message, okText: 'OK' });
      } catch (_) {}
    };

    if (!isValidUsername(newName)) {
      await closeAndNotify('Invalid name', 'Use 3–20 characters: a–z, 0–9, _.');
      return;
    }

    playSound('click');

    // Detect the canonical current name so "already your name" works even if
    // auth.displayName is stale on this device.
    let currentCanonical = normalizeUsername(getUserName());
    try {
      const uid = String(getUserId() || '').trim();
      if (uid) {
        const resolved = await resolveUsernameForUid(uid);
        if (resolved) currentCanonical = normalizeUsername(resolved);
      }
    } catch (_) {}

    if (currentCanonical && currentCanonical === newName) {
      await closeAndNotify('No changes', "That's already your name.");
      return;
    }

    try {
      const res = await setUserName(newName);

      // If it normalized to the same name, don't pretend we changed it.
      if (!res || res.changed === false) {
        await closeAndNotify('No changes', "That's already your name.");
        return;
      }

      // Make sure visible UI updates without a page reload.
      try { refreshNameUI(); } catch (_) {}

      await closeAndNotify('Name updated', `Your name is now "${newName}".`);
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('USERNAME_TAKEN')) {
        await closeAndNotify('Name taken', 'That name is already taken. Please choose a different one.');
      } else if (msg.includes('USERNAME_CONFLICT')) {
        await closeAndNotify('Rename failed', 'Could not rename right now. Please try again.');
      } else {
        await closeAndNotify('Rename failed', msg || 'Could not update name.');
      }
    } finally {
      // Reset hint text for next time the modal is opened.
      try { if (hintEl) hintEl.textContent = '3–20 chars (a–z, 0–9, _)'; } catch (_) {}
    }
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
  const hintEl = document.getElementById('name-change-hint');
  const form = document.getElementById('name-change-form');
  if (!modal) return;

  // Reset disabled state + hint in case we just renamed.
  try { if (input) input.disabled = false; } catch (_) {}
  try {
    const btn = form?.querySelector('button[type="submit"]');
    if (btn) btn.disabled = false;
  } catch (_) {}
  try { if (hintEl) hintEl.textContent = '3–20 chars (a–z, 0–9, _)'; } catch (_) {}

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
   Password Change Modal
   - Firebase requires recent sign-in to update passwords, so we re-auth using
     the current password.
========================= */
function initPasswordChangeModal() {
  const modal = document.getElementById('password-change-modal');
  const backdrop = document.getElementById('password-change-modal-backdrop');
  const closeBtn = document.getElementById('password-change-modal-close');
  const form = document.getElementById('password-change-form');
  const currentInput = document.getElementById('password-current-input');
  const newInput = document.getElementById('password-new-input');
  const confirmInput = document.getElementById('password-confirm-input');
  const hintEl = document.getElementById('password-change-hint');

  if (!modal) return;

  const setHint = (msg) => { if (hintEl) hintEl.textContent = String(msg || ''); };

  const close = () => {
    modal.classList.remove('modal-open');
    setTimeout(() => {
      if (!modal.classList.contains('modal-open')) {
        modal.style.display = 'none';
      }
    }, 200);
  };

  closeBtn?.addEventListener('click', () => { playSound('click'); close(); });
  backdrop?.addEventListener('click', () => { playSound('click'); close(); });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const u = auth.currentUser;
    if (!u) {
      setHint('You need to be logged in.');
      return;
    }

    const currentPass = String(currentInput?.value || '');
    const newPass = String(newInput?.value || '');
    const confirmPass = String(confirmInput?.value || '');

    if (!currentPass || !newPass) {
      setHint('Enter your current password and a new password.');
      return;
    }
    if (newPass !== confirmPass) {
      setHint('New passwords do not match.');
      return;
    }

    try {
      playSound('click');
      setHint('');
      showAuthLoadingScreen('Updating password');

      // Re-authenticate (required by Firebase for sensitive actions).
      const identifier = String(u.email || '');
      if (!identifier) throw new Error('Missing identifier');
      const cred = firebase.auth.EmailAuthProvider.credential(identifier, passwordForAuth(currentPass));
      await u.reauthenticateWithCredential(cred);

      await u.updatePassword(passwordForAuth(newPass));

      setHint('Password updated.');
      playSound('success');
      // Clear fields
      if (currentInput) currentInput.value = '';
      if (newInput) newInput.value = '';
      if (confirmInput) confirmInput.value = '';

      // Close shortly after success so the user sees confirmation.
      setTimeout(() => close(), 500);
    } catch (err) {
      console.warn('Password update failed', err);
      const code = String(err?.code || '');
      if (code.includes('auth/wrong-password')) {
        setHint('Current password is incorrect.');
      } else if (code.includes('auth/too-many-requests')) {
        setHint('Too many attempts. Try again in a bit.');
      } else {
        setHint('Could not update password. Please try again.');
      }
    } finally {
      hideAuthLoadingScreen();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.style.display === 'flex') {
      close();
    }
  });
}

function openPasswordChangeModal() {
  const modal = document.getElementById('password-change-modal');
  const hintEl = document.getElementById('password-change-hint');
  if (!modal) return;
  if (!auth.currentUser) {
    try { showAuthScreen(); } catch (_) {}
    return;
  }
  if (hintEl) hintEl.textContent = '';
  modal.style.display = 'flex';
  void modal.offsetWidth;
  modal.classList.add('modal-open');
  setTimeout(() => document.getElementById('password-current-input')?.focus?.(), 100);
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
  const isAdmin = isAdminUser();

  initOnlineAdminDeleteHandlers(listEl);

  const roster = buildRosterIndex(teamsCache);

  if (!st.team) {
    if (titleEl) titleEl.textContent = 'My Team';
    if (hintEl) hintEl.textContent = 'You are not on a team yet.';
    listEl.innerHTML = '';
    return;
  }

  const team = st.team;
  if (titleEl) titleEl.textContent = truncateTeamName(team.teamName || 'My Team');
  if (hintEl) hintEl.textContent = '';

  const members = team.members || [];
  const ownerId = team.creatorUserId;

  let html = '';
  for (const member of members) {
    const isYou = member.userId === myId;
    const isOwner = member.userId === ownerId;
    const initial = (member.name || '?').charAt(0).toUpperCase();
    const memberId = entryAccountId(member);

    html += `
      <div class="teammate-row${isYou ? ' is-you' : ''}${isOwner ? ' is-owner' : ''}">
        <div class="teammate-avatar">${esc(initial)}</div>
        <div class="teammate-info">
          <div class="teammate-name profile-link" data-profile-type="player" data-profile-id="${esc(memberId)}">${esc(member.name || 'Unknown')}${isYou ? ' (you)' : ''}</div>
        </div>
      </div>
    `;
  }

  if (!html) {
    html = '<div class="hint">No teammates yet.</div>';
  }

  listEl.innerHTML = html;
}

// Track whether presence has been initialized for this session
let presenceInitialized = false;

// Initialize presence when name is set
const originalSetUserName = setUserName;
window.setUserNameWithPresence = async function(name, opts) {
  await originalSetUserName(name, opts);
  if (getUserName() && !presenceInitialized) {
    presenceInitialized = true;
    initPresence();
  }
};

// Override setUserName to also init presence
setUserName = async function(name, opts) {
  await originalSetUserName.call(this, name, opts);
  if (getUserName() && !presenceInitialized) {
    presenceInitialized = true;
    initPresence();
  }
};

// Show the auth loading screen with optional custom message.
// Uses a simple ref-count so the loader stays up across overlapping async tasks
// (prevents "flash" transitions where a page appears briefly then re-loads).
let _authLoadingCount = 0;
let _authLoadingLastMessage = 'Loading';

// Update the loader message without incrementing the ref-count.
// Used during boot because the loader is already shown from init(), and calling
// showAuthLoadingScreen() again would double-increment and keep the loader up forever.
function setAuthLoadingMessage(message = 'Loading') {
  if (message) _authLoadingLastMessage = String(message);
  const desktopMsgs = document.querySelectorAll('[data-auth-loading-message="desktop"]');
  const mobileMsgs = document.querySelectorAll('[data-auth-loading-message="mobile"]');
  desktopMsgs.forEach(el => { try { el.textContent = _authLoadingLastMessage; } catch (_) {} });
  mobileMsgs.forEach(el => { try { el.textContent = _authLoadingLastMessage; } catch (_) {} });
  const screen = document.getElementById('auth-loading-screen');
  if (screen) {
    screen.style.display = 'flex';
    screen.classList.remove('hidden');
  }
}

function showAuthLoadingScreen(message = 'Loading') {
  _authLoadingCount = Math.max(0, (_authLoadingCount | 0) + 1);
  if (message) _authLoadingLastMessage = String(message);
  const screen = document.getElementById('auth-loading-screen');
  const desktopMsgs = document.querySelectorAll('[data-auth-loading-message="desktop"]');
  const mobileMsgs = document.querySelectorAll('[data-auth-loading-message="mobile"]');

  desktopMsgs.forEach(el => { try { el.textContent = _authLoadingLastMessage; } catch (_) {} });
  mobileMsgs.forEach(el => { try { el.textContent = _authLoadingLastMessage; } catch (_) {} });

  if (screen) {
    screen.style.display = 'flex';
    screen.classList.remove('hidden');
  }
}

// Hide the auth loading screen with a fade transition
function hideAuthLoadingScreen() {
  _authLoadingCount = Math.max(0, (_authLoadingCount | 0) - 1);
  if (_authLoadingCount > 0) return;
  const screen = document.getElementById('auth-loading-screen');
  if (screen) {
    screen.classList.add('hidden');
  }
}

/* =========================
   Custom Confirm Dialog
========================= */
let confirmDialogResolve = null;

// Show confirm dialog for "continue as player" (sign-in existing account)
function showConfirmDialog(name) {
  return showCustomConfirm({
    title: 'Continue as this player?',
    message: `This name is already taken. Continue to log in as "${name}"?`,
    okText: 'Continue',
    cancelText: 'Cancel',
    danger: false
  });
}

// Generic custom confirm dialog - replaces window.confirm
function showCustomConfirm(options = {}) {
  const {
    title = 'Confirm',
    message = 'Are you sure?',
    okText = 'OK',
    cancelText = 'Cancel',
    danger = false
  } = options;

  return new Promise((resolve) => {
    confirmDialogResolve = resolve;
    const backdrop = document.getElementById('confirm-dialog-backdrop');
    const dialog = document.getElementById('confirm-dialog');
    const titleEl = document.getElementById('confirm-dialog-title');
    const messageEl = document.getElementById('confirm-dialog-message');
    const okBtn = document.getElementById('confirm-dialog-ok');
    const cancelBtn = document.getElementById('confirm-dialog-cancel');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.innerHTML = message;
    if (okBtn) {
      okBtn.textContent = okText;
      okBtn.classList.toggle('danger', danger);
      okBtn.classList.toggle('primary', !danger);
    }
    if (cancelBtn) cancelBtn.textContent = cancelText;

    if (backdrop) backdrop.classList.remove('hidden');
    if (dialog) dialog.classList.remove('hidden');

    // Focus the ok button for accessibility
    setTimeout(() => {
      okBtn?.focus();
    }, 100);
  });
}

function hideConfirmDialog(result) {
  const backdrop = document.getElementById('confirm-dialog-backdrop');
  const dialog = document.getElementById('confirm-dialog');

  if (backdrop) backdrop.classList.add('hidden');
  if (dialog) dialog.classList.add('hidden');

  if (confirmDialogResolve) {
    confirmDialogResolve(result);
    confirmDialogResolve = null;
  }
}

function initConfirmDialog() {
  const cancelBtn = document.getElementById('confirm-dialog-cancel');
  const okBtn = document.getElementById('confirm-dialog-ok');
  const backdrop = document.getElementById('confirm-dialog-backdrop');

  cancelBtn?.addEventListener('click', () => hideConfirmDialog(false));
  okBtn?.addEventListener('click', () => hideConfirmDialog(true));
  backdrop?.addEventListener('click', () => hideConfirmDialog(false));

  // Handle escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && confirmDialogResolve) {
      hideConfirmDialog(false);
    }
  });
}

/* =========================
   System Message Dialog
   (replaces window.alert for account issues)
========================= */
let systemDialogResolve = null;

function showSystemDialog(options = {}) {
  const {
    title = 'Notice',
    message = '',
    okText = 'OK',
  } = options;

  return new Promise((resolve) => {
    systemDialogResolve = resolve;
    const backdrop = document.getElementById('system-dialog-backdrop');
    const dialog = document.getElementById('system-dialog');
    const titleEl = document.getElementById('system-dialog-title');
    const messageEl = document.getElementById('system-dialog-message');
    const okBtn = document.getElementById('system-dialog-ok');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (okBtn) okBtn.textContent = okText;

    backdrop?.classList.remove('hidden');
    dialog?.classList.remove('hidden');
    setTimeout(() => okBtn?.focus(), 100);
  });
}

function hideSystemDialog() {
  const backdrop = document.getElementById('system-dialog-backdrop');
  const dialog = document.getElementById('system-dialog');
  backdrop?.classList.add('hidden');
  dialog?.classList.add('hidden');
  if (systemDialogResolve) {
    systemDialogResolve(true);
    systemDialogResolve = null;
  }
}

function initSystemDialog() {
  const okBtn = document.getElementById('system-dialog-ok');
  const backdrop = document.getElementById('system-dialog-backdrop');
  okBtn?.addEventListener('click', hideSystemDialog);
  backdrop?.addEventListener('click', hideSystemDialog);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && systemDialogResolve) hideSystemDialog();
  });
}

/* =========================
   Password Prompt Dialog
   (replaces window.prompt)
========================= */
let passwordDialogResolve = null;

function showPasswordDialog(options = {}) {
  const {
    title = 'Confirm password',
    message = 'Enter your password to continue.',
    okText = 'Continue',
    cancelText = 'Cancel'
  } = options;

  return new Promise((resolve) => {
    passwordDialogResolve = resolve;
    const backdrop = document.getElementById('password-dialog-backdrop');
    const dialog = document.getElementById('password-dialog');
    const titleEl = document.getElementById('password-dialog-title');
    const messageEl = document.getElementById('password-dialog-message');
    const inputEl = document.getElementById('password-dialog-input');
    const okBtn = document.getElementById('password-dialog-ok');
    const cancelBtn = document.getElementById('password-dialog-cancel');

    if (titleEl) titleEl.textContent = title;
    if (messageEl) messageEl.textContent = message;
    if (okBtn) okBtn.textContent = okText;
    if (cancelBtn) cancelBtn.textContent = cancelText;
    if (inputEl) inputEl.value = '';

    backdrop?.classList.remove('hidden');
    dialog?.classList.remove('hidden');

    setTimeout(() => inputEl?.focus(), 80);
  });
}

function hidePasswordDialog(result) {
  const backdrop = document.getElementById('password-dialog-backdrop');
  const dialog = document.getElementById('password-dialog');
  backdrop?.classList.add('hidden');
  dialog?.classList.add('hidden');
  if (passwordDialogResolve) {
    passwordDialogResolve(result);
    passwordDialogResolve = null;
  }
}

function initPasswordDialog() {
  const backdrop = document.getElementById('password-dialog-backdrop');
  const dialog = document.getElementById('password-dialog');
  if (!dialog) return;
  const inputEl = document.getElementById('password-dialog-input');
  const okBtn = document.getElementById('password-dialog-ok');
  const cancelBtn = document.getElementById('password-dialog-cancel');
  const toggleBtn = document.getElementById('password-dialog-toggle');

  // Passwords are always visible.
  try { if (inputEl && inputEl.type === 'password') inputEl.type = 'text'; } catch (_) {}
  try { if (toggleBtn) toggleBtn.style.display = 'none'; } catch (_) {}

  const confirm = () => {
    const val = String(inputEl?.value || '');
    hidePasswordDialog(val);
  };
  okBtn?.addEventListener('click', confirm);
  cancelBtn?.addEventListener('click', () => hidePasswordDialog(null));
  backdrop?.addEventListener('click', () => hidePasswordDialog(null));

  inputEl?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      confirm();
    }
    if (e.key === 'Escape' && passwordDialogResolve) {
      e.preventDefault();
      hidePasswordDialog(null);
    }
  });

  // (Eye toggle removed)
}

/* =========================
   Password Visibility Toggles (Auth forms)
========================= */
function initPasswordVisibilityToggles() {
  // Passwords are intentionally always visible (no eye toggles).
  const inputIds = [
    'launch-password-login',
    'launch-password-create',
    'password-dialog-input',
    'password-current-input',
    'password-new-input',
    'password-confirm-input',
    'password-change-current',
    'password-change-new',
    'password-change-confirm',
  ];

  for (const id of inputIds) {
    const input = document.getElementById(id);
    if (!input) continue;
    if (input.type === 'password') input.type = 'text';
  }

  // Hide any legacy toggle buttons if they exist.
  const btnIds = ['pw-toggle-login', 'pw-toggle-create', 'password-dialog-toggle'];
  for (const id of btnIds) {
    const btn = document.getElementById(id);
    if (btn) btn.style.display = 'none';
  }
}

/* =========================
   Who's Online button on Auth screen
========================= */
function initAuthOnlineButton() {
  const btn = document.getElementById('auth-whos-online-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    playSound('click');
    openOnlineModal();
  });
}

// Verify the user's account on page load before starting presence.
// This resolves the canonical account ID for the stored name, preventing
// presence from being written under a stale device ID.
async function verifyAccountAndInitPresence() {
  const storedName = getUserName();

  // No stored name - nothing to verify, hide loading screen immediately
  if (!storedName) {
    hideAuthLoadingScreen();
    return;
  }

  // Show loading screen while we verify
  showAuthLoadingScreen('Signing in');

  try {
    const nameKey = nameToAccountId(storedName);
    if (!nameKey) {
      // Invalid name, just proceed
      hideAuthLoadingScreen();
      return;
    }

    const myDeviceId = getLocalAccountId();
    const namesCol = db.collection(NAME_REGISTRY_COLLECTION);
    const nameDoc = await namesCol.doc(nameKey).get();

    if (nameDoc.exists) {
      const canonicalAccountId = String(nameDoc.data()?.accountId || '').trim();

      // If the name belongs to a different account, migrate silently
      if (canonicalAccountId && canonicalAccountId !== myDeviceId) {
        // Migrate identity (this also cleans up old presence doc)
        try {
          await migrateIdentity(myDeviceId, canonicalAccountId, storedName);
        } catch (e) {
          console.warn('Identity migration during verification failed (best-effort)', e);
        }
        // Update local storage to use the canonical account
        safeLSSet(LS_USER_ID, canonicalAccountId);
      }
    }

    // Now that we've verified/migrated, start presence with the correct ID
    if (!presenceInitialized) {
      presenceInitialized = true;
      initPresence();
    }

    // Also ensure profile sync is active
    startProfileNameSync();

  } catch (e) {
    console.warn('Account verification failed (best-effort), starting presence anyway', e);
    // Even if verification fails, start presence to maintain functionality
    if (!presenceInitialized) {
      presenceInitialized = true;
      initPresence();
    }
  }

  // Hide loading screen after verification completes
  hideAuthLoadingScreen();
}

// Presence boot is now started from the Firebase Auth gate (initAuthGate)
// so we don't hide the loading screen early (prevents auth-page flashes).

// Export presence functions for game.js
window.getPresenceStatus = getPresenceStatus;
Object.defineProperty(window, 'presenceCache', {
  get: function() { return presenceCache; },
  configurable: true
});
window.updatePresence = updatePresence;

/* =========================
   Profile Popup System
========================= */
let profilePopupTimeout = null;
let currentProfileType = null; // 'team' | 'player'
let currentProfileId = null;

function initProfilePopup() {
  const popup = document.getElementById('profile-popup');
  const backdrop = document.getElementById('profile-popup-backdrop');
  const closeBtn = document.getElementById('profile-popup-close');

  if (closeBtn) {
    closeBtn.addEventListener('click', hideProfilePopup);
  }

  if (backdrop) {
    backdrop.addEventListener('click', hideProfilePopup);
  }


  // Clicking anywhere outside the popup card should dismiss (mobile + desktop).
  // (Keeps "X" + Escape behavior, but removes the need to hunt for it.)
  if (popup) {
    popup.addEventListener('click', (e) => {
      const card = popup.querySelector('.profile-popup-card');
      if (card && !card.contains(e.target)) {
        hideProfilePopup();
      }
    });
  }

  // Close on escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && popup?.style.display !== 'none') {
      hideProfilePopup();
    }
  });

  // Desktop + mobile: click anywhere outside the popup card dismisses it.
  // (We use a document-level handler because on desktop the popup isn't fullscreen.)
  document.addEventListener('mousedown', (e) => {
    if (!popup) return;
    const isOpen = popup.classList.contains('visible') && popup.style.display !== 'none';
    if (!isOpen) return;

    const card = popup.querySelector('.profile-popup-card');
    if (card && card.contains(e.target)) return;

    // Let clicks on other profile links switch the popup instead of closing it.
    if (e.target.closest('.profile-link')) return;

    hideProfilePopup();
  }, true);

  // Handle clicks on profile links via event delegation
  document.addEventListener('click', (e) => {
    const link = e.target.closest('.profile-link');
    if (!link) return;

    e.preventDefault();
    e.stopPropagation();

    const type = link.dataset.profileType;
    const id = link.dataset.profileId;

    if (type && id) {
      showProfilePopup(type, id, link);
    }
  });

  // Desktop: show on hover with delay
  let hoverTimeout = null;
  document.addEventListener('mouseover', (e) => {
    const link = e.target.closest('.profile-link');
    if (!link) return;

    // Only hover behavior on desktop
    if (window.innerWidth <= 768) return;

    const type = link.dataset.profileType;
    const id = link.dataset.profileId;

    if (type && id) {
      clearTimeout(hoverTimeout);
      hoverTimeout = setTimeout(() => {
        showProfilePopup(type, id, link);
      }, 300);
    }
  });

  document.addEventListener('mouseout', (e) => {
    const link = e.target.closest('.profile-link');
    if (!link) return;

    clearTimeout(hoverTimeout);
  });

  // Keep popup open when hovering over it
  if (popup) {
    popup.addEventListener('mouseenter', () => {
      clearTimeout(profilePopupTimeout);
    });

    popup.addEventListener('mouseleave', () => {
      if (window.innerWidth > 768) {
        profilePopupTimeout = setTimeout(hideProfilePopup, 200);
      }
    });
  }
}

function showProfilePopup(type, id, anchorEl) {
  const popup = document.getElementById('profile-popup');
  const backdrop = document.getElementById('profile-popup-backdrop');
  if (!popup) return;

  clearTimeout(profilePopupTimeout);
  currentProfileType = type;
  currentProfileId = id;

  // Generate content based on type
  if (type === 'team') {
    renderTeamProfile(id);
  } else if (type === 'player') {
    renderPlayerProfile(id);
  }

  // Position popup
  const isMobile = window.innerWidth <= 768;

  if (isMobile) {
    // Mobile: show as bottom sheet
    popup.style.top = '';
    popup.style.left = '';
    popup.style.right = '';
    popup.style.bottom = '';
    backdrop.style.display = 'block';
  } else {
    // Desktop: position near anchor element
    backdrop.style.display = 'none';
    positionPopupNearAnchor(popup, anchorEl);
  }

  popup.style.display = 'flex';
  requestAnimationFrame(() => {
    popup.classList.add('visible');
  });
}

function positionPopupNearAnchor(popup, anchorEl) {
  if (!anchorEl) return;

  const rect = anchorEl.getBoundingClientRect();
  const popupCard = popup.querySelector('.profile-popup-card');
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  // Temporarily show to measure
  popup.style.visibility = 'hidden';
  popup.style.display = 'flex';

  const popupWidth = popupCard?.offsetWidth || 300;
  const popupHeight = popupCard?.offsetHeight || 200;

  popup.style.visibility = '';

  // Calculate position - prefer below and to the right
  let top = rect.bottom + 8;
  let left = rect.left;

  // Adjust if would overflow right
  if (left + popupWidth > viewportWidth - 16) {
    left = viewportWidth - popupWidth - 16;
  }

  // Adjust if would overflow left
  if (left < 16) {
    left = 16;
  }

  // Adjust if would overflow bottom - show above instead
  if (top + popupHeight > viewportHeight - 16) {
    top = rect.top - popupHeight - 8;
  }

  // Adjust if would overflow top
  if (top < 16) {
    top = 16;
  }

  popup.style.top = `${top}px`;
  popup.style.left = `${left}px`;
}

function hideProfilePopup() {
  const popup = document.getElementById('profile-popup');
  const backdrop = document.getElementById('profile-popup-backdrop');

  if (popup) {
    popup.classList.remove('visible');
    setTimeout(() => {
      popup.style.display = 'none';
    }, 200);
  }

  if (backdrop) {
    backdrop.style.display = 'none';
  }

  currentProfileType = null;
  currentProfileId = null;
}

/* =========================
   Admin Logs Popup
========================= */
let logsPopupOpen = false;

function initLogsPopup() {
  const popup = document.getElementById('logs-popup');
  const backdrop = document.getElementById('logs-popup-backdrop');
  const closeBtn = document.getElementById('logs-popup-close');

  if (closeBtn) closeBtn.addEventListener('click', closeLogsPopup);
  if (backdrop) backdrop.addEventListener('click', closeLogsPopup);

  // Click outside card dismisses.
  if (popup) {
    popup.addEventListener('click', (e) => {
      const card = popup.querySelector('.logs-popup-card');
      if (card && !card.contains(e.target)) closeLogsPopup();
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && logsPopupOpen) closeLogsPopup();
  });
}

function openLogsPopup() {
  if (!isAdminUser()) return;
  const popup = document.getElementById('logs-popup');
  const backdrop = document.getElementById('logs-popup-backdrop');
  if (!popup) return;

  logsPopupOpen = true;
  popup.style.display = 'flex';
  if (backdrop) backdrop.style.display = 'block';

  requestAnimationFrame(() => {
    popup.classList.add('visible');
  });

  startLogsListener();
  // Load a best-effort history so admins can see events from before
  // the dedicated /logs collection existed.
  refreshInferredLogs().then(() => renderLogsList()).catch(() => {});

  // While open, refresh inferred history occasionally (covers cases where
  // a write to /logs failed but the underlying team/player doc changed).
  try {
    if (inferredLogsInterval) clearInterval(inferredLogsInterval);
    inferredLogsInterval = setInterval(() => {
      if (!logsPopupOpen) return;
      refreshInferredLogs().then(() => renderLogsList()).catch(() => {});
    }, 20000);
  } catch (_) {}

  renderLogsList();
}

function closeLogsPopup() {
  const popup = document.getElementById('logs-popup');
  const backdrop = document.getElementById('logs-popup-backdrop');
  logsPopupOpen = false;

  if (popup) {
    popup.classList.remove('visible');
    setTimeout(() => { popup.style.display = 'none'; }, 200);
  }
  if (backdrop) backdrop.style.display = 'none';

  // Unsubscribe when closed to reduce reads.
  try { if (logsUnsub) { logsUnsub(); logsUnsub = null; } } catch (_) {}
  try { if (inferredLogsInterval) { clearInterval(inferredLogsInterval); inferredLogsInterval = null; } } catch (_) {}
}

function startLogsListener() {
  if (logsUnsub) return;
  const hintEl = document.getElementById('logs-hint');
  try { if (hintEl) hintEl.textContent = 'Loading…'; } catch (_) {}

  try {
    logsUnsub = db.collection('logs')
      .orderBy('createdAt', 'desc')
      .limit(200)
      .onSnapshot((snap) => {
        logsCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        renderLogsList();
        try { if (hintEl) hintEl.textContent = logsCache.length ? '' : 'No logs yet.'; } catch (_) {}
      }, (err) => {
        try { if (hintEl) hintEl.textContent = err?.message || 'Could not load logs.'; } catch (_) {}
      });
  } catch (e) {
    try { if (hintEl) hintEl.textContent = e?.message || 'Could not load logs.'; } catch (_) {}
  }
}

function inferLogBadge(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('rename') || t.includes('name')) return { cls: 'rename', label: 'Rename' };
  if (t.includes('request')) return { cls: 'request', label: 'Request' };
  if (t.includes('invite')) return { cls: 'invite', label: 'Invite' };
  if (t.includes('join') || t.includes('accept')) return { cls: 'join', label: 'Join' };
  if (t.includes('leave') || t.includes('kick') || t.includes('delete') || t.includes('decline')) return { cls: 'leave', label: 'Leave' };
  return { cls: 'admin', label: 'Log' };
}

function renderLogsList() {
  const listEl = document.getElementById('logs-list');
  if (!listEl) return;

  if (!isAdminUser()) {
    listEl.innerHTML = '<div class="empty-state">Admin only</div>';
    return;
  }

  const combined = ([]
    .concat((logsCache || []).map(x => ({ ...x, inferred: false })))
    .concat((inferredLogsCache || []).map(x => ({ ...x, inferred: true })))
  );

  // Sort by timestamp desc.
  combined.sort((a, b) => {
    const ams = a?.inferred ? (a?.inferredAtMs || 0) : tsToMs(a?.createdAt);
    const bms = b?.inferred ? (b?.inferredAtMs || 0) : tsToMs(b?.createdAt);
    return (bms || 0) - (ams || 0);
  });

  const rows = combined.slice(0, 200).map((l) => {
    const badge = inferLogBadge(l?.type);
    const msg = String(l?.message || '').trim() || '(no message)';
    const actor = String(l?.actorName || l?.actorId || '').trim();
    const ms = l?.inferred ? (l?.inferredAtMs || 0) : tsToMs(l?.createdAt);
    const when = Number.isFinite(ms) ? formatRelativeTime(ms) : 'just now';
    return `
      <div class="log-row">
        <div class="log-top">
          <span class="log-badge ${esc(badge.cls)}">${esc(badge.label)}</span>
          ${l?.inferred ? '<span class="log-tag history">History</span>' : ''}
          <div class="log-message">${esc(msg)}</div>
        </div>
        <div class="log-meta">
          <span>${esc(actor || 'unknown')}</span>
          <span class="log-dot"></span>
          <span>${esc(when)}</span>
        </div>
      </div>
    `;
  });

  listEl.innerHTML = rows.length ? rows.join('') : '<div class="empty-state">No logs yet</div>';
}

function renderTeamProfile(teamId) {
  const team = teamsCache.find(t => t.id === teamId);
  if (!team) {
    renderProfileError('Team not found');
    return;
  }

  const titleEl = document.getElementById('profile-popup-title');
  const bodyEl = document.getElementById('profile-popup-body');
  if (!titleEl || !bodyEl) return;

  const tc = getDisplayTeamColor(team);
  const members = getMembers(team);
  const isEligible = members.length >= TEAM_MIN && members.length <= SOFT_TEAM_MAX;
  const isOver = members.length > SOFT_TEAM_MAX;
  const creatorId = team.creatorUserId;

  // Format creation date
  const createdAt = team.createdAt ? formatRelativeTime(tsToMs(team.createdAt)) : 'Unknown';

  // Get last activity (most recent member activity from presence)
  const memberIds = members.map(m => entryAccountId(m)).filter(Boolean);
  const lastActivity = getTeamLastActivity(memberIds);

  titleEl.innerHTML = `<span style="color:${esc(tc || 'var(--text)')}">${esc(team.teamName || 'Unnamed Team')}</span>`;

  bodyEl.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Status</span>
        <span class="profile-status ${isEligible ? 'eligible' : 'not-eligible'}">
          <span class="profile-status-dot"></span>
          ${isEligible ? 'Tournament Ready' : (isOver ? 'Too many players' : ('Needs ' + (TEAM_MIN - members.length) + ' more'))}
        </span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Members</span>
        <span class="profile-stat-value">${members.length}/${SOFT_TEAM_MAX}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Created</span>
        <span class="profile-stat-value">${esc(createdAt)}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Last Active</span>
        <span class="profile-stat-value">${esc(lastActivity)}</span>
      </div>
    </div>

    <div class="profile-more-details">
      <button class="link-btn subtle" type="button" id="team-more-details-btn">See more details</button>
    </div>

    <div class="profile-divider"></div>

    <div class="profile-members">
      <div class="profile-members-title">Team Members</div>
      ${members.length ? members.map(m => {
        const isLeader = isSameAccount(m, creatorId);
        const memberColor = tc || 'var(--text)';
        const uid = String(entryAccountId(m) || m.id || m.userId || '').trim();
        const display = String(m.name || '—');
        const nameEl = uid
          ? `<span class="profile-member-name profile-link" data-profile-type="player" data-profile-id="${esc(uid)}" style="color:${esc(memberColor)}">${esc(display)}</span>`
          : `<span class="profile-member-name" style="color:${esc(memberColor)}">${esc(display)}</span>`;
        return `
          <div class="profile-member">
            ${nameEl}
            ${isLeader ? '<span class="profile-member-badge leader">Leader</span>' : ''}
          </div>
        `;
      }).join('') : '<div class="profile-member"><span class="profile-member-name" style="color:var(--text-dim)">No members yet</span></div>'}
    </div>
  `;
  // Hook up "See more details" for teams after content is mounted.
  const teamMoreBtn = document.getElementById('team-more-details-btn');
  teamMoreBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideProfilePopup();
    openProfileDetailsModal(team.id, 'team');
  });

}

async function attemptRepairPlayerProfileDoc(targetUid) {
  // Best-effort: if a player profile doc is missing, recreate it from the username registry.
  // Only works when the current client has write permission (typically the account owner or admin).
  const uid = String(targetUid || '').trim();
  if (!uid) return { ok: false, reason: 'Missing uid' };

  // IMPORTANT: When repairing a missing `players/<uid>` doc, we should preserve the user's
  // *actual* name. `playersCache` will be missing in this scenario, so we fall back to the
  // usernames registry (doc id = username). This prevents repaired accounts from becoming
  // "unknown" in Who's Online and profile popups.
  // Try multiple sources for the user's name.
  // 1) usernames registry cache (fast, preferred)
  // 2) presence doc (often contains `name`)
  // 3) users/<uid> doc (may contain `name`)
  let display = String(getNameForAccount(uid) || '').trim();
  if (!display) {
    try {
      const ps = await db.collection(PRESENCE_COLLECTION).doc(uid).get();
      display = String((ps.exists ? (ps.data() || {}).name : '') || '').trim();
    } catch (_) {}
  }
  if (!display) {
    try {
      const us = await db.collection('users').doc(uid).get();
      const d = us.exists ? (us.data() || {}) : {};
      display = String(d.name || d.username || '').trim();
    } catch (_) {}
  }
  if (!display) return { ok: false, reason: 'Missing account name' };

  try {
    await db.collection('players').doc(uid).set({
      name: display,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    // Also ensure a minimal users/<uid> doc (non-critical).
    try {
      await db.collection('users').doc(uid).set({
        username: normalizeUsername(display),
        name: display,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    } catch (_) {}

    return { ok: true };
  } catch (e) {
    return { ok: false, reason: String(e?.code || e?.message || 'Repair failed') };
  }
}

async function autoFixOrDeleteMissingPlayer(uid) {
  // Called when a profile is opened for an account that exists in /usernames but has no players doc.
  // Flow:
  // 1) Try to repair the missing players/users docs.
  // 2) If repair fails, and current user is admin, delete the account everywhere.
  const targetUid = String(uid || '').trim();
  if (!targetUid) return;

  // Keep popup stable if the user navigated away.
  const stillOpen = () => (currentProfileType === 'player' && currentProfileId === targetUid);

  // Show a friendly state in the popup while we work.
  try {
    if (stillOpen()) {
      const bodyEl = document.getElementById('profile-popup-body');
      if (bodyEl) bodyEl.innerHTML = `<div class="hint">Fixing account…</div>`;
    }
  } catch (_) {}

  // Attempt repair
  const repaired = await attemptRepairPlayerProfileDoc(targetUid);

  // If repaired, wait for caches to refresh then re-render.
  if (repaired && repaired.ok) {
    // Give Firestore listeners a moment to deliver the repaired doc.
    await new Promise(r => setTimeout(r, 250));
    try {
      if (stillOpen()) renderPlayerProfile(targetUid);
    } catch (_) {}
    return;
  }

  // Repair failed: automatically delete if admin.
  if (isAdminUser()) {
    const name = String(findKnownUserName(targetUid) || '').trim();
    try {
      await adminDeleteUser(targetUid, name);
    } catch (e) {
      console.warn('Auto-delete corrupted user failed (best-effort):', e);
    }

    try {
      if (stillOpen()) {
        const bodyEl = document.getElementById('profile-popup-body');
        if (bodyEl) bodyEl.innerHTML = `<div class="hint">Corrupted account removed.</div>`;
      }
    } catch (_) {}

    // Re-render online list if open
    try {
      const modal = document.getElementById('online-modal');
      if (modal && modal.style.display === 'flex') renderOnlineUsersList();
    } catch (_) {}

    return;
  }

  // Non-admin: mark as corrupted in UI only.
  try {
    if (stillOpen()) {
      const bodyEl = document.getElementById('profile-popup-body');
      if (bodyEl) bodyEl.innerHTML = `<div class="hint">Player profile missing. Admin required to remove this account.</div>`;
    }
  } catch (_) {}
}

// Prefer the public username registry for account creation time.
// This avoids "Joined" drifting when players/<uid>.createdAt was previously
// overwritten by profile upserts.
function getAccountCreatedAtForUid(uid) {
  const id = String(uid || '').trim();
  if (!id) return null;

  // 1) Username registry (authoritative, immutable under our rules)
  try {
    for (const r of (usernamesCache || [])) {
      const rUid = String(r?.uid || '').trim();
      if (rUid === id && r?.createdAt) return r.createdAt;
    }
  } catch (_) {}

  // 2) Current signed-in user's Auth metadata (accurate for "me")
  try {
    const cu = auth?.currentUser;
    if (cu && String(cu.uid || '').trim() === id && cu?.metadata?.creationTime) {
      const dt = new Date(cu.metadata.creationTime);
      if (dt && !isNaN(dt.getTime())) return firebase.firestore.Timestamp.fromDate(dt);
    }
  } catch (_) {}

  return null;
}

function renderPlayerProfile(playerId) {
  // Find player in cache
  const player = playersCache.find(p => p.id === playerId || entryAccountId(p) === playerId);
  if (!player) {
    // The account may exist in /usernames but be missing players/<uid>. Auto-heal, and if healing fails,
    // auto-delete the corrupted account (admin only) so it doesn’t keep breaking the UI.
    renderProfileError('Player not found');
    try { autoFixOrDeleteMissingPlayer(playerId); } catch (_) {}
    return;
  }

  const titleEl = document.getElementById('profile-popup-title');
  const bodyEl = document.getElementById('profile-popup-body');
  if (!titleEl || !bodyEl) return;

  const name = (player.name || '—').trim();
  const roster = buildRosterIndex(teamsCache);
  const memberTeam = roster.memberTeamByUserId.get(player.id);
  const tc = memberTeam ? getDisplayTeamColor(memberTeam) : null;
  const teamStyle = (memberTeam && tc) ? `color:${tc}` : '';

  // Format dates
  const createdAtTs = getAccountCreatedAtForUid(player.id) || player.createdAt || null;
  const createdAt = createdAtTs ? formatRelativeTime(tsToMs(createdAtTs)) : 'Unknown';
  const updatedAt = player.updatedAt ? formatRelativeTime(tsToMs(player.updatedAt)) : 'Unknown';

  // Get online status from presence
  const presenceStatus = getPresenceStatus(player.id);
  const isOnline = presenceStatus === 'online';
  const lastSeen = getPlayerLastSeen(player.id);
  const whereLabel = getPresenceWhereLabel(player.id);
  const statusText = (() => {
    const base = presenceStatus === 'online' ? 'Online' : (presenceStatus === 'idle' ? 'Idle' : 'Offline');
    if (presenceStatus === 'offline') return base;
    return `${base}${whereLabel ? ' — ' + whereLabel : ''}`;
  })();

  const statsGames = Number(player.gamesPlayed || 0) || 0;
  const statsWins = Number(player.wins || 0) || 0;
  const statsLosses = Number(player.losses || 0) || 0;

  const myUid = String(auth.currentUser?.uid || getUserId() || '').trim();
  const canMessage = !!myUid && myUid !== String(player.id || '').trim();

  titleEl.innerHTML = `<span style="color:${esc(tc || 'var(--text)')}">${esc(name)}</span>`;

  bodyEl.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Status</span>
        <span class="profile-status ${isOnline ? 'online' : 'offline'}">
          <span class="profile-status-dot"></span>
          ${esc(statusText)}
        </span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Team</span>
        ${memberTeam ? `
          <span class="profile-stat-value highlight profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}" style="${teamStyle ? esc(teamStyle) : ''}">${esc(truncateTeamName(memberTeam.teamName || 'Team'))}</span>
        ` : `
          <span class="profile-stat-value">No team</span>
        `}
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Joined</span>
        <span class="profile-stat-value">${esc(createdAt)}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Last Active</span>
        <span class="profile-stat-value">${esc(isOnline ? 'Now' : lastSeen)}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Games Played</span>
        <span class="profile-stat-value">${esc(String(statsGames))}</span>
      </div>
    </div>

    ${canMessage ? `
      <div class="profile-actions">
        <button class="btn" id="profile-message-btn" type="button">Message</button>
      </div>
    ` : ''}

    <div class="profile-more-details">
      <button class="link-btn subtle" type="button" id="profile-more-details-btn">See more details</button>
    </div>
  `;

  // Hook up "See more details" after content is mounted.
  const moreBtn = document.getElementById('profile-more-details-btn');
  moreBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    // Close the small anchored profile popup before opening the centered modal.
    hideProfilePopup();
    openProfileDetailsModal(player.id, 'player');
  });

  const msgBtn = document.getElementById('profile-message-btn');
  msgBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    hideProfilePopup();
    try {
      const m = document.getElementById('online-modal');
      if (m && m.style.display === 'flex') closeOnlineModal();
    } catch (_) {}
    // If the player profile was opened from within another modal (e.g., Teams),
    // close that modal so the Messages drawer isn't trapped behind it.
    try {
      const teamModal = document.getElementById('team-modal');
      if (teamModal && teamModal.style.display !== 'none') closeTeamModal();
    } catch (_) {}
    try {
      const reqModal = document.getElementById('requests-modal');
      if (reqModal && reqModal.style.display !== 'none') closeRequestsModal();
    } catch (_) {}
    try {
      const invModal = document.getElementById('invites-modal');
      if (invModal && invModal.style.display !== 'none') closeInvitesModal();
    } catch (_) {}
    openPersonalChatWith(player.id);
  });
}

function renderProfileError(message) {
  const titleEl = document.getElementById('profile-popup-title');
  const bodyEl = document.getElementById('profile-popup-body');
  if (!titleEl || !bodyEl) return;

  titleEl.textContent = 'Error';
  bodyEl.innerHTML = `<div style="color:var(--text-dim);font-size:13px;">${esc(message)}</div>`;
}

/* =========================
   Profile Details Modal
========================= */
function initProfileDetailsModal() {
  const modal = document.getElementById('profile-details-modal');
  const backdrop = document.getElementById('profile-details-backdrop');
  const closeBtn = document.getElementById('profile-details-close');
  if (!modal) return;

  const close = () => closeProfileDetailsModal();
  closeBtn?.addEventListener('click', close);
  backdrop?.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('modal-open')) {
      closeProfileDetailsModal();
    }
  });
}

function openProfileDetailsModal(id, type = 'player') {
  const modal = document.getElementById('profile-details-modal');
  if (!modal) return;

  renderProfileDetailsModal(id, type);

  // Match the settings modal behavior (centered fixed card).
  modal.style.display = 'block';
  void modal.offsetWidth;
  modal.classList.add('modal-open');
}

function closeProfileDetailsModal() {
  const modal = document.getElementById('profile-details-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  setTimeout(() => {
    if (!modal.classList.contains('modal-open')) {
      modal.style.display = 'none';
    }
  }, 200);
}


function renderTeamDetailsModal(teamId) {
  const titleEl = document.getElementById('profile-details-title');
  const bodyEl = document.getElementById('profile-details-body');
  if (!titleEl || !bodyEl) return;

  const team = teamsCache.find(t => t?.id === teamId);
  if (!team) {
    titleEl.textContent = 'Details';
    bodyEl.innerHTML = `<div class="hint">Team not found.</div>`;
    return;
  }

  const tc = getDisplayTeamColor(team);
  const members = getMembers(team);
  const creatorId = team.creatorUserId;

  const createdAt = team.createdAt ? formatRelativeTime(tsToMs(team.createdAt)) : 'Unknown';

  const memberIds = members.map(m => entryAccountId(m)).filter(Boolean);
  const lastActivity = getTeamLastActivity(memberIds);

  // Aggregate member stats (best-effort)
  let aggGames = 0, aggWins = 0, aggLosses = 0;
  for (const mid of memberIds) {
    const p = playersCache.find(pp => pp?.id === mid || entryAccountId(pp) === mid);
    if (!p) continue;
    aggGames += Number(p.gamesPlayed || 0) || 0;
    aggWins += Number(p.wins || 0) || 0;
    aggLosses += Number(p.losses || 0) || 0;
  }
  const denom = (aggWins + aggLosses);
  const winRate = denom > 0 ? Math.round((aggWins / denom) * 100) : 0;

  const isEligible = members.length >= TEAM_MIN && members.length <= SOFT_TEAM_MAX;
  const isOver = members.length > SOFT_TEAM_MAX;

  titleEl.innerHTML = `<span style="color:${esc(tc || 'var(--text)')}">${esc(team.teamName || 'Unnamed Team')}</span>`;

  bodyEl.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Status</span>
        <span class="profile-status ${isEligible ? 'eligible' : 'not-eligible'}">
          <span class="profile-status-dot"></span>
          ${isEligible ? 'Tournament Ready' : (isOver ? 'Too many players' : ('Needs ' + (TEAM_MIN - members.length) + ' more'))}
        </span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Members</span>
        <span class="profile-stat-value">${members.length}/${SOFT_TEAM_MAX}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Created</span>
        <span class="profile-stat-value">${esc(createdAt)}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Last Active</span>
        <span class="profile-stat-value">${esc(lastActivity)}</span>
      </div>
    </div>

    <div class="profile-divider"></div>

    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Games Played</span>
        <span class="profile-stat-value">${esc(String(aggGames))}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Record</span>
        <span class="profile-stat-value">${esc(String(aggWins))}W - ${esc(String(aggLosses))}L</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Win Rate</span>
        <span class="profile-stat-value">${esc(String(winRate))}%</span>
      </div>
    </div>

    <div class="profile-divider"></div>

    <div class="profile-members">
      <div class="profile-members-title">Team Members</div>
      ${members.length ? members.map(m => {
        const mid = entryAccountId(m);
        const mname = (m?.name || '—').trim();
        const isLeader = isSameAccount(m, creatorId);
        const link = mid
          ? `<span class="profile-link" data-profile-type="player" data-profile-id="${esc(mid)}" style="color:${esc(tc || 'var(--text)')}">${esc(mname)}</span>`
          : `<span class="profile-member-name" style="color:${esc(tc || 'var(--text)')}">${esc(mname)}</span>`;
        return `
          <div class="profile-member">
            ${link}
            ${isLeader ? '<span class="profile-member-badge leader">Leader</span>' : ''}
          </div>
        `;
      }).join('') : '<div class="profile-member"><span class="profile-member-name" style="color:var(--text-dim)">No members yet</span></div>'}
    </div>
  `;
}

function renderProfileDetailsModal(id, type = 'player') {
  const titleEl = document.getElementById('profile-details-title');
  const bodyEl = document.getElementById('profile-details-body');
  if (!titleEl || !bodyEl) return;

  if (type === 'team') {
    renderTeamDetailsModal(id);
    return;
  }

  const playerId = id;

  const player = playersCache.find(p => p?.id === playerId || entryAccountId(p) === playerId);
  if (!player) {
    titleEl.textContent = 'Details';
    bodyEl.innerHTML = `<div class="hint">Player not found.</div>`;
    return;
  }

  const roster = buildRosterIndex(teamsCache);
  const memberTeam = roster.memberTeamByUserId.get(player.id);
  const tc = memberTeam ? getDisplayTeamColor(memberTeam) : null;
  const teamStyle = (memberTeam && tc) ? `color:${tc}` : '';
  const name = (player.name || '—').trim();

  const presenceStatus = getPresenceStatus(player.id);
  const whereLabel = getPresenceWhereLabel(player.id);
  const statusBase = presenceStatus === 'online' ? 'Online' : (presenceStatus === 'idle' ? 'Idle' : 'Offline');
  const statusLine = presenceStatus === 'offline'
    ? statusBase
    : `${statusBase}${whereLabel ? ' — ' + whereLabel : ''}`;

  const joinedTs = getAccountCreatedAtForUid(player.id) || player.createdAt || null;
  const joinedAt = joinedTs ? formatRelativeTime(tsToMs(joinedTs)) : 'Unknown';
  const lastSeen = getPlayerLastSeen(player.id);

  const games = Number(player.gamesPlayed || 0) || 0;
  const wins = Number(player.wins || 0) || 0;
  const losses = Number(player.losses || 0) || 0;
  const denom = (wins + losses);
  const winRate = denom > 0 ? Math.round((wins / denom) * 100) : 0;

  const myUid = String(auth.currentUser?.uid || getUserId() || '').trim();
  const canMessage = !!myUid && myUid !== String(player.id || '').trim();

  titleEl.innerHTML = `<span style="color:${esc(tc || 'var(--text)')}">${esc(name)}</span>`;

  const teamLine = memberTeam
    ? `<span class="profile-link" data-profile-type="team" data-profile-id="${esc(memberTeam.id)}" style="color:${esc(tc)}">${esc(truncateTeamName(memberTeam.teamName || 'Team'))}</span>`
    : '<span style="color:var(--text-dim)">No team</span>';

  bodyEl.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Status</span>
        <span class="profile-status ${presenceStatus === 'online' ? 'online' : (presenceStatus === 'idle' ? 'idle' : 'offline')}">
          <span class="profile-status-dot"></span>
          ${esc(statusLine)}
        </span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Team</span>
        <span class="profile-stat-value">${teamLine}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Joined</span>
        <span class="profile-stat-value">${esc(joinedAt)}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Last Active</span>
        <span class="profile-stat-value">${esc(presenceStatus === 'online' ? 'Now' : lastSeen)}</span>
      </div>
    </div>

    ${canMessage ? `
      <div class="profile-actions">
        <button class="btn" id="profile-details-message-btn" type="button">Message</button>
      </div>
    ` : ''}

    <div class="profile-divider"></div>

    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Games Played</span>
        <span class="profile-stat-value">${esc(String(games))}</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Record</span>
        <span class="profile-stat-value">${esc(String(wins))}W - ${esc(String(losses))}L</span>
      </div>
      <div class="profile-stat-row">
        <span class="profile-stat-label">Win Rate</span>
        <span class="profile-stat-value">${esc(String(winRate))}%</span>
      </div>
    </div>

  `;

  const msgBtn = document.getElementById('profile-details-message-btn');
  msgBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    closeProfileDetailsModal();
    try {
      const m = document.getElementById('online-modal');
      if (m && m.style.display === 'flex') closeOnlineModal();
    } catch (_) {}
    openPersonalChatWith(player.id);
  });
}

function formatRelativeTime(timestamp) {
  if (!timestamp || isNaN(timestamp)) return 'Unknown';

  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 60) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (weeks < 4) return `${weeks}w ago`;

  // For older dates, show the actual date
  const date = new Date(timestamp);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: date.getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

function getTeamLastActivity(memberIds) {
  if (!memberIds || !memberIds.length) return 'Unknown';

  let latestActivity = 0;

  for (const memberId of memberIds) {
    const presence = presenceCache.find(p => p.id === memberId);
    if (presence?.lastActivity) {
      const ts = tsToMs(presence.lastActivity);
      if (ts > latestActivity) {
        latestActivity = ts;
      }
    }
  }

  if (latestActivity === 0) return 'Unknown';

  // Check if any member is currently online
  const anyOnline = memberIds.some(id => getPresenceStatus(id) === 'online');
  if (anyOnline) return 'Now';

  return formatRelativeTime(latestActivity);
}

function getPlayerLastSeen(playerId) {
  const presence = presenceCache.find(p => p.id === playerId || p.odId === playerId);
  const ts = presence?.lastActivity || presence?.updatedAt || presence?.lastSeen || null;
  if (!ts) return 'Unknown';

  return formatRelativeTime(tsToMs(ts));
}

// Helper to create a profile link HTML
function createProfileLink(type, id, displayName, color) {
  const style = color ? `style="color:${esc(color)}"` : '';
  return `<span class="profile-link" data-profile-type="${esc(type)}" data-profile-id="${esc(id)}" ${style}>${esc(displayName)}</span>`;
}

// Export for use in other files
window.createProfileLink = createProfileLink;
window.showProfilePopup = showProfilePopup;
window.hideProfilePopup = hideProfilePopup;

// Initialize profile popup on DOMContentLoaded
document.addEventListener('DOMContentLoaded', initProfilePopup);
document.addEventListener('DOMContentLoaded', initLogsPopup);


/* =========================
   Practice page (no modal)
========================= */
function openPracticeGameInApp(gameId) {
  const gid = String(gameId || '').trim();
  if (!gid) throw new Error('Missing practice game id.');

  enterAppFromLaunch('quick', { skipQuickLobby: true });
  try { window.showGameBoard?.(); } catch (_) {}
  try { window.startGameListener?.(gid, { spectator: false, ephemeral: true }); } catch (e) { console.warn(e); }
  try { document.body.classList.add('practice'); } catch (_) {}

  // Keep URL clean in same-tab mode.
  try {
    const url = new URL(window.location.href);
    if (url.searchParams.has('practice')) {
      url.searchParams.delete('practice');
      history.replaceState(null, '', url.toString());
    }
  } catch (_) {}
}

async function startPracticeInApp(opts = {}, hintEl = null) {
  if (!auth.currentUser || !getUserName()) {
    if (hintEl) hintEl.textContent = 'Sign in to continue.';
    return null;
  }

  if (hintEl) hintEl.textContent = 'Starting…';
  let createFn = window.createPracticeGame;
  if (typeof createFn !== 'function') {
    await ensureGameRuntimeApis(['createPracticeGame', 'startGameListener'], { timeoutMs: 4200 });
    createFn = window.createPracticeGame;
  }
  if (typeof createFn !== 'function') throw new Error('Practice is still loading. Please try again.');

  const sizeNum = parseInt(opts?.size, 10);
  const size = (sizeNum === 5) ? 5 : (sizeNum === 4) ? 4 : ((sizeNum === 3) ? 3 : 2);
  const role = String(opts?.role || 'operative');
  const vibe = String(opts?.vibe || '').trim();
  const deckId = String(opts?.deckId || 'standard');
  const blackCardsNum = parseInt(opts?.blackCards, 10);
  const blackCards = (blackCardsNum === 2 || blackCardsNum === 3) ? blackCardsNum : 1;
  const clueTimerRaw = parseInt(opts?.clueTimerSeconds, 10);
  const clueTimerSeconds = Number.isFinite(clueTimerRaw) ? Math.max(0, clueTimerRaw) : 0;
  const guessTimerRaw = parseInt(opts?.guessTimerSeconds, 10);
  const guessTimerSeconds = Number.isFinite(guessTimerRaw) ? Math.max(0, guessTimerRaw) : 0;
  const stackingEnabled = opts?.stackingEnabled !== false;
  const aiJudgesEnabled = opts?.aiJudgesEnabled !== false;
  const aiChallengeEnabled = aiJudgesEnabled ? (opts?.aiChallengeEnabled !== false) : false;
  const rawJudgeKeys = Array.isArray(opts?.enabledAIJudges) ? opts.enabledAIJudges : [];
  const enabledAIJudges = Array.from(new Set(
    rawJudgeKeys
      .map((k) => String(k || '').trim().toLowerCase())
      .filter((k) => k === 'merry' || k === 'vlaada')
  ));
  if (aiJudgesEnabled && !enabledAIJudges.length) enabledAIJudges.push('merry');

  const gameId = await createFn({
    size,
    role,
    vibe,
    deckId,
    blackCards,
    clueTimerSeconds,
    guessTimerSeconds,
    stackingEnabled,
    aiJudgesEnabled,
    aiChallengeEnabled,
    enabledAIJudges
  });
  openPracticeGameInApp(gameId);
  return gameId;
}

function initPracticePage() {
  const panel = document.getElementById('panel-practice');
  if (!panel) return;

  // Practice is its own page; primary tabs are hidden elsewhere.

  const roleBtns = Array.from(panel.querySelectorAll('[data-practice-role]'));
  const sizeBtns = Array.from(panel.querySelectorAll('[data-practice-size]'));
  const rulesTextEl = document.getElementById('practice-page-rules-text');
  const settingsBtn = document.getElementById('practice-page-settings-btn');
  const startBtn = document.getElementById('practice-page-start');
  const hintEl = document.getElementById('practice-page-hint');
  const stepSize = document.getElementById('practice-step-size');
  const stepVibe = document.getElementById('practice-step-vibe');
  const settingsModal = document.getElementById('practice-page-settings-modal');
  const settingsBackdrop = document.getElementById('practice-page-settings-backdrop');
  const settingsCloseBtn = document.getElementById('practice-page-settings-close');
  const settingsApplyBtn = document.getElementById('practice-page-settings-apply');
  const settingsStatusEl = document.getElementById('practice-page-settings-status');
  const settingsVibeEl = document.getElementById('practice-page-vibe');
  const settingsBlackCardsEl = document.getElementById('practice-page-black-cards');
  const settingsClueTimerEl = document.getElementById('practice-page-clue-timer');
  const settingsGuessTimerEl = document.getElementById('practice-page-guess-timer');
  const settingsStackingToggleEl = document.getElementById('practice-page-stacking-toggle');
  const settingsAiJudgesToggleEl = document.getElementById('practice-page-ai-judges-toggle');
  const settingsAiChallengeRowEl = document.getElementById('practice-page-ai-challenge-row');
  const settingsAiChallengeToggleEl = document.getElementById('practice-page-ai-challenge-toggle');
  const settingsAiJudgesPanelEl = document.getElementById('practice-page-ai-judges-panel');
  const settingsAiJudgeMerryEl = document.getElementById('practice-page-ai-judge-merry');
  const settingsAiJudgeVlaadaEl = document.getElementById('practice-page-ai-judge-vlaada');

  const state = {
    role: null,
    size: null,
    settings: {
      vibe: '',
      deckId: 'standard',
      blackCards: 1,
      clueTimerSeconds: 0,
      guessTimerSeconds: 0,
      stackingEnabled: true,
      aiJudgesEnabled: true,
      aiChallengeEnabled: true,
      enabledAIJudges: ['merry']
    }
  };

  const normalizeJudgeKeys = (raw, fallback = ['merry']) => {
    const src = Array.isArray(raw) ? raw : [];
    const out = [];
    for (const item of src) {
      const key = String(item || '').trim().toLowerCase();
      if ((key === 'merry' || key === 'vlaada') && !out.includes(key)) out.push(key);
    }
    if (out.length) return out;
    return Array.isArray(fallback) ? [...fallback] : ['merry'];
  };

  const formatJudgeSummary = (settings) => {
    const s = settings || state.settings;
    if (s.aiJudgesEnabled === false) return 'Off';
    const keys = normalizeJudgeKeys(s.enabledAIJudges, []);
    if (!keys.length) return 'Off';
    const names = keys.map((k) => (k === 'vlaada' ? 'Vlaada' : 'Merry'));
    return names.join('+');
  };

  const syncJudgePanelVisibility = () => {
    const enabled = !!settingsAiJudgesToggleEl?.checked;
    if (settingsAiChallengeRowEl) {
      settingsAiChallengeRowEl.style.display = enabled ? 'flex' : 'none';
      settingsAiChallengeRowEl.classList.toggle('is-disabled', !enabled);
    }
    if (settingsAiChallengeToggleEl) settingsAiChallengeToggleEl.disabled = !enabled;
    if (settingsAiJudgesPanelEl) {
      settingsAiJudgesPanelEl.style.display = enabled ? 'flex' : 'none';
      settingsAiJudgesPanelEl.classList.toggle('is-disabled', !enabled);
    }
  };

  const enforceAtLeastOneJudge = (changedEl = null) => {
    if (!settingsAiJudgesToggleEl?.checked) return;
    const all = [settingsAiJudgeMerryEl, settingsAiJudgeVlaadaEl].filter(Boolean);
    const checked = all.filter((el) => el.checked);
    if (checked.length) return;
    if (changedEl) changedEl.checked = true;
    else if (all[0]) all[0].checked = true;
  };

  const normalizeInt = (value, fallback, min = 0, max = 600) => {
    const n = parseInt(value, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, n));
  };

  const formatSeconds = (sec) => {
    const s = normalizeInt(sec, 0, 0, 600);
    if (!s) return '∞';
    if (s % 60 === 0) return `${s / 60}m`;
    return `${s}s`;
  };

  const formatRules = (settings) => {
    const s = settings || state.settings;
    const stackStr = s.stackingEnabled === false ? 'Off' : 'On';
    const challengeStr = s.aiJudgesEnabled === false
      ? 'Off'
      : (s.aiChallengeEnabled === false ? 'Off' : 'On');
    const judgesStr = formatJudgeSummary(s);
    const vibeStr = s.vibe ? ` · Vibe: ${s.vibe}` : '';
    return `Rules: Assassin: ${s.blackCards} · Clue: ${formatSeconds(s.clueTimerSeconds)} · Guess: ${formatSeconds(s.guessTimerSeconds)} · Stacking: ${stackStr} · Challenge: ${challengeStr} · Judges: ${judgesStr}${vibeStr}`;
  };

  const syncModalFromState = () => {
    if (settingsVibeEl) settingsVibeEl.value = state.settings.vibe || '';
    if (settingsBlackCardsEl) settingsBlackCardsEl.value = String(state.settings.blackCards || 1);
    if (settingsClueTimerEl) settingsClueTimerEl.value = String(state.settings.clueTimerSeconds || 0);
    if (settingsGuessTimerEl) settingsGuessTimerEl.value = String(state.settings.guessTimerSeconds || 0);
    if (settingsStackingToggleEl) settingsStackingToggleEl.checked = state.settings.stackingEnabled !== false;
    if (settingsAiJudgesToggleEl) settingsAiJudgesToggleEl.checked = state.settings.aiJudgesEnabled !== false;
    if (settingsAiChallengeToggleEl) settingsAiChallengeToggleEl.checked = state.settings.aiChallengeEnabled !== false;
    const judgeKeys = normalizeJudgeKeys(state.settings.enabledAIJudges, ['merry']);
    if (settingsAiJudgeMerryEl) settingsAiJudgeMerryEl.checked = judgeKeys.includes('merry');
    if (settingsAiJudgeVlaadaEl) settingsAiJudgeVlaadaEl.checked = judgeKeys.includes('vlaada');
    syncJudgePanelVisibility();
  };

  const syncStateFromModal = () => {
    state.settings.vibe = String(settingsVibeEl?.value || '').trim();
    state.settings.blackCards = normalizeInt(settingsBlackCardsEl?.value, 1, 1, 3);
    state.settings.clueTimerSeconds = normalizeInt(settingsClueTimerEl?.value, 0, 0, 600);
    state.settings.guessTimerSeconds = normalizeInt(settingsGuessTimerEl?.value, 0, 0, 600);
    state.settings.stackingEnabled = !!settingsStackingToggleEl?.checked;
    state.settings.aiJudgesEnabled = !!settingsAiJudgesToggleEl?.checked;
    state.settings.aiChallengeEnabled = state.settings.aiJudgesEnabled
      ? !!settingsAiChallengeToggleEl?.checked
      : false;
    const chosen = [];
    if (settingsAiJudgeMerryEl?.checked) chosen.push('merry');
    if (settingsAiJudgeVlaadaEl?.checked) chosen.push('vlaada');
    state.settings.enabledAIJudges = state.settings.aiJudgesEnabled
      ? normalizeJudgeKeys(chosen, ['merry'])
      : normalizeJudgeKeys(chosen, state.settings.enabledAIJudges || ['merry']);
  };

  const openSettingsModal = () => {
    if (!settingsModal) return;
    syncModalFromState();
    settingsModal.style.display = 'flex';
    void settingsModal.offsetWidth;
    settingsModal.classList.add('modal-open');
    settingsModal.setAttribute('aria-hidden', 'false');
    // Status hint removed (requested to keep settings panel clean)
    if (settingsStatusEl) settingsStatusEl.textContent = '';
  };

  const closeSettingsModal = () => {
    if (!settingsModal) return;
    settingsModal.classList.remove('modal-open');
    settingsModal.setAttribute('aria-hidden', 'true');
    setTimeout(() => {
      if (!settingsModal.classList.contains('modal-open')) settingsModal.style.display = 'none';
    }, 200);
  };

  const setSelected = (btns, activeBtn) => {
    btns.forEach(b => b.classList.toggle('is-selected', b === activeBtn));
  };

  const refresh = () => {
    const ok = !!state.role && !!state.size;
    if (stepSize) stepSize.style.display = state.role ? "" : "none";
    if (stepVibe) stepVibe.style.display = ok ? "" : "none";
    if (startBtn) startBtn.disabled = !ok;
    if (rulesTextEl) rulesTextEl.textContent = formatRules(state.settings);
    if (hintEl) {
      hintEl.textContent = ok
        ? ''
        : 'Pick a role and team size to continue.';
    }
  };

  roleBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      state.role = String(btn.getAttribute('data-practice-role') || '').trim() || null;
      setSelected(roleBtns, btn);
      refresh();
      try { sizeBtns?.[0]?.focus?.(); } catch (_) {}
    });
  });

  sizeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const n = parseInt(btn.getAttribute('data-practice-size') || '0', 10);
      state.size = (n === 2 || n === 3 || n === 4 || n === 5) ? n : null;
      setSelected(sizeBtns, btn);
      refresh();
    });
  });

  try {
    state.settings.stackingEnabled = (typeof window.isStackingEnabled === 'function')
      ? !!window.isStackingEnabled()
      : true;
  } catch (_) {
    state.settings.stackingEnabled = true;
  }
  syncModalFromState();

  const start = async () => {
    if (!state.role || !state.size) return;

    try {
      await startPracticeInApp({
        size: state.size,
        role: state.role,
        vibe: state.settings.vibe,
        deckId: state.settings.deckId || 'standard',
        blackCards: state.settings.blackCards,
        clueTimerSeconds: state.settings.clueTimerSeconds,
        guessTimerSeconds: state.settings.guessTimerSeconds,
        stackingEnabled: state.settings.stackingEnabled !== false,
        aiJudgesEnabled: state.settings.aiJudgesEnabled !== false,
        aiChallengeEnabled: state.settings.aiChallengeEnabled !== false,
        enabledAIJudges: normalizeJudgeKeys(state.settings.enabledAIJudges, ['merry'])
      }, hintEl);
    } catch (e) {
      console.error(e);
      if (hintEl) hintEl.textContent = (e?.message || 'Could not start practice.');
    }
  };

  settingsBtn?.addEventListener('click', openSettingsModal);
  settingsCloseBtn?.addEventListener('click', closeSettingsModal);
  settingsBackdrop?.addEventListener('click', closeSettingsModal);
  settingsAiJudgesToggleEl?.addEventListener('change', () => {
    if (settingsAiJudgesToggleEl.checked) enforceAtLeastOneJudge();
    syncJudgePanelVisibility();
  });
  settingsAiJudgeMerryEl?.addEventListener('change', (e) => enforceAtLeastOneJudge(e.currentTarget));
  settingsAiJudgeVlaadaEl?.addEventListener('change', (e) => enforceAtLeastOneJudge(e.currentTarget));
  settingsApplyBtn?.addEventListener('click', () => {
    syncStateFromModal();
    refresh();
    closeSettingsModal();
  });
  settingsVibeEl?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    syncStateFromModal();
    refresh();
    closeSettingsModal();
  });

  startBtn?.addEventListener('click', start);

  refresh();
}

/* =========================
   Practice modal
========================= */
function openPracticeModal() {
  const modal = document.getElementById('practice-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  modal.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => modal.classList.add('modal-open'));
  try {
    const enabled = (typeof window.isStackingEnabled === 'function')
      ? !!window.isStackingEnabled()
      : true;
    const toggle = document.getElementById('practice-stacking-toggle');
    if (toggle) toggle.checked = enabled;
  } catch (_) {}
}

function closePracticeModal() {
  const modal = document.getElementById('practice-modal');
  if (!modal) return;
  modal.classList.remove('modal-open');
  modal.setAttribute('aria-hidden', 'true');
  setTimeout(() => { modal.style.display = 'none'; }, 180);
  const hint = document.getElementById('practice-hint');
  if (hint) hint.textContent = '';
}

function initPracticeModal() {
  const modal = document.getElementById('practice-modal');
  if (!modal) return;

  const close = () => closePracticeModal();
  document.getElementById('practice-close')?.addEventListener('click', close);
  document.getElementById('practice-cancel')?.addEventListener('click', close);
  document.getElementById('practice-backdrop')?.addEventListener('click', close);

  document.getElementById('practice-start')?.addEventListener('click', async () => {
    const hintEl = document.getElementById('practice-hint');
    const size = parseInt(document.getElementById('practice-size')?.value || '2', 10) || 2;
    const role = String(document.getElementById('practice-role')?.value || 'operative');
    const vibe = String(document.getElementById('practice-vibe')?.value || '').trim();
    const deckId = String(document.getElementById('practice-deck')?.value || 'standard');
    const stackingEnabled = !!document.getElementById('practice-stacking-toggle')?.checked;

    try {
      await startPracticeInApp({ size, role, vibe, deckId, stackingEnabled }, hintEl);
      closePracticeModal();
    } catch (e) {
      console.error(e);
      if (hintEl) hintEl.textContent = (e?.message || 'Could not start practice.');
    }
  });
}


function handlePracticeDeepLink() {
  try {
    const qs = new URLSearchParams(location.search || '');
    const gid = String(qs.get('practice') || '').trim();
    if (!gid) return false;
    if (!auth.currentUser || !getUserName()) return false;

    openPracticeGameInApp(gid);
    return true;
  } catch (_) {
    return false;
  }
}
