// ---------------------------------------------------------------------------
// Firebase configuration
// ---------------------------------------------------------------------------
// SETUP (one time — see quiz/README.md for the full walk-through)
// 1. https://console.firebase.google.com -> your project
// 2. Build -> Firestore Database (production mode)
// 3. Build -> Authentication -> Sign-in method:
//        enable "Anonymous"        (students)
//        enable "Email/Password"   (faculty)
//    then Authentication -> Users -> "Add user" -> create YOUR faculty account.
// 4. Put that faculty email in ADMIN_EMAILS below *and* in the Firestore rules
//    (README.md). The rules are the real security; this list only controls the UI.
// 5. Firestore -> Rules -> paste the rules from README.md -> Publish.
// ---------------------------------------------------------------------------

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth, signInAnonymously, signInWithEmailAndPassword, signOut,
  onAuthStateChanged, setPersistence, browserLocalPersistence,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

// Project: "Faculty" (faculty-89598). Firestore + Auth only — no Analytics,
// no Realtime Database, so no databaseURL is needed here.
const firebaseConfig = {
  apiKey: "AIzaSyDnYxdpg6-b39WszDXyjTU4_87t-4KLQ8E",
  authDomain: "faculty-89598.firebaseapp.com",
  projectId: "faculty-89598",
  storageBucket: "faculty-89598.firebasestorage.app",
  messagingSenderId: "1018027509777",
  appId: "1:1018027509777:web:c4047c590740f35c8c49b0",
  measurementId: "G-FBTLJH43QT",
};

// Faculty accounts allowed to open the dashboard. MUST match the list inside
// your Firestore rules — the rules are what actually enforces this.
export const ADMIN_EMAILS = [
  "hinlukaku@gmail.com",
];

export const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);

// Students: anonymous sign-in. The uid is what ties an attempt to one browser,
// so a classmate cannot read or edit someone else's attempt.
export async function ensureAuth() {
  try {
    await setPersistence(auth, browserLocalPersistence);
    if (!auth.currentUser) await signInAnonymously(auth);
    return auth.currentUser;
  } catch (err) {
    console.warn("Anonymous auth failed (is it enabled in Firebase?):", err);
    return null;
  }
}

// Faculty: real email/password sign-in.
export async function signInAdmin(email, password) {
  await setPersistence(auth, browserLocalPersistence);
  const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
  return cred.user;
}

export function signOutAdmin() {
  return signOut(auth);
}

export function onAdminChange(cb) {
  return onAuthStateChanged(auth, cb);
}

export function isAdminUser(user) {
  return !!(user && user.email && ADMIN_EMAILS.includes(user.email.toLowerCase()));
}
