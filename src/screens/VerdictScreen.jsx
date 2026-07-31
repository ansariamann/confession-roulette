import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";

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

  const [urlVerdict, setUrlVerdict] = useState(null);
  const [loading, setLoading] = useState(
    !!dropId && authorVerdicts.length === 0,
  );
  const [error, setError] = useState(null);

  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartXRef = useRef(null);

  // ── Fetch single verdict document if dropId is in URL ─────────────────────────
  useEffect(() => {
    if (!dropId || !user) return;

    // Check if already in authorVerdicts
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
  }, [dropId, user, authorVerdicts]);

  // Combine verdicts list (authorVerdicts prioritized, or urlVerdict)
  const verdictsList =
    authorVerdicts.length > 0 ? authorVerdicts : urlVerdict ? [urlVerdict] : [];

  // Clamp current index
  useEffect(() => {
    if (currentIndex >= verdictsList.length && verdictsList.length > 0) {
      setCurrentIndex(verdictsList.length - 1);
    }
  }, [verdictsList.length, currentIndex]);

  const currentVerdict = verdictsList[currentIndex] || null;

  // ── Auto-return to Compose screen after viewing ───────────────────────────
  useEffect(() => {
    if (!currentVerdict) return;

    const timer = setTimeout(() => {
      router.replace("/");
    }, AUTO_RETURN_MS);

    return () => clearTimeout(timer);
  }, [currentVerdict, router]);

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const handlePrev = useCallback(() => {
    if (currentIndex > 0) setCurrentIndex((i) => i - 1);
  }, [currentIndex]);

  const handleNext = useCallback(() => {
    if (currentIndex < verdictsList.length - 1) setCurrentIndex((i) => i + 1);
  }, [currentIndex, verdictsList.length]);

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

  // ── Derived state ──────────────────────────────────────────────────────────
  const reactions = currentVerdict?.reactions || {};
  const dominantEmoji = getDominantEmoji(reactions);
  const caption = dominantEmoji
    ? VERDICT_CAPTIONS[dominantEmoji]
    : "No reactions this time";
  const subtitle = dominantEmoji
    ? VERDICT_SUBTITLES[dominantEmoji]
    : "The confession vanished into the void";
  const totalReactions = currentVerdict?.totalReactions || 0;
  const maxCount = Math.max(1, ...Object.values(reactions));

  // ── RENDER: No verdicts ───────────────────────────────────────────────────
  if (!dropId && verdictsList.length === 0) {
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
  if (loading && verdictsList.length === 0) {
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
  if (error && verdictsList.length === 0) {
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
  return (
    <div
      className="screen"
      id="verdict-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      <div className="verdict-result">
        {/* Swipe deck header if multiple verdicts exist */}
        {verdictsList.length > 1 && (
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
        {verdictsList.length > 1 && (
          <div className="card-badge">
            Verdict {currentIndex + 1} of {verdictsList.length} ⟷
          </div>
        )}

        {/* Confession Text */}
        {currentVerdict?.text && (
          <div
            className="verdict-confession glass-card"
            style={{
              marginBottom: "1.5rem",
              padding: "1rem 1.25rem",
              background: "rgba(255,255,255,0.08)",
              borderRadius: "12px",
              fontSize: "1rem",
              lineHeight: "1.5",
              color: "rgba(255,255,255,0.95)",
              textAlign: "center",
            }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                opacity: 0.6,
                marginBottom: "0.5rem",
              }}
            >
              Your Confession
            </div>
            "{currentVerdict.text}"
          </div>
        )}

        {/* Dominant emoji hero */}
        <div className="verdict-hero">
          <span className="verdict-dominant-emoji">
            {dominantEmoji || "🤷"}
          </span>
        </div>

        {/* Caption */}
        <h1 className="screen-title verdict-caption">{caption}</h1>
        <p className="screen-subtitle">{subtitle}</p>

        {/* Stats badge */}
        <div className="verdict-stats">
          <span className="verdict-stat-number">{totalReactions}</span>
          <span className="verdict-stat-label">
            {totalReactions === 1 ? "reaction" : "reactions"} total
          </span>
        </div>

        {/* Final bar chart */}
        <div className="verdict-barchart glass-card">
          {EMOJIS.map((emoji) => {
            const count = reactions[emoji] || 0;
            const width = maxCount > 0 ? (count / maxCount) * 100 : 0;
            const isDominant = emoji === dominantEmoji;
            return (
              <div
                className={`bar-row ${isDominant ? "bar-row-dominant" : ""}`}
                key={emoji}
              >
                <span className="bar-emoji">{emoji}</span>
                <div className="bar-track">
                  <div
                    className={`bar-fill ${isDominant ? "bar-fill-dominant" : ""}`}
                    style={{ width: `${width}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Final Comments */}
        {currentVerdict?.comments && currentVerdict.comments.length > 0 && (
          <div
            className="comment-section static-comments"
            style={{ marginTop: "1rem", width: "100%" }}
          >
            <div
              style={{
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.1em",
                opacity: 0.6,
                marginBottom: "0.5rem",
                textAlign: "center",
              }}
            >
              Comments ({currentVerdict.comments.length})
            </div>
            <div
              className="comment-stream"
              style={{
                maxHeight: "150px",
                padding: "0.5rem",
                background: "rgba(255,255,255,0.05)",
                borderRadius: "12px",
                overflowY: "auto",
              }}
            >
              {currentVerdict.comments.map((c) => (
                <div className="comment-bubble" key={c.id}>
                  <span className="comment-text">{c.text}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Auto-return indicator */}
        <p className="verdict-return-hint">Returning to compose shortly…</p>
      </div>
    </div>
  );
}
