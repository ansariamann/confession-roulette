import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { doc, onSnapshot, collection, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import { DROP_DURATION_MS } from "../constants";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

// ── Verdict captions keyed by dominant emoji ─────────────────────────────────
const VERDICT_CAPTIONS = {
  "😂": "The jury has spoken: certified comedy gold",
  "💀": "The jury has spoken: certified unhinged",
  "😬": "The crowd winced in unison. Oof.",
  "❤️": "Somehow, this one hit different",
  "😳": "The crowd is shook. Speechless.",
};

const VERDICT_SUBTITLES = {
  "😂": "The crowd couldn't hold it together",
  "💀": "Someone call the coroner — this one killed the room",
  "😬": "That awkward silence just got louder",
  "❤️": "Against all odds, they felt that one",
  "😳": "Every jaw in the room just hit the floor",
};

const AUTO_RETURN_MS = 16_000; // Return to / after 16 seconds

/**
 * Determine the dominant emoji from the reactions map.
 * Returns the emoji with the highest count, or null if all are 0.
 */
function getDominantEmoji(reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return null;

  let maxEmoji = null;
  let maxCount = 0;

  for (const emoji of EMOJIS) {
    const count = reactions[emoji] || 0;
    if (count > maxCount) {
      maxCount = count;
      maxEmoji = emoji;
    }
  }

  return maxCount > 0 ? maxEmoji : null;
}

export default function VerdictScreen() {
  const { dropId } = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const { authorVerdicts } = useDrop();

  // State
  const [urlVerdict, setUrlVerdict] = useState(null);
  const [loading, setLoading] = useState(!!dropId && authorVerdicts.length === 0);
  const [error, setError] = useState(null);

  // Live state
  const [isLive, setIsLive] = useState(false);
  const [liveDropText, setLiveDropText] = useState("");
  const [liveReactions, setLiveReactions] = useState({});
  const [liveComments, setLiveComments] = useState([]);
  const [userRemainingMs, setUserRemainingMs] = useState(DROP_DURATION_MS);
  
  // Carousel swipe state for static verdicts
  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartXRef = useRef(null);

  // ── 1. Live Drop Listener ───────────────────────────────────────────────────
  useEffect(() => {
    if (!dropId || !user) return;

    let pollInterval = null;
    let countdownInterval = null;
    let unsubComments = () => {};

    const unsubDrop = onSnapshot(doc(db, "drops", dropId), (snapshot) => {
      if (snapshot.exists() && snapshot.data().status === "broadcasting") {
        setIsLive(true);
        setLoading(false);
        const data = snapshot.data();
        setLiveDropText(data.text || "");

        // Setup countdown
        if (data.broadcastStartedAt && typeof data.broadcastStartedAt.toMillis === "function") {
          const startMs = data.broadcastStartedAt.toMillis();
          if (!countdownInterval) {
            const tick = () => {
              const elapsed = Date.now() - startMs;
              setUserRemainingMs(Math.max(0, DROP_DURATION_MS - elapsed));
            };
            tick();
            countdownInterval = setInterval(tick, 500);
          }
        }

        // Setup reactions polling
        if (!pollInterval) {
          const poll = async () => {
            try {
              const res = await fetch(`/api/react?dropId=${dropId}`, { cache: "no-store" });
              if (res.ok) {
                const rData = await res.json();
                const counts = {};
                for (const [k, v] of Object.entries(rData.reactions || {})) {
                  counts[k] = parseInt(v, 10);
                }
                setLiveReactions(counts);
              }
            } catch (err) {}
          };
          poll();
          pollInterval = setInterval(poll, 800);
          
          // Setup comments listener
          const commentsQuery = query(
            collection(db, "drops", dropId, "comments"),
            orderBy("createdAt", "asc")
          );
          unsubComments = onSnapshot(commentsQuery, (cSnap) => {
            const comments = cSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
            setLiveComments(comments);
          });
        }
      } else {
        // Drop is gone or expired.
        setIsLive(false);
        if (countdownInterval) clearInterval(countdownInterval);
        if (pollInterval) clearInterval(pollInterval);
        unsubComments();
      }
    });

    return () => {
      unsubDrop();
      unsubComments();
      if (countdownInterval) clearInterval(countdownInterval);
      if (pollInterval) clearInterval(pollInterval);
    };
  }, [dropId, user]);

  // ── 2. Static Verdict Listener (Fallback after live) ────────────────────────
  useEffect(() => {
    if (!dropId || !user || isLive) return;

    const existing = authorVerdicts.find((v) => v.id === dropId);
    if (existing) {
      setUrlVerdict(existing);
      setLoading(false);
      return;
    }

    const unsubscribe = onSnapshot(
      doc(db, "verdicts", dropId),
      (snapshot) => {
        if (snapshot.exists()) {
          setUrlVerdict({ id: snapshot.id, ...snapshot.data() });
          setLoading(false);
          setError(null);
        }
      },
      (err) => {
        console.error("Verdict fetch error:", err);
        setError("Could not load the verdict.");
        setLoading(false);
      },
    );

    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          setError("Verdict timed out — the results may have already expired.");
          return false;
        }
        return prev;
      });
    }, 15_000);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [dropId, user, isLive, authorVerdicts]);

  // ── Data Resolution ────────────────────────────────────────────────────────
  // Combine verdicts list (authorVerdicts prioritized, or urlVerdict)
  const verdictsList = authorVerdicts.length > 0 ? authorVerdicts : urlVerdict ? [urlVerdict] : [];

  // Clamp current index
  useEffect(() => {
    if (currentIndex >= verdictsList.length && verdictsList.length > 0) {
      setCurrentIndex(verdictsList.length - 1);
    }
  }, [verdictsList.length, currentIndex]);

  // Live overriding logic
  let activeText = "";
  let activeReactions = {};
  let activeComments = [];
  
  if (isLive) {
    activeText = liveDropText;
    activeReactions = liveReactions;
    activeComments = liveComments;
  } else {
    const v = verdictsList[currentIndex] || null;
    if (v) {
      activeText = v.text || "";
      activeReactions = v.reactions || {};
      activeComments = v.comments || [];
    }
  }

  // ── Auto-return to Compose screen after viewing static verdict ─────────────
  useEffect(() => {
    // Only auto-return if we are viewing a static verdict
    if (isLive || verdictsList.length === 0) return;
    
    // We only auto-return if dropId is set (viewing specific) or if they are in the carousel.
    // Let's use the first verdict in the list to start the timer.
    const timer = setTimeout(() => {
      router.replace("/");
    }, AUTO_RETURN_MS);

    return () => clearTimeout(timer);
  }, [verdictsList.length, isLive, router]);

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const handlePrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < verdictsList.length - 1) setCurrentIndex((i) => i + 1);
  }, [currentIndex, verdictsList.length]);

  function handleTouchStart(e) {
    if (isLive) return; // No swiping while live
    touchStartXRef.current = e.touches[0].clientX;
  }

  function handleTouchEnd(e) {
    if (isLive || touchStartXRef.current === null) return;
    const diffX = touchStartXRef.current - e.changedTouches[0].clientX;
    touchStartXRef.current = null;

    if (diffX > 40) {
      handleNext();
    } else if (diffX < -40) {
      handlePrev();
    }
  }

  // ── Derived state ──────────────────────────────────────────────────────────
  const dominantEmoji = getDominantEmoji(activeReactions);
  const caption = dominantEmoji ? VERDICT_CAPTIONS[dominantEmoji] : "No reactions this time";
  const subtitle = dominantEmoji ? VERDICT_SUBTITLES[dominantEmoji] : "The confession vanished into the void";
  
  const totalReactions = Object.values(activeReactions).reduce((a, b) => a + b, 0);
  const maxCount = Math.max(1, ...Object.values(activeReactions));

  // ── RENDER: No verdicts ───────────────────────────────────────────────────
  if (!dropId && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="verdict-empty">
          <div className="screen-icon">⚖️</div>
          <h1 className="screen-title">Verdict</h1>
          <p className="screen-subtitle">
            No active verdict right now. Verdicts appear here automatically
            after a live drop expires.
          </p>
        </div>
      </div>
    );
  }

  // ── RENDER: Loading ────────────────────────────────────────────────────────
  if (loading && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="verdict-loading">
          <div className="loading-spinner" />
          <p className="screen-subtitle">Tallying the reactions…</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Error ──────────────────────────────────────────────────────────
  if (error && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="verdict-empty">
          <div className="expired-icon">⚠️</div>
          <h1 className="screen-title">Gone</h1>
          <p className="screen-subtitle">{error}</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Verdict result ─────────────────────────────────────────────────
  const userSeconds = Math.max(0, Math.ceil(userRemainingMs / 1000));
  const livePct = Math.max(0, Math.min(1, userRemainingMs / DROP_DURATION_MS)) * 100;

  const reactionRow = (
    <div className="react-line">
      {EMOJIS.map((emoji) => {
        const count = activeReactions[emoji] || 0;
        return (
          <span
            key={emoji}
            className={`react-chip ${count > 0 ? "on" : ""} ${
              !isLive && emoji === dominantEmoji && count > 0 ? "lead" : ""
            }`}
          >
            <span className="react-chip-emoji">{emoji}</span>
            <span className="react-chip-count">{count}</span>
          </span>
        );
      })}
      <span className="react-line-total">{totalReactions}</span>
    </div>
  );

  // ── RENDER: Live gathering (minimal) ───────────────────────────────────────
  if (isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="vlive">
          <div className="vlive-head">
            <span className="vlive-label">
              <span className="live-pulse" />
              gathering
            </span>
            <span className={`vlive-secs ${userSeconds <= 10 ? "urgent" : ""}`}>
              {String(userSeconds).padStart(2, "0")}
            </span>
          </div>

          <div className="vlive-track">
            <span className="vlive-track-fill" style={{ width: `${livePct}%` }} />
          </div>

          <p className="vlive-text">{activeText}</p>

          {reactionRow}

          <div className="vlive-comments">
            {activeComments.length === 0 ? (
              <p className="vlive-empty">No comments yet</p>
            ) : (
              activeComments.map((c) => (
                <div className="vlive-comment" key={c.id}>
                  {c.text}
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="screen"
      id="verdict-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="verdict-result">
        {/* Live Indicator Hero */}
        {isLive && (
          <div
            className="glass-card"
            style={{
              marginBottom: "1.5rem",
              padding: "1.25rem",
              background: "var(--paper-sunk)",
              borderRadius: "12px",
              border: "1px solid var(--hairline)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "8px"
            }}
          >
            <div className="live-meta-left" style={{ color: "var(--ink)" }}>
              <span className="live-pulse" />
              <span style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Live Reaction Gathering</span>
            </div>
            <div className={`live-timer ${userSeconds <= 10 ? "urgent" : ""}`} style={{ fontSize: "3rem", fontWeight: "800", color: "var(--ink)", lineHeight: 1 }}>
              {String(userSeconds).padStart(2, "0")}s
            </div>
            <div style={{ fontSize: "0.75rem", color: "var(--ink-soft)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              remaining before final verdict
            </div>
          </div>
        )}

        {/* Swipe deck header if multiple verdicts exist (not in live mode) */}
        {!isLive && verdictsList.length > 1 && (
          <div className="swipe-header">
            <button
              className="swipe-nav-btn"
              onClick={handlePrev}
              disabled={currentIndex === 0}
              aria-label="Previous verdict"
            >
              ‹
            </button>
            <div className="swipe-dots">
              {verdictsList.map((v, idx) => (
                <span
                  key={v.id}
                  className={`swipe-dot ${idx === currentIndex ? "active" : ""}`}
                  onClick={() => setCurrentIndex(idx)}
                />
              ))}
            </div>
            <button
              className="swipe-nav-btn"
              onClick={handleNext}
              disabled={currentIndex === verdictsList.length - 1}
              aria-label="Next verdict"
            >
              ›
            </button>
          </div>
        )}

        {/* Card counter badge */}
        {!isLive && verdictsList.length > 1 && (
          <div className="card-badge">
            Verdict {currentIndex + 1} of {verdictsList.length} ⟷
          </div>
        )}

        {/* Confession Text */}
        {activeText && (
          <div
            className="verdict-confession glass-card"
            style={{
              marginBottom: "1.5rem",
              padding: "1rem 1.25rem",
              background: "var(--paper-sunk)",
              borderRadius: "12px",
              border: "1px solid var(--hairline)",
              fontSize: "1rem",
              lineHeight: "1.5",
              color: "var(--ink)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--ink-soft)",
                marginBottom: "0.5rem",
              }}
            >
              Your Confession
            </div>
            "{activeText}"
          </div>
        )}

        {/* Dominant emoji hero */}
        {!isLive && (
          <div className="verdict-hero">
            <span className="verdict-dominant-emoji">
              {dominantEmoji || "🤷"}
            </span>
          </div>
        )}

        {/* Caption */}
        {!isLive && (
          <>
            <h1 className="screen-title verdict-caption">{caption}</h1>
            <p className="screen-subtitle">{subtitle}</p>
          </>
        )}

        {/* Stats badge */}
        <div className="verdict-stats" style={isLive ? { marginTop: "0.5rem" } : {}}>
          <span className="verdict-stat-number">{totalReactions}</span>
          <span className="verdict-stat-label">
            {totalReactions === 1 ? "reaction" : "reactions"} total
          </span>
        </div>

        {/* Final bar chart */}
        <div className="verdict-barchart glass-card">
          {EMOJIS.map((emoji) => {
            const count = activeReactions[emoji] || 0;
            const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
            const isDominant = !isLive && emoji === dominantEmoji;
            return (
              <div
                className={`bar-row ${isDominant ? "bar-row-dominant" : ""}`}
                key={emoji}
              >
                <span className="bar-emoji">{emoji}</span>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${isDominant ? "bar-fill-dominant" : ""}`}
                    style={{ width: `${width}%`, transition: isLive ? "width 0.3s ease-out" : "none" }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Comments */}
        {activeComments && activeComments.length > 0 && (
          <div
            className="comment-section static-comments"
            style={{ marginTop: "1rem", width: "100%" }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                color: "var(--ink-soft)",
                marginBottom: "0.5rem",
                textAlign: "center",
              }}
            >
              Comments ({activeComments.length})
            </div>
            <div
              className="comment-stream"
              style={{
                maxHeight: "150px",
                padding: "0.5rem",
                background: "var(--paper-sunk)",
                borderRadius: "12px",
                border: "1px solid var(--hairline)",
                overflowY: "auto",
              }}
            >
              {activeComments.map((c) => (
                <div className="comment-bubble" key={c.id}>
                  <span className="comment-text">{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-return indicator */}
        {!isLive && <p className="verdict-return-hint">Returning to compose shortly…</p>}
      </div>
    </div>
  );
}
