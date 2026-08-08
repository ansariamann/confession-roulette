// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace the placeholder values below with your real Firebase project
// credentials from https://console.firebase.google.com → Project Settings → Web App
// ──────────────────────────────────────────────────────────────────────────────

import { initializeApp } from "firebase/app";
import { getAuth, signInWithPopup, signInWithRedirect, getRedirectResult, GoogleAuthProvider, signOut, signInWithCredential } from "firebase/auth";
import { getFirestore, serverTimestamp, doc, setDoc } from "firebase/firestore";
import { getMessaging } from "firebase/messaging";
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';

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

export let app, auth, db, googleProvider, messaging;
export let loginWithGoogle, logout;

if (typeof window !== "undefined") {
  app = initializeApp(firebaseConfig);
  auth = getAuth(app);
  db = getFirestore(app);
  messaging = typeof window !== "undefined" && typeof navigator !== "undefined" && "serviceWorker" in navigator ? getMessaging(app) : null;
  googleProvider = new GoogleAuthProvider();

  loginWithGoogle = async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        const result = await FirebaseAuthentication.signInWithGoogle();
        const credential = GoogleAuthProvider.credential(result.credential.idToken);
        return await signInWithCredential(auth, credential);
      } else {
        return await signInWithPopup(auth, googleProvider);
      }
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
