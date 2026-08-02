// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace the placeholder values below with your real Firebase project
// credentials from https://console.firebase.google.com → Project Settings → Web App
// ──────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut } from "firebase/auth";
import { getFirestore, serverTimestamp, doc, setDoc } from "firebase/firestore";

export { serverTimestamp, doc, setDoc };

export const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://886awm9wzc.execute-api.us-east-1.amazonaws.com/prod";
export const WS_URL = process.env.NEXT_PUBLIC_WS_URL || "wss://2fhcm11n2d.execute-api.us-east-1.amazonaws.com/prod";

const firebaseConfig = {
  apiKey: "AIzaSyCn1M6nfNHC1hdky-egJVN6dFYo6xkxKRo",
  authDomain: "confession-roulette-a6b4b.firebaseapp.com",
  projectId: "confession-roulette-a6b4b",
  storageBucket: "confession-roulette-a6b4b.firebasestorage.app",
  messagingSenderId: "728793328944",
  appId: "1:728793328944:web:4ffd039e05d98aa97cecf5",
  measurementId: "G-5D839RZ3LT"
};

export let app, auth, db, googleProvider;
export let loginWithGoogle, logout;

if (typeof window !== "undefined") {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  googleProvider = new GoogleAuthProvider();

  loginWithGoogle = async () => {
    try {
      return await signInWithPopup(auth, googleProvider);
    } catch (err) {
      if (err.code === "auth/popup-blocked" || err.code === "auth/cancelled-popup-request") {
        return signInWithRedirect(auth, googleProvider);
      }
      throw err;
    }
  };

  getRedirectResult(auth).catch((err) => {
    console.warn("Redirect result check:", err.message);
  });

  logout = () => signOut(auth);
}
