// ─── Global Drop Context ────────────────────────────────────────────────────
// Runs a Firestore listener for broadcasting drops targeting the current user
// across ALL screens, AND listens for author verdicts for the confession author.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useEffect, useRef } from "react";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthProvider";

const DROP_TOTAL_LIFETIME_MS = 60_000;

const DropContext = createContext({
  /** Array of active drops targeted to the user: [{ id, text, broadcastStartedAt }] */
  activeDrops: [],
  /** The primary pending drop: { id, text, broadcastStartedAt } | null */
  pendingDrop: null,
  /** Call from LiveDropScreen to claim the drop and clear it from context */
  consumeDrop: () => {},
  /** Array of verdicts for confessions submitted by the author: [{ id, dropId, reactions, ... }] */
  authorVerdicts: [],
  /** The pending verdict for the confession author: { id, dropId, reactions, ... } | null */
  pendingVerdict: null,
  /** Call from VerdictScreen or AutoNav to claim the verdict */
  consumeVerdict: () => {},
  /** Whether the user is actively typing a confession (has text in the compose box) */
  isComposing: false,
  /** Set by ComposeScreen when the user has text in the textarea */
  setIsComposing: () => {},
});

export function useDrop() {
  return useContext(DropContext);
}

export default function DropProvider({ children }) {
  const { user } = useAuth();

  // Array of active drops targeting the user
  const [activeDrops, setActiveDrops] = useState([]);
  // The latest incoming drop for recipients
  const [pendingDrop, setPendingDrop] = useState(null);

  // Array of verdicts for the author
  const [authorVerdicts, setAuthorVerdicts] = useState([]);
  // The latest verdict for the author
  const [pendingVerdict, setPendingVerdict] = useState(null);

  // Whether the user is mid-composition
  const [isComposing, setIsComposing] = useState(false);

  // Track the ID of the drop currently being displayed to avoid re-triggering
  const activeDropIdRef = useRef(null);

  // ── Global Firestore listener for broadcasting drops (recipients) ────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "drops"),
      where("status", "==", "broadcasting"),
      where("recipientUids", "array-contains", user.uid),
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const dropsList = [];
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const broadcastStartedAt = data.broadcastStartedAt;

          if (!broadcastStartedAt) return;

          const startMs = typeof broadcastStartedAt.toMillis === "function"
            ? broadcastStartedAt.toMillis()
            : Date.now();
          const elapsed = Date.now() - startMs;

          if (elapsed < DROP_TOTAL_LIFETIME_MS) {
            dropsList.push({
              id: docSnap.id,
              text: data.text,
              broadcastStartedAt: startMs,
            });
          }
        });

        setActiveDrops(dropsList);
        setPendingDrop(dropsList.length > 0 ? dropsList[0] : null);
      },
      (error) => {
        console.error("❌ Drop listener error in DropContext:", error);
      }
    );

    return () => unsub();
  }, [user]);

  const sessionStartMs = useRef(Date.now() - 5000);

  // ── Global Firestore listener for author verdicts ────────────────────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "verdicts"),
      where("authorUid", "==", user.uid),
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const verdictsList = [];
      snapshot.docs.forEach((docSnap) => {
        const data = docSnap.data();
        const expiredAtMs = data.expiredAt?.toMillis ? data.expiredAt.toMillis() : Date.now();

        if (expiredAtMs >= sessionStartMs.current) {
          verdictsList.push({
            id: docSnap.id,
            ...data,
          });
        }
      });

      // Sort verdicts by most recent first
      verdictsList.sort((a, b) => {
        const aMs = a.expiredAt?.toMillis ? a.expiredAt.toMillis() : 0;
        const bMs = b.expiredAt?.toMillis ? b.expiredAt.toMillis() : 0;
        return bMs - aMs;
      });

      setAuthorVerdicts(verdictsList);

      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const expiredAtMs = data.expiredAt?.toMillis ? data.expiredAt.toMillis() : Date.now();

          // Only accept fresh verdicts created after session start
          if (expiredAtMs >= sessionStartMs.current) {
            setPendingVerdict({
              id: change.doc.id,
              ...data,
            });
          }
        }
      });
    });

    return () => unsub();
  }, [user]);

  // ── Consume helpers ──────────────────────────────────────────────────────
  function consumeDrop() {
    if (pendingDrop) {
      activeDropIdRef.current = pendingDrop.id;
    }
    setPendingDrop(null);
  }

  function clearActiveDrop() {
    activeDropIdRef.current = null;
  }

  function consumeVerdict() {
    setPendingVerdict(null);
  }

  return (
    <DropContext.Provider
      value={{
        activeDrops,
        pendingDrop,
        consumeDrop,
        clearActiveDrop,
        authorVerdicts,
        pendingVerdict,
        consumeVerdict,
        isComposing,
        setIsComposing,
      }}
    >
      {children}
    </DropContext.Provider>
  );
}
