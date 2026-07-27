import { createContext, useContext, useEffect, useState, useRef } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, loginWithGoogle, logout, db, doc, setDoc } from "../firebase";
import { getDoc, serverTimestamp } from "firebase/firestore";

const AuthContext = createContext({ user: null, loading: true, login: () => {}, logout: () => {}, updateCommunity: () => {} });

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Write a presence heartbeat to Firestore: presence/{uid}.
 * Called immediately on auth and then every 30 seconds.
 */
async function writeHeartbeat(uid, communityId) {
  try {
    const payload = { lastSeen: serverTimestamp() };
    if (communityId) {
      payload.communityId = communityId;
    }
    await setDoc(doc(db, "presence", uid), payload, { merge: true });
  } catch (err) {
    // Non-fatal — presence is best-effort
    console.warn("Heartbeat write failed:", err.message);
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000; // 30 seconds

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null); // { uid, email, displayName, photoURL, communityId }
  const [loading, setLoading] = useState(true);
  const heartbeatRef = useRef(null);
  const communityRef = useRef(null); // Always tracks the latest communityId

  const fetchUserDoc = async (uid) => {
    try {
      const userDoc = await getDoc(doc(db, "users", uid));
      if (userDoc.exists()) {
        return userDoc.data();
      }
    } catch (err) {
      console.error("Failed to fetch user doc:", err);
    }
    return null;
  };

  const updateCommunity = async (newCommunityId) => {
    if (!user) return;
    try {
      await setDoc(doc(db, "users", user.uid), { communityId: newCommunityId }, { merge: true });
      communityRef.current = newCommunityId;
      setUser(prev => ({ ...prev, communityId: newCommunityId }));
      writeHeartbeat(user.uid, newCommunityId);
    } catch (err) {
      console.error("Failed to update community:", err);
      throw err;
    }
  };

  useEffect(() => {
    // Listen for auth state changes
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
        // Fetch custom data from Firestore
        const userData = await fetchUserDoc(firebaseUser.uid);
        const communityId = userData?.communityId || null;
        communityRef.current = communityId;

        const enhancedUser = {
          uid: firebaseUser.uid,
          email: firebaseUser.email,
          displayName: firebaseUser.displayName,
          photoURL: firebaseUser.photoURL,
          communityId,
        };

        setUser(enhancedUser);
        setLoading(false);

        // ── Presence heartbeat ─────────────────────────────────────────────
        writeHeartbeat(enhancedUser.uid, communityId);

        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          writeHeartbeat(firebaseUser.uid, communityRef.current);
        }, HEARTBEAT_INTERVAL_MS);
      } else {
        setUser(null);
        setLoading(false);
        communityRef.current = null;
        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
      }
    });

    return () => {
      unsubscribe();
      if (heartbeatRef.current) clearInterval(heartbeatRef.current);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login: loginWithGoogle, logout, updateCommunity }}>
      {children}
    </AuthContext.Provider>
  );
}
