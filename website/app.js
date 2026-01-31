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
const SOFT_TEAM_MAX = 4;

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
const LS_SETTINGS_ANIMATIONS = 'ct_animations_v1';
const LS_SETTINGS_SOUNDS = 'ct_sounds_v1';
const LS_SETTINGS_VOLUME = 'ct_volume_v1';
const LS_SETTINGS_THEME = 'ct_theme_v1';

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
  return !!cachedIsAdmin;
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
// Unread badges
let unreadGlobalUnsub = null;
let unreadTeamUnsub = null;
let unreadGlobalCache = [];
let unreadTeamCache = [];
let unreadGlobalCount = 0;
let unreadTeamCount = 0;
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

document.addEventListener('DOMContentLoaded', () => {
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
  initConfirmDialog();
  initQuickPlayGate();
  initLaunchScreen();
  initAuthGate();
  initHeaderLogoNav();
  initTabs();
  initName();
  initPlayersTab();
  initTeamModal();
  initCreateTeamModal();
  initMyTeamControls();
  initRequestsModal();
  initInvitesModal();
  initChatTab();
  initOnlineCounterUI();
  initUsernamesRegistryListener();
  initProfileDetailsModal();
  // Live Firestore listeners are started after sign-in (initAuthGate).

  // NOTE: initial navigation restore is handled after Firebase Auth resolves
  // (inside initAuthGate). Doing it here can cause a visible "flash".

});

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

function showAuthScreen() {
  const authScreen = document.getElementById('auth-screen');
  const modeScreen = document.getElementById('launch-screen');
  if (authScreen) authScreen.style.display = 'flex';
  if (modeScreen) modeScreen.style.display = 'none';
  document.body.classList.add('launch');
  document.body.classList.remove('quickplay');
  document.body.classList.remove('tournament');
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
  document.body.classList.add('launch');
  document.body.classList.remove('quickplay');
  document.body.classList.remove('tournament');
  document.body.classList.remove('has-team-color');
  setBrowserTitle('launch');
  try { refreshNameUI?.(); } catch (_) {}
}

function returnToLaunchScreen() {
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
      try { onProceed(); } finally { finish(); }
    });
    return;
  }

  const g = snap.data() || {};
  const inProgress = !!(g.currentPhase && g.currentPhase !== 'waiting' && g.winner == null);

  if (!inProgress) {
    scheduleAfterMinDelay(() => {
      try { onProceed(); } finally { finish(); }
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
    try {
      // Enter Quick Play, but skip the lobby so users never see it flash.
      enterAppFromLaunch('quick', { skipQuickLobby: true, restore: true });

      // Start a spectator preview of the live game so it plays behind the overlay.
      try { window.startQuickPlayLiveBackdrop?.({ spectator: true }); } catch (_) {}

      // Show the chooser.
      showQuickPlayGate({ gameId: QUICKPLAY_DOC_ID, canRejoin });
    } finally {
      finish();
    }
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

  const hint = document.getElementById('launch-name-hint');

  const requireAuthThen = (mode, opts = {}) => {
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
    setTimeout(() => {
      enterAppFromLaunch(mode);
      hideAuthLoadingScreen();
    }, 300);
  };

  // Quick Play can be gated if there's already a live game in progress.
  // In that case we keep the game running in the background and show a chooser.
  quickBtn?.addEventListener('click', () => requireAuthThen('quick', { gateIfLiveGame: true }));
  tournBtn?.addEventListener('click', () => requireAuthThen('tournament'));

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
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (_) {}

      await refreshAdminClaims();
      try { refreshNameUI(); } catch (_) {}
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
      try { await auth.signOut(); } catch (_) {}
    } finally {
      hideAuthLoadingScreen();
    }
  });

  modeLogoutBtn?.addEventListener('click', () => logoutLocal('Logging out'));

  // Default tab
  setAuthTab('login');

  refreshNameUI();
}

function enterAppFromLaunch(mode, opts = {}) {
  const screen = document.getElementById('launch-screen');
  if (screen) screen.style.display = 'none';
  const authScreen = document.getElementById('auth-screen');
  if (authScreen) authScreen.style.display = 'none';

  // Default: leave launch state.
  document.body.classList.remove('launch');
  document.body.classList.remove('tournament');

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

    // Defensive: ensure the generic mode chooser is never visible in Quick Play.
    // (On slow loads or if game.js hasn't initialized yet, the default UI can
    // briefly show the Quick/Tournament chooser, which looks like the click
    // "didn't work".)
    if (!opts || !opts.skipQuickLobby) {
      try {
        const chooser = document.getElementById('play-mode-select');
        if (chooser) chooser.style.display = 'none';
      } catch (_) {}
    }
    try { window.bumpPresence?.(); } catch (_) {}
    try {
      // Normally Quick Play shows its lobby. But when a live game is in-progress
      // and the user clicks Quick Play, we skip the lobby and show the 3-button chooser.
      if (!opts || !opts.skipQuickLobby) {
        if (typeof window.showQuickPlayLobby === 'function') window.showQuickPlayLobby();
      }
    } catch (_) {}
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

  // By default we land on Home, but when restoring after a refresh we let
  // the restore logic pick the correct panel without overwriting storage.
  if (!opts || !opts.restore) {
    switchToPanel('panel-home');
    safeLSSet(LS_NAV_PANEL, 'panel-home');
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
        // Ensure the loading screen stays up while we decide where to land.
        try { showAuthLoadingScreen('Loading'); } catch (_) {}
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
        try { clearLastNavigation(); } catch (_) {}
        try { showAuthScreen(); } catch (_) {}
        if (isBoot) finishBootAuthLoading(750);
        return;
      }

      // Ensure displayName exists (required for presence + UI).
      // Best-effort: if it's missing, resolve it from the username registry.
      try {
        const curName = String(u.displayName || '').trim();
        if (!curName) {
          const unameDoc = (usernamesCache || []).find(x => String(x?.uid || '').trim() === String(u.uid || '').trim());
          const fallbackName = String(unameDoc?.id || '').trim();
          if (fallbackName) {
            try { await u.updateProfile({ displayName: fallbackName }); } catch (_) {}
          }
        }
      } catch (_) {}

      // Ensure player profile exists.
      try {
        const uid = u.uid;
        const ref = db.collection('players').doc(uid);
        await ref.set({
          name: String(u.displayName || '').trim() || 'Player',
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      } catch (e) {
        console.warn('Failed to ensure player profile (best-effort)', e);
      }

      // Start listeners once.
      try { listenToTeams(); } catch (_) {}
      try { listenToPlayers(); } catch (_) {}

      // Presence must start after sign-in. Without this, "Who's Online" can't
      // mark anyone as online/idle.
      try {
        if (!presenceInitialized && getUserName()) {
          presenceInitialized = true;
          initPresence();
        }
      } catch (_) {}

      // Restore last navigation if available; otherwise show the mode chooser.
      try {
        restoreLastNavigation();
        const inMode = document.body.classList.contains('quickplay') || document.body.classList.contains('tournament');
        if (!inMode) showLaunchScreen();
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
  try { window.bumpPresence?.(); } catch (_) {}

  // Persist the user's last-viewed panel in Tournament mode (and mode itself), so refresh restores it.
  // In Quick Play we still store the mode so the launch screen is skipped on refresh.
  persistLastNavigation();

  // Ensure the Tournament "Play" tab never shows Quick Play options.
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
      }
    } catch (_) {}
  }
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
  if (!nextName) return;
  if (!isValidUsername(nextName)) {
    throw new Error('Username must be 3–20 chars: a-z, 0-9, _');
  }

  const prevName = normalizeUsername(getUserName());
  if (prevName && prevName === nextName) return;

  showAuthLoadingScreen('Updating name');

  // Used to avoid profile listener bouncing the UI during a local rename.
  lastLocalNameSetAtMs = Date.now();

  const uid = u.uid;
  const usernamesCol = db.collection('usernames');
  const usersCol = db.collection('users');
  const playersCol = db.collection('players');

  const oldRef = prevName ? usernamesCol.doc(prevName) : null;
  const newRef = usernamesCol.doc(nextName);

  try {
    await db.runTransaction(async (tx) => {
      const newSnap = await tx.get(newRef);
      if (newSnap.exists) {
        throw new Error('USERNAME_TAKEN');
      }

      let authHandle = String(u.email || '').trim();
      if (oldRef) {
        const oldSnap = await tx.get(oldRef);
        if (oldSnap.exists) {
          const d = oldSnap.data() || {};
          if (d.uid && String(d.uid) !== uid) {
            throw new Error('USERNAME_CONFLICT');
          }
          authHandle = String(d.authHandle || authHandle).trim();
          tx.delete(oldRef);
        }
      }

      tx.set(newRef, {
        uid,
        authHandle,
        createdAt: firebase.firestore.FieldValue.serverTimestamp(),
        renamedFrom: prevName || null,
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

    // Best-effort: keep team rosters up to date (for older docs that store embedded names).
    try { updateNameInAllTeams(getUserId(), nextName).catch(() => {}); } catch (_) {}
    try { refreshNameUI(); } catch (_) {}
  } finally {
    hideAuthLoadingScreen();
  }
}

function initName() {
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

  const savedDisplay = document.getElementById('name-saved-display');
  const headerDisplay = document.getElementById('user-name-display');
  const signedAs = document.getElementById('launch-signed-as');

  if (savedDisplay) savedDisplay.textContent = name || '—';
  if (headerDisplay) headerDisplay.textContent = name || '—';
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

  // Hide account-only header controls until signed in.
  const headerNamePill = document.getElementById('header-name-pill');
  const headerTeamPill = document.getElementById('header-team-pill');
  const settingsGear = document.getElementById('settings-gear-btn');
  if (headerNamePill) headerNamePill.style.display = canEnter ? '' : 'none';
  if (headerTeamPill) headerTeamPill.style.display = canEnter ? '' : 'none';
  if (settingsGear) settingsGear.style.display = '';

  // Update UI that depends on name (join buttons etc)
  renderTeams(teamsCache);
  renderMyTeam(teamsCache);
  recomputeMyTeamTabBadge();
  refreshHeaderIdentity();
}

function refreshHeaderIdentity() {
  const st = computeUserState(teamsCache);
  // Only show team name if actually on a team (not pending) - pending requests don't count
  const teamDisplayEl = document.getElementById('user-team-display');
  if (teamDisplayEl) {
    if (st.team) {
      const teamName = truncateTeamName(st.team.teamName || 'My team');
      teamDisplayEl.innerHTML = `<span class="profile-link" data-profile-type="team" data-profile-id="${esc(st.team.id)}">${esc(teamName)}</span>`;
    } else {
      teamDisplayEl.textContent = 'No team';
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
  // Count "full" teams (3+ members) - these are the ones that count toward the recommended slots
  const fullTeams = teams.filter(t => getMembers(t).length >= TEAM_MIN).length;
  const players = teams.reduce((sum, t) => sum + getMembers(t).length, 0);

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
  let team = null;
  const pendingTeams = [];
  for (const t of teams) {
    if (findUserInMembers(t, userId)) team = t;
    if (findUserInPending(t, userId)) pendingTeams.push(t);
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
    // We keep the app small (SOFT_MAX_TEAMS). Safest approach is to read all teams so we can:
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
          // Hard deletes are admin-only with locked-down rules.
          // If a team becomes empty, archive it instead.
          tx.update(db.collection('teams').doc(oldTeamId), {
            archived: true,
            archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
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

  // Sort teams by member count (most players first)
  const sortedTeams = [...teams].sort((a, b) => getMembers(b).length - getMembers(a).length);

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
    const isFull = members.length >= TEAM_MIN; // 3+ members = "full" team

    const tc = getDisplayTeamColor(t);
    const nameStyle = tc ? `style="color:${esc(tc)}"` : '';
    const itemStyle = isFull && tc ? `style="--team-accent:${esc(tc)}"` : '';
    const pillClass = isFull ? 'pill-full' : 'pill-incomplete';
    const overSize = members.length > SOFT_TEAM_MAX;

    const adminDeleteBtn = isAdminUser()
      ? `<button class="icon-btn danger small admin-delete-btn" type="button" data-admin-delete-team="${esc(t.id)}" title="Delete team">🗑</button>`
      : '';

    return `
      <button class="team-list-item ${isMine ? 'is-mine' : ''} ${isFull ? 'is-full' : ''}" type="button" data-team="${esc(t.id)}" ${itemStyle}>
        <div class="team-list-left">
          <div class="team-list-name ${isMine ? 'team-accent' : ''}"><span class="team-list-name-text profile-link" data-profile-type="team" data-profile-id="${esc(t.id)}" ${nameStyle}>${esc(truncateTeamName(t.teamName || 'Unnamed'))}</span></div>
          <div class="team-list-members" ${nameStyle}>${memberNamesHtml}</div>
        </div>
        <div class="team-list-right">
          <div class="team-list-count ${pillClass} ${overSize ? 'pill-overboard' : ''}">${members.length}/${SOFT_TEAM_MAX}</div>
          ${adminDeleteBtn}
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

  container.querySelectorAll('[data-admin-delete-team]')?.forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const tid = btn.getAttribute('data-admin-delete-team');
      if (!tid) return;
      await adminDeleteTeam(tid);
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
    if ((st.pendingTeamIds || []).includes(openTeamId)) {
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
    if (st.isCreator) {
      requestsBtn.style.display = 'inline-flex';
      requestsBtn.textContent = `Requests (${getPending(st.team).length})`;
    } else {
      requestsBtn.style.display = 'none';
    }
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
  if (!st.isCreator || !st.teamId) return;
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
  if (!st.isCreator || !st.team) {
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

  if (!invites.length) {
    list.innerHTML = '<div class="empty-state">No invites</div>';
    return;
  }

  const noName = !st.name;
  if (noName) setHint('invites-modal-hint', 'Set your name on Home first.');
  else setHint('invites-modal-hint', '');

  list.innerHTML = invites.map(inv => {
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
  const personalSelect = document.getElementById('chat-personal-select');
  const form = document.getElementById('chat-panel-form');

  const setMode = (mode) => {
    chatMode = (mode === 'team') ? 'team' : (mode === 'personal' ? 'personal' : 'global');
    btnGlobal?.classList.toggle('active', chatMode === 'global');
    btnTeam?.classList.toggle('active', chatMode === 'team');
    btnPersonal?.classList.toggle('active', chatMode === 'personal');
    btnGlobal?.setAttribute('aria-selected', chatMode === 'global' ? 'true' : 'false');
    btnTeam?.setAttribute('aria-selected', chatMode === 'team' ? 'true' : 'false');
    btnPersonal?.setAttribute('aria-selected', chatMode === 'personal' ? 'true' : 'false');

    if (personalBar) personalBar.style.display = chatMode === 'personal' ? 'flex' : 'none';

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
  btnPersonal?.addEventListener('click', () => setMode('personal'));

  // Personal chat recipient selector
  personalSelect?.addEventListener('change', () => {
    const uid = String(personalSelect.value || '').trim();
    setPersonalChatTarget(uid);
    if (activePanelId === 'panel-chat' && chatMode === 'personal') {
      startChatSubscription();
      markChatRead('personal');
    }
  });

  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    await sendChatTabMessage();
  });

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

  // Persist and sync UI select
  try { localStorage.setItem(LS_CHAT_PERSONAL, chatPersonalUserId || ''); } catch (_) {}
  const sel = document.getElementById('chat-personal-select');
  if (sel) {
    try { sel.value = chatPersonalUserId || ''; } catch (_) {}
  }
}

function refreshPersonalChatSelect() {
  const sel = document.getElementById('chat-personal-select');
  if (!sel) return;

  const me = String(getUserId() || '').trim();
  const options = [];

  // Placeholder
  options.push({ value: '', label: 'Choose a person…' });

  // Build from username registry (authoritative list of accounts)
  const all = (usernamesCache || [])
    .map(u => ({ uid: String(u?.uid || '').trim(), name: String(u?.id || '').trim() }))
    .filter(u => u.uid && u.name && u.uid !== me)
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const u of all) options.push({ value: u.uid, label: u.name });

  // Replace options
  const current = String(chatPersonalUserId || '').trim();
  sel.innerHTML = options.map(o => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');

  // Restore selection if still valid
  if (current && options.some(o => o.value === current)) {
    try { sel.value = current; } catch (_) {}
    chatPersonalUserName = getNameForAccount(current) || chatPersonalUserName;
  } else {
    // Clear invalid selection
    if (current) setPersonalChatTarget('');
    try { sel.value = ''; } catch (_) {}
  }
}

function openPersonalChatWith(userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const name = getNameForAccount(uid) || '';
  // Switch chat UI state
  chatMode = 'personal';
  setPersonalChatTarget(uid, name);
  // Update segmented buttons + personal bar
  try {
    document.getElementById('chat-mode-global')?.classList.remove('active');
    document.getElementById('chat-mode-team')?.classList.remove('active');
    document.getElementById('chat-mode-personal')?.classList.add('active');
    document.getElementById('chat-mode-global')?.setAttribute('aria-selected', 'false');
    document.getElementById('chat-mode-team')?.setAttribute('aria-selected', 'false');
    document.getElementById('chat-mode-personal')?.setAttribute('aria-selected', 'true');
    const bar = document.getElementById('chat-personal-bar');
    if (bar) bar.style.display = 'flex';
  } catch (_) {}

  // Navigate to Chat panel (desktop + mobile)
  switchToPanel('panel-chat');
  // Focus input (nice UX)
  setTimeout(() => {
    try { document.getElementById('chat-panel-input')?.focus(); } catch (_) {}
  }, 50);
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

  // Clear any previous subscription.
  if (chatUnsub) {
    try { chatUnsub(); } catch (_) {}
    chatUnsub = null;
  }

  const list = document.getElementById('chat-panel-messages');
  if (list) list.innerHTML = '<div class="empty-state">Loading…</div>';

  if (chatMode === 'personal') {
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

    const toName = chatPersonalUserName || getNameForAccount(otherId) || '—';
    setHint('chat-panel-hint', `To: ${toName}`);

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
    const teamName = team?.teamName ? truncateTeamName(String(team.teamName)) : '';
    const color = team ? getDisplayTeamColor(team) : '';

    const whoStyle = color ? `style="color:${esc(color)}"` : '';
    const senderHtml = senderId
      ? `<span class="profile-link" data-profile-type="player" data-profile-id="${esc(senderId)}" ${whoStyle}>${esc(senderName)}</span>`
      : `<span ${whoStyle}>${esc(senderName)}</span>`;
    const teamHtml = team
      ? ` <span class="profile-link" data-profile-type="team" data-profile-id="${esc(team.id)}" ${whoStyle}>(${esc(teamName)})</span>`
      : '';

    return `
      <div class="chat-msg">
        <div class="chat-line"><span class="chat-who">${senderHtml}${teamHtml}:</span> <span class="chat-text">${esc(m?.text || '')}</span></div>
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
      // Hard deletes are admin-only with locked-down rules. Archive instead.
      tx.update(teamRef, {
        archived: true,
        archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
      });
    });

    closeRequestsModal();
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
          // Hard deletes are admin-only with locked-down rules.
          // If a team becomes empty, archive it instead.
          tx.update(db.collection('teams').doc(oldTeamId), {
            archived: true,
            archivedAt: firebase.firestore.FieldValue.serverTimestamp(),
          });
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
      tx.update(ref, { pending: pending.filter(r => !isSameAccount(r, userId)) });
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

/* =========================
   Settings & Sound Effects
========================= */

// Settings state
let settingsAnimations = true;
let settingsSounds = true;
let settingsVolume = 70;
let settingsTheme = 'dark'; // 'dark' | 'light'

// Audio context for sound effects
let audioCtx = null;

function initSettings() {
  // Load saved settings from localStorage
  const savedAnimations = safeLSGet(LS_SETTINGS_ANIMATIONS);
  const savedSounds = safeLSGet(LS_SETTINGS_SOUNDS);
  const savedVolume = safeLSGet(LS_SETTINGS_VOLUME);
  const savedTheme = safeLSGet(LS_SETTINGS_THEME);

  settingsAnimations = savedAnimations !== 'false';
  settingsSounds = savedSounds !== 'false';
  settingsVolume = savedVolume ? parseInt(savedVolume, 10) : 70;

  settingsTheme = (savedTheme === 'light') ? 'light' : 'dark';

  // Apply initial state
  applyThemeSetting();
  applyAnimationsSetting();

  // Get UI elements
  const gearBtn = document.getElementById('settings-gear-btn');
  const modal = document.getElementById('settings-modal');
  const backdrop = document.getElementById('settings-modal-backdrop');
  const closeBtn = document.getElementById('settings-modal-close');
  const animToggle = document.getElementById('settings-animations-toggle');
  const themeToggle = document.getElementById('settings-theme-toggle');
  const soundToggle = document.getElementById('settings-sounds-toggle');
  const volumeSlider = document.getElementById('settings-volume-slider');
  const volumeValue = document.getElementById('settings-volume-value');
  const testSoundBtn = document.getElementById('settings-test-sound');

  if (!gearBtn || !modal) return;

  // Set initial values
  if (animToggle) animToggle.checked = settingsAnimations;
  if (themeToggle) themeToggle.checked = (settingsTheme === 'light');
  if (soundToggle) soundToggle.checked = settingsSounds;
  if (volumeSlider) volumeSlider.value = settingsVolume;
  if (volumeValue) volumeValue.textContent = settingsVolume + '%';

  // Admin actions
  const adminSection = document.getElementById('settings-admin');
  const adminBackupBtn = document.getElementById('admin-backup-now-btn');
  const adminRestoreBtn = document.getElementById('admin-restore-5min-btn');
  const adminHintEl = document.getElementById('admin-restore-hint');

  // Account danger action: delete the current user (frees username).
  const deleteAccountBtn = document.getElementById('settings-delete-account-btn');
  const deleteAccountHint = document.getElementById('settings-delete-account-hint');

  const refreshAdminUI = () => {
    const isAdmin = !!isAdminUser();
    if (adminSection) adminSection.style.display = isAdmin ? 'block' : 'none';
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

  adminRestoreBtn?.addEventListener('click', async () => {
    if (!isAdminUser()) return;
    playSound('click');

    const ok = await showCustomConfirm({
      title: 'Restore tournament data?',
      message: `This will <b>replace</b> the live <span class="mono">teams</span> and <span class="mono">players</span> collections with the most recent admin backup from <b>at or before ~5 minutes ago</b>.<br><br><b>There is no undo.</b>`,
      okText: 'Restore',
      danger: true
    });
    if (!ok) return;

    adminBackupBtn && (adminBackupBtn.disabled = true);
    adminRestoreBtn.disabled = true;
    try {
      setAdminHint('Restoring teams/players from backup…');
      const r = await adminRestoreFromMinutesAgo(5);
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
          const pw = window.prompt('Enter your password to confirm deletion:');
          if (!pw) throw new Error('Password required to delete account.');
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

// Theme toggle (Light mode)
themeToggle?.addEventListener('change', () => {
  settingsTheme = themeToggle.checked ? 'light' : 'dark';
  safeLSSet(LS_SETTINGS_THEME, settingsTheme);
  applyThemeSetting();
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
    closeSettingsModal();
    logoutLocal('Logging out');
  });

  // Change Name button in settings
  const settingsChangeNameBtn = document.getElementById('settings-change-name-btn');
  settingsChangeNameBtn?.addEventListener('click', () => {
    playSound('click');
    closeSettingsModal();
    openNameChangeModal();
  });

  // Change Password button in settings
  const settingsChangePasswordBtn = document.getElementById('settings-change-password-btn');
  settingsChangePasswordBtn?.addEventListener('click', () => {
    playSound('click');
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

function applyThemeSetting() {
  const isLight = settingsTheme === 'light';
  document.body.classList.toggle('light-mode', isLight);
  // Update browser theme color if present
  try {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', isLight ? '#f7f7f8' : '#09090b');
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


const PRESENCE_WHERE_LABELS = {
  menus: 'In Menus',
  tournament: 'In Tournament',
  lobby: 'In Lobby',
  game: 'In Game'
};

function computeLocalPresenceWhereKey() {
  // Prefer actual UI visibility over body classes (more robust across pages).
  const isDisplayed = (el) => {
    if (!el) return false;
    const st = window.getComputedStyle(el);
    return st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0';
  };

  // Game board visible -> either lobby or game (based on phase)
  const gameBoard = document.getElementById('game-board-container');
  if (isDisplayed(gameBoard)) {
    const phase = (typeof window.getCurrentGamePhase === 'function') ? window.getCurrentGamePhase() : null;
    if (phase && phase !== 'waiting') return 'game';
    return 'lobby';
  }

  // Tournament lobby visible
  const tournamentLobby = document.getElementById('tournament-lobby');
  if (isDisplayed(tournamentLobby)) return 'tournament';

  // Quick play lobby visible
  const quickLobby = document.getElementById('quick-play-lobby');
  if (isDisplayed(quickLobby)) return 'lobby';

  // Mode selection visible
  const modeSelect = document.getElementById('play-mode-select');
  if (isDisplayed(modeSelect)) return 'menus';

  // Tournament page visible
  const tournamentPage = document.getElementById('tournament-page') || document.getElementById('tournament-section');
  if (isDisplayed(tournamentPage)) return 'tournament';

  // Otherwise treat as menus/home
  return 'menus';
}

function getPresenceWhereLabel(presenceOrUserId) {
  const presence = resolvePresenceArg(presenceOrUserId);
  if (!presence) return '';
  const key = (presence.whereKey || presence.where || '').toString().trim();
  if (!key) return '';
  return presence.whereLabel || PRESENCE_WHERE_LABELS[key] || key;
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
  if (!countEl) return;

  const all = getAllKnownAccounts();
  const online = all.filter(p => getPresenceStatus(p) === 'online');
  countEl.textContent = online.length;
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

  // Remove from presence directory (so they disappear from Who's Online)
  try {
    await db.collection(PRESENCE_COLLECTION).doc(uid).delete();
  } catch (e) {
    // best effort
  }

  // Remove player profile (name + invites)
  try {
    await db.collection('players').doc(uid).delete();
  } catch (e) {
    // best effort
  }

  // Remove from all teams (and transfer ownership / delete empty teams if needed)
  const teams = Array.isArray(teamsCache) ? teamsCache.slice() : [];
  for (const t of teams) {
    const teamId = String(t?.id || '').trim();
    if (!teamId) continue;
    try {
      await adminRemoveUserFromTeam(teamId, uid);
    } catch (e) {
      // best effort
    }
  }

  // Clean up name registry entry if it points at this user
  try {
    const key = nameToAccountId((displayName || findKnownUserName(uid) || '').trim());
    if (key) {
      const ref = db.collection(NAME_REGISTRY_COLLECTION).doc(key);
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return;
        const data = snap.data() || {};
        const canon = String(data.canonicalId || data.userId || data.id || '').trim();
        if (canon && canon === uid) {
          tx.delete(ref);
        }
      });
    }
  } catch (e) {
    // best effort
  }
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
          <div class="online-user-status">${esc(getPresenceWhereLabel(p) || 'Active')}</div>
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
          <div class="online-user-status">last seen ${getTimeSinceActivity(p) || 'never'}</div>
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

    const setHint = (msg) => {
      if (hintEl) hintEl.textContent = String(msg || '3–20 chars (a–z, 0–9, _)');
    };

    if (!isValidUsername(newName)) {
      setHint('Invalid name. Use 3–20 chars: a–z, 0–9, _');
      return;
    }

    playSound('click');
    setHint('');
    try {
      await setUserName(newName);
      closeNameChangeModal();
    } catch (err) {
      const msg = String(err?.message || '');
      if (msg.includes('USERNAME_TAKEN')) {
        setHint("That name is taken. Try a different one.");
      } else if (msg.includes('USERNAME_CONFLICT')) {
        setHint('Could not rename. Please try again.');
      } else {
        setHint(msg || 'Could not update name.');
      }
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

// Show the auth loading screen with optional custom message
function showAuthLoadingScreen(message = 'Loading') {
  const screen = document.getElementById('auth-loading-screen');
  const desktopMsg = document.getElementById('auth-loading-message-desktop');
  const mobileMsg = document.getElementById('auth-loading-message-mobile');

  if (desktopMsg) desktopMsg.textContent = message;
  if (mobileMsg) mobileMsg.textContent = message;

  if (screen) {
    screen.style.display = 'flex';
    screen.classList.remove('hidden');
  }
}

// Hide the auth loading screen with a fade transition
function hideAuthLoadingScreen() {
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
  const isEligible = members.length >= TEAM_MIN;
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
          ${isEligible ? 'Tournament Ready' : 'Needs ' + (TEAM_MIN - members.length) + ' more'}
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
        return `
          <div class="profile-member">
            <span class="profile-member-name" style="color:${esc(memberColor)}">${esc(m.name || '—')}</span>
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

function renderPlayerProfile(playerId) {
  // Find player in cache
  const player = playersCache.find(p => p.id === playerId || entryAccountId(p) === playerId);
  if (!player) {
    renderProfileError('Player not found');
    return;
  }

  const titleEl = document.getElementById('profile-popup-title');
  const bodyEl = document.getElementById('profile-popup-body');
  if (!titleEl || !bodyEl) return;

  const name = (player.name || '—').trim();
  const roster = buildRosterIndex(teamsCache);
  const memberTeam = roster.memberTeamByUserId.get(player.id);
  const tc = memberTeam ? getDisplayTeamColor(memberTeam) : null;

  // Format dates
  const createdAt = player.createdAt ? formatRelativeTime(tsToMs(player.createdAt)) : 'Unknown';
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
        <span class="profile-stat-value ${memberTeam ? 'highlight' : ''}" style="${memberTeam && tc ? `color:${esc(tc)}` : ''}">${memberTeam ? esc(truncateTeamName(memberTeam.teamName || 'Team')) : 'No team'}</span>
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

  const isEligible = members.length >= TEAM_MIN;

  titleEl.innerHTML = `<span style="color:${esc(tc || 'var(--text)')}">${esc(team.teamName || 'Unnamed Team')}</span>`;

  bodyEl.innerHTML = `
    <div class="profile-stats">
      <div class="profile-stat-row">
        <span class="profile-stat-label">Status</span>
        <span class="profile-status ${isEligible ? 'eligible' : 'not-eligible'}">
          <span class="profile-status-dot"></span>
          ${isEligible ? 'Tournament Ready' : 'Needs ' + (TEAM_MIN - members.length) + ' more'}
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
  const name = (player.name || '—').trim();

  const presenceStatus = getPresenceStatus(player.id);
  const whereLabel = getPresenceWhereLabel(player.id);
  const statusBase = presenceStatus === 'online' ? 'Online' : (presenceStatus === 'idle' ? 'Idle' : 'Offline');
  const statusLine = presenceStatus === 'offline'
    ? statusBase
    : `${statusBase}${whereLabel ? ' — ' + whereLabel : ''}`;

  const joinedAt = player.createdAt ? formatRelativeTime(tsToMs(player.createdAt)) : 'Unknown';
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
