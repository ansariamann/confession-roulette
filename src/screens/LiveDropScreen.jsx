import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection,
  addDoc,
  onSnapshot,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  increment,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import { io } from "socket.io-client";
import useFeedback from "../hooks/useFeedback";

const SOCKET_URL = import.meta.env.VITE_SOCKET_URL || "http://localhost:3001";
const socket = io(SOCKET_URL, { autoConnect: false });

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
const EMOJI_LABELS = {
  "😂": "Dying",
  "💀": "Cooked",
  "😬": "Yikes",
  "❤️": "Respect",
  "😳": "No way",
};
const USER_VIEW_DURATION_MS = 30_000;  // 30s per user reading & voting window
const MAX_COMMENT_LENGTH = 80;

export default function LiveDropScreen() {
  const { user } = useAuth();
  const { activeDrops } = useDrop();
  const { playReaction, playDrop, vibrate } = useFeedback();

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

  // Emoji burst particles for the addictive tap feedback
  const [bursts, setBursts] = useState([]);
  const burstIdRef = useRef(0);

  // Rising emoji from remote reactions
  const [risers, setRisers] = useState([]);
  const riserIdRef = useRef(0);
  const prevReactionsRef = useRef({});

  // Settings
  const [settings] = useState(() => {
    try {
      const saved = localStorage.getItem("verdict-settings");
      return saved
        ? JSON.parse(saved)
        : { soundEffects: true, vibration: true, autoScrollComments: true };
    } catch {
      return { soundEffects: true, vibration: true, autoScrollComments: true };
    }
  });

  // Comments per drop: { [dropId]: [{ id, text, createdAt }] }
  const [commentsMap, setCommentsMap] = useState({});
  // Whether the user already commented on a given drop: { [dropId]: boolean }
  const [commentedMap, setCommentedMap] = useState({});
  // Current comment text being typed
  const [commentText, setCommentText] = useState("");

  // Filter to active drops that have NOT expired for this user
  const visibleDrops = activeDrops.filter((d) => !expiredMap[d.id]);

  // Clamp current index if visibleDrops size changes
  useEffect(() => {
    if (currentIndex >= visibleDrops.length && visibleDrops.length > 0) {
      setCurrentIndex(visibleDrops.length - 1);
    }
  }, [visibleDrops.length, currentIndex]);

  const currentDrop = visibleDrops[currentIndex] || null;

  // ── Manage Socket.IO connection ───────────────────────────────────────────
  useEffect(() => {
    socket.connect();
    return () => {
      socket.disconnect();
    };
  }, []);

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

        // Detect remote reaction changes → fire rising emoji
        const prev = prevReactionsRef.current[currentDrop.id] || {};
        for (const emoji of EMOJIS) {
          const diff = (counts[emoji] || 0) - (prev[emoji] || 0);
          if (diff > 0) {
            const newRisers = Array.from({ length: Math.min(diff, 3) }, () => {
              riserIdRef.current += 1;
              return {
                key: riserIdRef.current,
                emoji,
                x: 10 + Math.random() * 80, // % from left
                delay: Math.random() * 200,
                scale: 0.6 + Math.random() * 0.6,
              };
            });
            setRisers((r) => [...r, ...newRisers]);
            setTimeout(() => {
              const keys = new Set(newRisers.map((r) => r.key));
              setRisers((r) => r.filter((ri) => !keys.has(ri.key)));
            }, 2000);
          }
        }
        prevReactionsRef.current[currentDrop.id] = counts;

        setReactionsMap((prev) => ({
          ...prev,
          [currentDrop.id]: counts,
        }));
      },
    );

    return () => unsub();
  }, [currentDrop]);

  // ── Check if user already voted on this drop (survives page reload) ────────
  useEffect(() => {
    if (!currentDrop || !user) return;
    const dropId = currentDrop.id;

    // If we already know they voted (from local state), skip the network check
    if (votedMap[dropId]) return;

    const voterRef = doc(db, "drops", dropId, "voters", user.uid);
    getDoc(voterRef)
      .then((snap) => {
        if (snap.exists()) {
          setVotedMap((prev) => ({ ...prev, [dropId]: true }));
        }
      })
      .catch(() => {}); // Ignore errors (drop may have been deleted)
  }, [currentDrop, user]);

  // ── Listen to comments for current drop (via Socket.IO) ────────────────────
  useEffect(() => {
    if (!currentDrop) return;
    const dropId = currentDrop.id;

    // Join the drop room
    socket.emit("join_drop", dropId);

    // Initial load for late joiners
    const handleInitialComments = (initialComments) => {
      setCommentsMap((prev) => ({ ...prev, [dropId]: initialComments }));
    };

    // Live new comments
    const handleNewComment = (commentObj) => {
      setCommentsMap((prev) => {
        const existing = prev[dropId] || [];
        return { ...prev, [dropId]: [...existing, commentObj] };
      });
    };

    socket.on("initial_comments", handleInitialComments);
    socket.on("new_comment", handleNewComment);

    return () => {
      socket.off("initial_comments", handleInitialComments);
      socket.off("new_comment", handleNewComment);
    };
  }, [currentDrop]);

  // ── Auto-scroll comments ──────────────────────────────────────────────────
  const commentsEndRef = useRef(null);
  useEffect(() => {
    if (settings.autoScrollComments && commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [commentsMap, settings.autoScrollComments]);

  // ── Handle reaction tap for current drop ──────────────────────────────────
  const isVoted = currentDrop ? !!votedMap[currentDrop.id] : false;
  const canVote = currentDrop && !isVoted && userRemainingMs > 0;

  const handleReaction = useCallback(
    async (emoji) => {
      if (!currentDrop || !canVote || !user) return;

      const dropId = currentDrop.id;
      setVotedMap((prev) => ({ ...prev, [dropId]: true }));

      // Sound & haptic feedback
      playReaction();
      vibrate(40);

      // Fire a burst of floating emoji particles
      const seeds = Array.from({ length: 7 }, () => {
        burstIdRef.current += 1;
        return {
          key: burstIdRef.current,
          emoji,
          x: (Math.random() - 0.5) * 140,
          delay: Math.random() * 180,
          scale: 0.7 + Math.random() * 0.8,
        };
      });
      setBursts((prev) => [...prev, ...seeds]);
      setTimeout(() => {
        const keys = new Set(seeds.map((s) => s.key));
        setBursts((prev) => prev.filter((b) => !keys.has(b.key)));
      }, 1400);

      try {
        // 1. Write voter doc (Firestore rules enforce uniqueness — second create fails)
        const voterRef = doc(db, "drops", dropId, "voters", user.uid);
        await setDoc(voterRef, { emoji, votedAt: serverTimestamp() });

        // 2. Increment aggregate reaction counter
        const reactionRef = doc(db, "drops", dropId, "reactions", emoji);
        await updateDoc(reactionRef, { count: increment(1) });
      } catch (err) {
        // If the voter doc already existed, Firestore rules reject the create
        // — the user already voted (e.g. from a reload). Keep votedMap = true.
        if (err?.code === "permission-denied" || err?.code === "already-exists") {
          console.warn("Already voted on this drop.");
        } else {
          console.error("Reaction failed:", err);
          setVotedMap((prev) => ({ ...prev, [dropId]: false }));
        }
      }
    },
    [currentDrop, canVote, user],
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

  // ── Handle comment submit ─────────────────────────────────────────────────
  const handleCommentSubmit = useCallback(
    async (e) => {
      e.preventDefault();
      if (!currentDrop || !user || !commentText.trim()) return;
      const dropId = currentDrop.id;
      if (commentedMap[dropId]) return; // already commented

      const trimmed = commentText.trim().slice(0, MAX_COMMENT_LENGTH);
      setCommentedMap((prev) => ({ ...prev, [dropId]: true }));
      setCommentText("");

      // Send to Socket.IO instead of Firestore
      socket.emit("send_comment", { dropId, text: trimmed });
    },
    [currentDrop, user, commentText, commentedMap],
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

  const currentReactions = currentDrop ? reactionsMap[currentDrop.id] || {} : {};
  const maxCount = Math.max(1, ...Object.values(currentReactions));
  const totalVotes = Object.values(currentReactions).reduce((a, b) => a + b, 0);
  const topEmoji = EMOJIS.reduce(
    (best, e) => ((currentReactions[e] || 0) > (currentReactions[best] || 0) ? e : best),
    EMOJIS[0],
  );

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
      className="screen live-stage"
      id="livedrop-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Story progress segments */}
      <div className="story-bars">
        {visibleDrops.map((d, idx) => (
          <button
            key={d.id}
            className="story-bar"
            onClick={() => setCurrentIndex(idx)}
            aria-label={`Confession ${idx + 1}`}
          >
            <span
              className="story-bar-fill"
              style={{
                width:
                  idx < currentIndex
                    ? "100%"
                    : idx === currentIndex
                      ? `${(1 - progress) * 100}%`
                      : "0%",
              }}
            />
          </button>
        ))}
      </div>

      <div className="live-meta">
        <span className="live-meta-left">
          <span className="live-pulse" />
          Anonymous · {currentIndex + 1}/{visibleDrops.length}
        </span>
        <span className={`live-timer ${userSeconds <= 5 ? "urgent" : ""}`}>
          {String(userSeconds).padStart(2, "0")}s
        </span>
      </div>

      {/* Immersive confession stage */}
      <div className="confession-stage swipeable-card" key={currentDrop.id}>
        <span className="stage-quote" aria-hidden="true">“</span>
        <p className="stage-text">{currentDrop.text}</p>

        <div className="stage-foot">
          <span className="stage-count">
            {totalVotes > 0 ? `${totalVotes} reacted` : "Be the first to react"}
          </span>
          <button
            className={`report-btn ${isReported ? "reported" : ""}`}
            onClick={handleReport}
            disabled={isReported}
            id="report-btn"
          >
            {isReported ? "Reported" : "Report"}
          </button>
        </div>

        <div className="burst-layer" aria-hidden="true">
          {bursts.map((b) => (
            <span
              key={b.key}
              className="burst-emoji"
              style={{
                "--bx": `${b.x}px`,
                animationDelay: `${b.delay}ms`,
                fontSize: `${22 * b.scale}px`,
              }}
            >
              {b.emoji}
            </span>
          ))}
        </div>
      </div>

      {/* Rising emoji from remote reactions */}
      <div className="rise-layer" aria-hidden="true">
        {risers.map((r) => (
          <span
            key={r.key}
            className="rise-emoji"
            style={{
              left: `${r.x}%`,
              animationDelay: `${r.delay}ms`,
              fontSize: `${20 * r.scale}px`,
            }}
          >
            {r.emoji}
          </span>
        ))}
      </div>

      {/* Reaction dock */}
      <div className={`reaction-dock ${isVoted ? "locked" : ""}`}>
        {EMOJIS.map((emoji) => (
          <button
            key={emoji}
            className={`react-tile ${!canVote ? "disabled" : ""} ${
              isVoted && emoji === topEmoji ? "top" : ""
            }`}
            onClick={() => handleReaction(emoji)}
            disabled={!canVote}
            id={`reaction-${emoji}`}
          >
            <span className="react-emoji">{emoji}</span>
            <span className="react-label">{EMOJI_LABELS[emoji]}</span>
            <span className="react-count">{currentReactions[emoji] || 0}</span>
          </button>
        ))}
      </div>

      {/* Live pulse bars */}
      <div className="live-results">
        {EMOJIS.map((emoji) => {
          const count = currentReactions[emoji] || 0;
          const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
          const pct = totalVotes ? Math.round((count / totalVotes) * 100) : 0;
          return (
            <div className={`pulse-row ${emoji === topEmoji && count > 0 ? "lead" : ""}`} key={emoji}>
              <span className="pulse-emoji">{emoji}</span>
              <div className="pulse-track">
                <div className="pulse-fill" style={{ width: `${width}%` }} />
              </div>
              <span className="pulse-pct">{pct}%</span>
            </div>
          );
        })}
      </div>

      {/* Live comment stream */}
      {(() => {
        const comments = currentDrop ? commentsMap[currentDrop.id] || [] : [];
        const hasCommented = currentDrop ? !!commentedMap[currentDrop.id] : false;
        return (
          <div className="comment-section">
            {comments.length > 0 && (
              <div className="comment-stream">
                {comments.map((c) => (
                  <div className="comment-bubble" key={c.id}>
                    <span className="comment-text">{c.text}</span>
                  </div>
                ))}
                <div ref={commentsEndRef} />
              </div>
            )}
            <form className="comment-bar" onSubmit={handleCommentSubmit}>
              <input
                type="text"
                className="comment-input"
                placeholder={hasCommented ? "Comment sent ✓" : "Drop a comment…"}
                value={commentText}
                onChange={(e) => setCommentText(e.target.value)}
                maxLength={MAX_COMMENT_LENGTH}
                disabled={hasCommented || userRemainingMs <= 0}
                id="comment-input"
              />
              <button
                type="submit"
                className="comment-send"
                disabled={hasCommented || !commentText.trim() || userRemainingMs <= 0}
                id="comment-send-btn"
              >
                ↑
              </button>
            </form>
          </div>
        );
      })()}

      {visibleDrops.length > 1 && (
        <div className="stage-nav">
          <button onClick={handlePrev} disabled={currentIndex === 0} aria-label="Previous confession">
            ← Prev
          </button>
          <span>swipe</span>
          <button
            onClick={handleNext}
            disabled={currentIndex === visibleDrops.length - 1}
            aria-label="Next confession"
          >
            Next →
          </button>
        </div>
      )}
    </div>
  );
}
