// ─── Global Drop Context ────────────────────────────────────────────────────
// Runs a Firestore listener for broadcasting drops targeting the current user
// across ALL screens, AND listens for author verdicts for the confession author.
// ─────────────────────────────────────────────────────────────────────────────

import { createContext, useContext, useState, useEffect, useRef, useCallback } from "react";
import { collection, query, where, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "./AuthProvider";
import { DROP_DURATION_MS } from "../constants";

const SEEN_DROPS_KEY = "seen-drop-ids";

function loadSeenDropIds() {
  try {
    const raw = sessionStorage.getItem(SEEN_DROPS_KEY);
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch {
    return new Set();
  }
}

function saveSeenDropIds(ids) {
  try {
    sessionStorage.setItem(SEEN_DROPS_KEY, JSON.stringify([...ids]));
  } catch {}
}

const DropContext = createContext({
  /** Array of active drops targeted to the user: [{ id, text, broadcastStartedAt }] */
  activeDrops: [],
  /** The primary pending drop: { id, text, broadcastStartedAt } | null */
  pendingDrop: null,
  /** Call from LiveDropScreen to claim the drop and clear it from context */
  consumeDrop: () => {},
  /** Mark a drop as seen so auto-nav won't re-trigger for it */
  markDropSeen: () => {},
  /** Array of verdicts for confessions submitted by the author: [{ id, dropId, reactions, ... }] */
  authorVerdicts: [],
  /** The pending verdict for the confession author: { id, dropId, reactions, ... } | null */
  pendingVerdict: null,
  /** Call from VerdictScreen or AutoNav to claim the verdict */
  consumeVerdict: () => {},
  /** The pending live drop for the author: { id, text, broadcastStartedAt } | null */
  pendingAuthorDrop: null,
  consumeAuthorDrop: () => {},
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

  const [activeDrops, setActiveDrops] = useState([]);
  const [pendingDrop, setPendingDrop] = useState(null);
  const [authorVerdicts, setAuthorVerdicts] = useState([]);
  const [pendingVerdict, setPendingVerdict] = useState(null);
  const [pendingAuthorDrop, setPendingAuthorDrop] = useState(null);
  const [activeAuthorDrops, setActiveAuthorDrops] = useState([]);
  const [activeAuthorDropId, setActiveAuthorDropId] = useState(null);
  const [activeAuthorDropData, setActiveAuthorDropData] = useState(null);
  const [isComposing, setIsComposing] = useState(false);

  const seenDropIdsRef = useRef(loadSeenDropIds());
  const knownVerdictIdsRef = useRef(null);
  const pendingVerdictQueueRef = useRef([]);

  const markDropSeen = useCallback((dropId) => {
    if (!dropId) return;
    seenDropIdsRef.current.add(dropId);
    saveSeenDropIds(seenDropIdsRef.current);
    setPendingDrop((prev) => (prev?.id === dropId ? null : prev));
  }, []);

  // ── Global Firestore listener for broadcasting drops (recipients) ────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "drops"),
      where("recipientUids", "array-contains", user.uid),
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const dropsList = [];
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const broadcastStartedAt = data.broadcastStartedAt;

          if (!broadcastStartedAt || typeof broadcastStartedAt.toMillis !== "function") {
            return;
          }

          const startMs = broadcastStartedAt.toMillis();
          const elapsed = Date.now() - startMs;

          if (elapsed < DROP_DURATION_MS) {
            dropsList.push({
              id: docSnap.id,
              text: data.text,
              broadcastStartedAt: startMs,
            });
          } else {
            // Drop expired server-side — mark seen so we don't re-notify
            seenDropIdsRef.current.add(docSnap.id);
          }
        });

        saveSeenDropIds(seenDropIdsRef.current);

        setActiveDrops(dropsList);

        // Only notify for drops the user hasn't been pulled in for yet
        const unseenDrop = dropsList.find((d) => !seenDropIdsRef.current.has(d.id));
        setPendingDrop(unseenDrop || null);
      },
      (error) => {
        console.error("❌ Drop listener error in DropContext:", error);
      },
    );

    return () => unsub();
  }, [user]);

  // ── Global Firestore listener for author LIVE drops ────────────────────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "drops"),
      where("authorUid", "==", user.uid),
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        if (snapshot.empty) {
          setActiveAuthorDrops([]);
          setActiveAuthorDropId(null);
          setActiveAuthorDropData(null);
          return;
        }
        
        const drops = [];
        snapshot.docs.forEach((docSnap) => {
          const data = docSnap.data();
          const broadcastStartedAt = data.broadcastStartedAt;
          if (broadcastStartedAt && typeof broadcastStartedAt.toMillis === "function") {
            const startMs = broadcastStartedAt.toMillis();
            const elapsed = Date.now() - startMs;
            if (elapsed < DROP_DURATION_MS) {
              drops.push({
                id: docSnap.id,
                text: data.text,
                broadcastStartedAt: startMs,
              });
            }
          }
        });
        
        // Sort oldest first (so they appear in order of submission)
        drops.sort((a, b) => a.broadcastStartedAt - b.broadcastStartedAt);
        setActiveAuthorDrops(drops);

        if (drops.length > 0) {
          const first = drops[0];
          setActiveAuthorDropId(first.id);
          setActiveAuthorDropData(first);
          
          // Only trigger auto-nav for the newest one, or just set it
          // Actually, if we have active drops, let's just trigger on the most recently added one
          const newest = drops[drops.length - 1];
          // We can use a ref to track which ones we've auto-navved to
          setPendingAuthorDrop(newest);
        } else {
          setActiveAuthorDropId(null);
          setActiveAuthorDropData(null);
        }
      },
      (error) => {
        console.error("❌ Author Drop listener error:", error);
      }
    );

    return () => unsub();
  }, [user]);

  function consumeDrop() {
    if (pendingDrop) {
      markDropSeen(pendingDrop.id);
    }
  }

  function consumeVerdict() {}

  const consumeAuthorDrop = useCallback(() => {
    setPendingAuthorDrop(null);
  }, []);

  return (
    <DropContext.Provider
      value={{
        activeDrops,
        pendingDrop,
        consumeDrop,
        markDropSeen,
        authorVerdicts,
        pendingVerdict,
        consumeVerdict,
        pendingAuthorDrop,
        consumeAuthorDrop,
        activeAuthorDrops,
        activeAuthorDropId,
        activeAuthorDropData,
        isComposing,
        setIsComposing,
      }}
    >
      {children}
    </DropContext.Provider>
  );
}
