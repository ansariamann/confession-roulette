import { createContext, useContext, useEffect, useState, useRef } from "react";
import { onAuthStateChanged } from "firebase/auth";
import { auth, loginWithGoogle, logout, db, doc } from "../firebase";
import { getDoc, serverTimestamp, setDoc } from "firebase/firestore";

const AuthContext = createContext({
  user: null,
  loading: true,
  login: () => {},
  logout: () => {},
  updateCommunity: () => {},
  communityStats: null,
});

export function useAuth() {
  return useContext(AuthContext);
}

/**
 * Write a presence heartbeat to Firestore: presence/{uid}.
 * Called immediately on auth and then every 30 seconds.
 */
async function writeHeartbeat(uid, communityId) {
  try {
    const payload = {
      lastSeen: serverTimestamp(),
      // sortKey is a random float in [0, 1) used for scale-safe pivot sampling
      // when selecting drop recipients. Refreshed on every heartbeat so the
      // sampling distribution stays uniform across all active users.
      sortKey: Math.random(),
    };
    if (communityId) {
      payload.communityId = communityId;
    }
    await setDoc(doc(db, "presence", uid), payload, { merge: true });
  } catch (err) {
    console.warn("Heartbeat write failed:", err.message);
  }
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export default function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [communityStats, setCommunityStats] = useState(null);
  const heartbeatRef = useRef(null);
  const communityRef = useRef(null);

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

  /**
   * Join or switch community via server API.
   * Server updates users/{uid}, member counts, and presence atomically.
   */
  const updateCommunity = async (newCommunityName) => {
    if (!user) return null;
    try {
      const token = await auth.currentUser.getIdToken();
      // Use the local Next.js API route (always available, regardless of external server)
      const res = await fetch(`/api/community/join`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ communityName: newCommunityName }),
      });

      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Failed to join community");
      }

      communityRef.current = result.communityId;
      setUser((prev) => ({ ...prev, communityId: result.communityId }));
      setCommunityStats({
        memberCount: result.memberCount,
        activeCount: result.activeCount,
      });
      writeHeartbeat(user.uid, result.communityId);

      return result;
    } catch (err) {
      console.error("Failed to update community:", err);
      throw err;
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      if (firebaseUser) {
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

        writeHeartbeat(enhancedUser.uid, communityId);

        if (heartbeatRef.current) clearInterval(heartbeatRef.current);
        heartbeatRef.current = setInterval(() => {
          writeHeartbeat(firebaseUser.uid, communityRef.current);
        }, HEARTBEAT_INTERVAL_MS);
      } else {
        setUser(null);
        setCommunityStats(null);
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
    <AuthContext.Provider
      value={{
        user,
        loading,
        login: loginWithGoogle,
        logout,
        updateCommunity,
        communityStats,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}
