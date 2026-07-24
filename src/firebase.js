// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace the placeholder values below with your real Firebase project
// credentials from https://console.firebase.google.com → Project Settings → Web App
// ──────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
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

// Auth — anonymous sign-in helper
export const auth = getAuth(app);
export const loginAnonymously = () => signInAnonymously(auth);

// Firestore
export const db = getFirestore(app);

export default app;
