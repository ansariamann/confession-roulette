import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
  increment,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
const DROP_DURATION_MS = 10_000;

export default function LiveDropScreen() {
  const { user } = useAuth();
  const navigate = useNavigate();

  // Drop state
  const [drop, setDrop] = useState(null); // { id, text, broadcastStartedAt }
  const [phase, setPhase] = useState("waiting"); // waiting | live | expired

  // Countdown driven by server timestamp
  const [remainingMs, setRemainingMs] = useState(DROP_DURATION_MS);

  // Reactions
  const [reactions, setReactions] = useState({}); // { "😂": 5, "💀": 3, ... }
  const [voted, setVoted] = useState(false);

  // Refs for cleanup
  const dropUnsubRef = useRef(null);
  const reactionsUnsubRef = useRef(null);
  const countdownRef = useRef(null);

  // ── Listen for broadcasting drops targeting this user ──────────────────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "drops"),
      where("status", "==", "broadcasting"),
      where("recipientUids", "array-contains", user.uid),
    );

    const unsub = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const data = change.doc.data();
          const broadcastStartedAt = data.broadcastStartedAt;

          // Firestore timestamps might be null on the initial local write (pending)
          if (!broadcastStartedAt) return;

          const startMs = broadcastStartedAt.toMillis();
          const elapsed = Date.now() - startMs;
          const remaining = DROP_DURATION_MS - elapsed;

          // Skip if already expired
          if (remaining <= 0) return;

          setDrop({
            id: change.doc.id,
            text: data.text,
            broadcastStartedAt: startMs,
          });
          setRemainingMs(remaining);
          setPhase("live");
          setVoted(false);
          setReactions({});
        }

        if (change.type === "modified") {
          const data = change.doc.data();
          if (data.status === "expired") {
            setPhase("expired");
          }
        }

        if (change.type === "removed") {
          setPhase("expired");
        }
      });
    });

    dropUnsubRef.current = unsub;
    return () => unsub();
  }, [user]);

  // ── Server-authoritative countdown ─────────────────────────────────────────
  useEffect(() => {
    if (phase !== "live" || !drop) return;

    const tick = () => {
      const elapsed = Date.now() - drop.broadcastStartedAt;
      const remaining = DROP_DURATION_MS - elapsed;

      if (remaining <= 0) {
        setRemainingMs(0);
        setPhase("expired");
        return;
      }

      setRemainingMs(remaining);
      countdownRef.current = requestAnimationFrame(tick);
    };

    countdownRef.current = requestAnimationFrame(tick);

    return () => {
      if (countdownRef.current) cancelAnimationFrame(countdownRef.current);
    };
  }, [phase, drop]);

  // ── Listen to reaction counts ──────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "live" || !drop) return;

    const unsub = onSnapshot(
      collection(db, "drops", drop.id, "reactions"),
      (snapshot) => {
        const counts = {};
        snapshot.forEach((doc) => {
          counts[doc.id] = doc.data().count || 0;
        });
        setReactions(counts);
      },
    );

    reactionsUnsubRef.current = unsub;
    return () => unsub();
  }, [phase, drop]);

  // ── Navigate to Verdict screen when drop expires ───────────────────────────
  useEffect(() => {
    if (phase !== "expired" || !drop) return;

    const dropId = drop.id;

    // Reset local state so returning to /live starts fresh
    setPhase("waiting");
    setDrop(null);
    setReactions({});
    setRemainingMs(DROP_DURATION_MS);

    // Navigate to the Verdict screen with the dropId
    navigate(`/verdict/${dropId}`, { replace: true });
  }, [phase, drop, navigate]);

  // ── Handle reaction tap ────────────────────────────────────────────────────
  const handleReaction = useCallback(
    async (emoji) => {
      if (!drop || voted) return;
      setVoted(true);

      try {
        const reactionRef = doc(db, "drops", drop.id, "reactions", emoji);
        await updateDoc(reactionRef, { count: increment(1) });
      } catch (err) {
        console.error("Reaction failed:", err);
        setVoted(false); // allow retry on error
      }
    },
    [drop, voted],
  );

  // ── Compute countdown display values ───────────────────────────────────────
  const seconds = Math.max(0, Math.ceil(remainingMs / 1000));
  const progress = Math.max(0, Math.min(1, remainingMs / DROP_DURATION_MS));

  // SVG countdown ring params
  const RING_RADIUS = 54;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const ringOffset = RING_CIRCUMFERENCE * (1 - progress);

  // Bar chart max value
  const maxCount = Math.max(1, ...Object.values(reactions));

  // ── RENDER: Waiting state ──────────────────────────────────────────────────
  if (phase === "waiting") {
    return (
      <div className="screen" id="livedrop-screen">
        <div className="livedrop-waiting">
          <div className="radar-container">
            <div className="radar-ring radar-ring-1" />
            <div className="radar-ring radar-ring-2" />
            <div className="radar-ring radar-ring-3" />
            <div className="radar-dot">📡</div>
          </div>
          <h1 className="screen-title">Listening…</h1>
          <p className="screen-subtitle">
            Waiting for the next confession drop. Stay on this screen — it'll
            appear the moment one is broadcast to you.
          </p>
        </div>
      </div>
    );
  }

  // ── RENDER: Live state ─────────────────────────────────────────────────────
  return (
    <div className="screen" id="livedrop-screen">
      <div className="livedrop-live">
        {/* Countdown ring */}
        <div className="countdown-container">
          <svg className="countdown-ring" viewBox="0 0 120 120">
            <circle
              className="countdown-track"
              cx="60"
              cy="60"
              r={RING_RADIUS}
            />
            <circle
              className="countdown-progress"
              cx="60"
              cy="60"
              r={RING_RADIUS}
              strokeDasharray={RING_CIRCUMFERENCE}
              strokeDashoffset={ringOffset}
            />
          </svg>
          <span className="countdown-text">{seconds}</span>
        </div>

        {/* Confession card */}
        <div className="livedrop-confession glass-card">
          <p className="confession-text">{drop?.text}</p>
        </div>

        {/* Reaction buttons */}
        <div className="reaction-row">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className={`reaction-btn ${voted ? "disabled" : ""}`}
              onClick={() => handleReaction(emoji)}
              disabled={voted}
              id={`reaction-${emoji}`}
            >
              <span className="reaction-emoji">{emoji}</span>
              <span className="reaction-count">{reactions[emoji] || 0}</span>
            </button>
          ))}
        </div>

        {/* Live bar chart */}
        <div className="livedrop-barchart glass-card">
          {EMOJIS.map((emoji) => {
            const count = reactions[emoji] || 0;
            const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
            return (
              <div className="bar-row" key={emoji}>
                <span className="bar-emoji">{emoji}</span>
                <div className="bar-track">
                  <div
                    className="bar-fill"
                    style={{ width: `${width}%` }}
                  />
                </div>
                <span className="bar-count">{count}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
