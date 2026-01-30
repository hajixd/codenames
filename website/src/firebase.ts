// Firebase (CDN ESM) — no bundler needed.
// If you want a newer version, update the URLs below consistently.
import { initializeApp, type FirebaseApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getFirestore,
  doc,
  onSnapshot,
  setDoc,
  serverTimestamp,
  type Firestore,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  type Auth,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';

type FirebaseConfig = {
  apiKey: string;
  authDomain?: string;
  projectId: string;
  appId?: string;
  measurementId?: string;
};

function readConfig(): FirebaseConfig | null {
  const w = window as unknown as { FIREBASE_CONFIG?: FirebaseConfig };
  const cfg = w.FIREBASE_CONFIG;
  if (!cfg) return null;
  if (!cfg.apiKey || !cfg.projectId) return null;
  return cfg;
}

export type FirebaseHandles = {
  app: FirebaseApp;
  db: Firestore;
  auth: Auth;
};

export function initFirebase(): FirebaseHandles | null {
  const cfg = readConfig();
  if (!cfg) return null;

  const app = initializeApp(cfg);
  const db = getFirestore(app);
  const auth = getAuth(app);

  // Best-effort anonymous auth (recommended for simple public apps).
  // If you don't enable Anonymous Auth in Firebase, Firestore may still work depending on your rules.
  try {
    onAuthStateChanged(auth, (u) => {
      if (!u) void signInAnonymously(auth).catch(() => {});
    });
  } catch {
    // ignore
  }

  return { app, db, auth };
}

export function subscribeTeams(
  db: Firestore,
  onData: (teams: unknown | null) => void,
  onError: (err: unknown) => void
) {
  const ref = doc(db, 'tournaments', 'default');
  return onSnapshot(
    ref,
    (snap) => {
      if (!snap.exists()) return onData(null);
      onData((snap.data() as any).teams ?? null);
    },
    (err) => onError(err)
  );
}

export async function ensureDefaultTeams(db: Firestore, teams: unknown) {
  const ref = doc(db, 'tournaments', 'default');
  await setDoc(ref, { teams, updatedAt: serverTimestamp() }, { merge: true });
}

export async function writeTeams(db: Firestore, teams: unknown) {
  const ref = doc(db, 'tournaments', 'default');
  await setDoc(ref, { teams, updatedAt: serverTimestamp() }, { merge: true });
}
