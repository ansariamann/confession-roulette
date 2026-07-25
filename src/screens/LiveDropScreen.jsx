import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection,
  addDoc,
  onSnapshot,
  doc,
  updateDoc,
  increment,
  serverTimestamp,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
const USER_VIEW_DURATION_MS = 20_000;  // 20s per user reading & voting window

export default function LiveDropScreen() {
  const { user } = useAuth();
  const { activeDrops } = useDrop();

  // Map of drops that have completed their 20s viewing window for this recipient: { [dropId]: boolean }
  const [expiredMap, setExpiredMap] = useState({});

  // Swiping card index within visible (unexpired) drops
  const [currentIndex, setCurrentIndex] = useState(0);

  // Map recording viewStart timestamp per drop ID so timer ONLY starts when user views card
  const viewStartMapRef = useRef({});

  // Countdown remaining time for current active card
  const [userRemainingMs, setUserRemainingMs] = useState(USER_VIEW_DURATION_MS);

  // Reaction counts per drop ID: { [dropId]: { "😂": 2, ... } }
  const [reactionsMap, setReactionsMap] = useState({});

  // Voted status per drop ID: { [dropId]: boolean }
  const [votedMap, setVotedMap] = useState({});

  // Reported status per drop ID: { [dropId]: boolean }
  const [reportedMap, setReportedMap] = useState({});

  // Touch drag tracking for swipe gestures
  const touchStartXRef = useRef(null);
  const countdownRef = useRef(null);

  // Filter to active drops that have NOT expired for this user
  const visibleDrops = activeDrops.filter((d) => !expiredMap[d.id]);

  // Clamp current index if visibleDrops size changes
  useEffect(() => {
    if (currentIndex >= visibleDrops.length && visibleDrops.length > 0) {
      setCurrentIndex(visibleDrops.length - 1);
    }
  }, [visibleDrops.length, currentIndex]);

  const currentDrop = visibleDrops[currentIndex] || null;

  // ── Record viewStart for current card & run 20s countdown ──────────────────
  useEffect(() => {
    if (!currentDrop) return;

    // Record view start timestamp if not already recorded (timer starts on active view!)
    if (!viewStartMapRef.current[currentDrop.id]) {
      viewStartMapRef.current[currentDrop.id] = Date.now();
    }

    const startMs = viewStartMapRef.current[currentDrop.id];

    const tick = () => {
      const elapsed = Date.now() - startMs;
      const remaining = Math.max(0, USER_VIEW_DURATION_MS - elapsed);

      setUserRemainingMs(remaining);

      if (remaining <= 0) {
        // Current card 20s window finished — mark expired so card disappears immediately
        setExpiredMap((prev) => ({ ...prev, [currentDrop.id]: true }));
        return;
      }

      countdownRef.current = requestAnimationFrame(tick);
    };

    countdownRef.current = requestAnimationFrame(tick);

    return () => {
      if (countdownRef.current) cancelAnimationFrame(countdownRef.current);
    };
  }, [currentDrop]);

  // ── Listen to reaction counts for current active drop ──────────────────────
  useEffect(() => {
    if (!currentDrop) return;

    const unsub = onSnapshot(
      collection(db, "drops", currentDrop.id, "reactions"),
      (snapshot) => {
        const counts = {};
        snapshot.forEach((d) => {
          counts[d.id] = d.data().count || 0;
        });
        setReactionsMap((prev) => ({
          ...prev,
          [currentDrop.id]: counts,
        }));
      },
    );

    return () => unsub();
  }, [currentDrop]);

  // ── Handle reaction tap for current drop ──────────────────────────────────
  const isVoted = currentDrop ? !!votedMap[currentDrop.id] : false;
  const canVote = currentDrop && !isVoted && userRemainingMs > 0;

  const handleReaction = useCallback(
    async (emoji) => {
      if (!currentDrop || !canVote) return;

      const dropId = currentDrop.id;
      setVotedMap((prev) => ({ ...prev, [dropId]: true }));

      try {
        const reactionRef = doc(db, "drops", dropId, "reactions", emoji);
        await updateDoc(reactionRef, { count: increment(1) });
      } catch (err) {
        console.error("Reaction failed:", err);
        setVotedMap((prev) => ({ ...prev, [dropId]: false }));
      }
    },
    [currentDrop, canVote],
  );

  // ── Handle report for current drop ────────────────────────────────────────
  const isReported = currentDrop ? !!reportedMap[currentDrop.id] : false;

  const handleReport = useCallback(
    async () => {
      if (!currentDrop || !user || isReported) return;
      const dropId = currentDrop.id;
      setReportedMap((prev) => ({ ...prev, [dropId]: true }));

      try {
        await addDoc(collection(db, "reports"), {
          dropId,
          reporterUid: user.uid,
          confessionText: currentDrop.text,
          reportedAt: serverTimestamp(),
        });
      } catch (err) {
        console.error("Report failed:", err);
        setReportedMap((prev) => ({ ...prev, [dropId]: false }));
      }
    },
    [currentDrop, user, isReported],
  );

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const handlePrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < visibleDrops.length - 1) setCurrentIndex((i) => i + 1);
  }, [currentIndex, visibleDrops.length]);

  function handleTouchStart(e) {
    touchStartXRef.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e) {
    if (touchStartXRef.current === null) return;
    const diffX = touchStartXRef.current - e.changedTouches[0].clientX;
    touchStartXRef.current = null;

    if (diffX > 40) {
      handleNext();
    } else if (diffX < -40) {
      handlePrev();
    }
  }

  // ── Compute countdown display values ───────────────────────────────────────
  const userSeconds = Math.max(0, Math.ceil(userRemainingMs / 1000));
  const progress = Math.max(0, Math.min(1, userRemainingMs / USER_VIEW_DURATION_MS));

  const RING_RADIUS = 54;
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;
  const ringOffset = RING_CIRCUMFERENCE * (1 - progress);

  const currentReactions = currentDrop ? reactionsMap[currentDrop.id] || {} : {};
  const maxCount = Math.max(1, ...Object.values(currentReactions));

  // ── RENDER: Waiting state (no visible drops) ───────────────────────────────
  if (!currentDrop || visibleDrops.length === 0) {
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
            Waiting for the next confession drop. You'll be pulled in
            automatically — no need to stay on this screen.
          </p>
        </div>
      </div>
    );
  }

  // ── RENDER: Live state with swiping card deck ──────────────────────────────
  return (
    <div
      className="screen"
      id="livedrop-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="livedrop-live">
        {/* Swipe deck header / pagination indicators */}
        {visibleDrops.length > 1 && (
          <div className="swipe-header">
            <button
              className="swipe-nav-btn"
              onClick={handlePrev}
              disabled={currentIndex === 0}
              aria-label="Previous confession"
            >
              ‹
            </button>
            <div className="swipe-dots">
              {visibleDrops.map((d, idx) => (
                <span
                  key={d.id}
                  className={`swipe-dot ${idx === currentIndex ? "active" : ""}`}
                  onClick={() => setCurrentIndex(idx)}
                />
              ))}
            </div>
            <button
              className="swipe-nav-btn"
              onClick={handleNext}
              disabled={currentIndex === visibleDrops.length - 1}
              aria-label="Next confession"
            >
              ›
            </button>
          </div>
        )}

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
          <span className="countdown-text">{userSeconds}</span>
        </div>

        {/* Confession card */}
        <div className="livedrop-confession glass-card swipeable-card">
          {visibleDrops.length > 1 && (
            <div className="card-badge">
              {currentIndex + 1} of {visibleDrops.length} ⟷
            </div>
          )}
          <p className="confession-text">{currentDrop.text}</p>
          <button
            className={`report-btn ${isReported ? "reported" : ""}`}
            onClick={handleReport}
            disabled={isReported}
            id="report-btn"
          >
            {isReported ? "Reported ✓" : "⚑ Report"}
          </button>
        </div>

        {/* Reaction buttons */}
        <div className="reaction-row">
          {EMOJIS.map((emoji) => (
            <button
              key={emoji}
              className={`reaction-btn ${!canVote ? "disabled" : ""}`}
              onClick={() => handleReaction(emoji)}
              disabled={!canVote}
              id={`reaction-${emoji}`}
            >
              <span className="reaction-emoji">{emoji}</span>
              <span className="reaction-count">
                {currentReactions[emoji] || 0}
              </span>
            </button>
          ))}
        </div>

        {/* Live bar chart */}
        <div className="livedrop-barchart glass-card">
          {EMOJIS.map((emoji) => {
            const count = currentReactions[emoji] || 0;
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
