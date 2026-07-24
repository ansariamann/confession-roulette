import { createContext, useContext, useEffect, useState, useRef } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, loginAnonymously, db, doc, setDoc, serverTimestamp } from "../firebase";

const AuthContext = createContext({ user: null, loading: true });

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Write a presence heartbeat to Firestore: presence/{uid}.
 * Called immediately on auth and then every 30 seconds.
 */
async function writeHeartbeat(uid) {
  try {
    await setDoc(doc(db, "presence", uid), {
      lastSeen: serverTimestamp(),
    });
  } catch (err) {
    // Non-fatal — presence is best-effort
    console.warn("Heartbeat write failed:", err.message);
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const heartbeatRef = useRef(null);

  useEffect(() => {
    // Listen for auth state changes
    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        setLoading(false);

        // ── Presence heartbeat ─────────────────────────────────────────────
        // Write immediately, then every 30 seconds
        writeHeartbeat(firebaseUser.uid);

        // Clear any existing interval (e.g. on re-auth)
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);

        heartbeatRef.current = setInterval(() => {
          writeHeartbeat(firebaseUser.uid);
        }, HEARTBEAT_INTERVAL_MS);
      } else {
        // No user → trigger anonymous sign-in automatically
        loginAnonymously().catch((err) => {
          console.error("Anonymous sign-in failed:", err);
          setLoading(false);
        });
      }
    });

    return () => {
      unsubscribe();
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading }}>
      {children}
    </AuthContext.Provider>
  );
}
