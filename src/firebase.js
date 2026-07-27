// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace the placeholder values below with your real Firebase project
// credentials from https://console.firebase.google.com → Project Settings → Web App
// ──────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut } from "firebase/auth";
import { getFirestore, serverTimestamp, doc, setDoc } from "firebase/firestore";

export { serverTimestamp, doc, setDoc };

const firebaseConfig = {
  apiKey: "AIzaSyCn1M6nfNHC1hdky-egJVN6dFYo6xkxKRo",
  authDomain: "confession-roulette-a6b4b.firebaseapp.com",
  projectId: "confession-roulette-a6b4b",
  storageBucket: "confession-roulette-a6b4b.firebasestorage.app",
  messagingSenderId: "728793328944",
  appId: "1:728793328944:web:4ffd039e05d98aa97cecf5",
  measurementId: "G-5D839RZ3LT"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);

// Auth
export const auth = getAuth(app);
const googleProvider = new GoogleAuthProvider();

// Try popup first; if it fails (mobile / blocked), fall back to redirect
export const loginWithGoogle = async () => {
  try {
    return await signInWithPopup(auth, googleProvider);
  } catch (err) {
    if (err.code === "auth/popup-blocked" || err.code === "auth/cancelled-popup-request") {
      return signInWithRedirect(auth, googleProvider);
    }
    throw err;
  }
};

// Handle redirect result on page load (no-op if no redirect occurred)
getRedirectResult(auth).catch((err) => {
  console.warn("Redirect result check:", err.message);
});

export const logout = () => signOut(auth);

// Firestore
export const db = getFirestore(app);

export default app;
