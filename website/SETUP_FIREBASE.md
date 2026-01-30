# Firebase setup (teams live sync)

This site stores team/player names in **Firebase Firestore** (not local storage).

## 1) Create Firebase project
- Firebase Console → Add project
- Build → Firestore Database → Create database (production or test)

(Optional but recommended)
- Build → Authentication → Get started → Sign-in method → enable **Anonymous**

## 2) Add a Web app + copy config
- Project settings → Your apps → Web → Register app
- Copy the **config** object

## 3) Paste config into `website/config.js`
See `config.example.js`.

Example:
```js
window.FIREBASE_CONFIG = {
  apiKey: "…",
  authDomain: "…",
  projectId: "…",
  appId: "…",
};
```

## 4) Firestore rules
This app reads/writes:
- collection: `tournaments`
- doc: `default`

### Quick test rules (OPEN — do not use publicly)
```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tournaments/default {
      allow read, write: if true;
    }
  }
}
```

### Safer starter rules (requires Anonymous Auth)
```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /tournaments/default {
      allow read: if true;
      allow write: if request.auth != null;
    }
  }
}
```

## 5) Run / deploy
This is a static site. Serve `website/` with any static host.
- Open `website/index.html` via a local server (not `file://`) so modules load correctly.

If you change code, compile TypeScript:
```bash
cd website
npm install
npm run build
```
