# Security hardening (Firebase Auth + Firestore rules)

This build switches identity to **Firebase Authentication** and uses the **Auth `uid`** as the only user id.

Users sign in with **username + password** in the UI. Under the hood, the app stores a per-username internal sign-in handle and uses Firebase Authentication to securely store/verify the password. A username→uid registry in Firestore enforces uniqueness.

It also includes a starter `firestore.rules` that (a) blocks anonymous access, and (b) prevents non-admin users from deleting teams/players.

> No web app can be literally “unhackable”, but these changes stop the easy attack that wipes your tournament data (unauthenticated / overly-permissive writes) and gives you a real identity layer.

## 1) Enable the password sign-in provider
Firebase Console → **Authentication** → **Sign-in method** → enable the built-in **Password** provider (it may be labeled **Email/Password** in the console).

## 2) Deploy Firestore rules
Deploy the provided `firestore.rules`:
- Firebase Console → Firestore → Rules (paste + publish), or
- `firebase deploy --only firestore:rules`

## 3) Make an admin (custom claim)
The app’s admin features (backup/restore) require a Firebase Auth **custom claim**:
- `admin: true`

Example Node script (run with firebase-admin) to set an admin claim:

```js
// setAdminClaim.js
const admin = require('firebase-admin');
admin.initializeApp();

async function run() {
  const uid = process.argv[2];
  if (!uid) throw new Error('Usage: node setAdminClaim.js <uid>');
  await admin.auth().setCustomUserClaims(uid, { admin: true });
  console.log('Set admin claim for', uid);
}
run().catch((e) => { console.error(e); process.exit(1); });
```

Then have the admin user sign out + sign back in so the token refreshes.

## 4) Recommended next steps (stronger)
If you want **real anti-cheat / tamper resistance**, move sensitive writes server-side:
- game state transitions
- wins/losses increments
- backup/restore

And also enable:
- **App Check** (reduces scripted abuse)
- **Firestore PITR / backups** (true recovery)

