import { useState, useEffect } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { doc, getDoc, onSnapshot } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";

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

const AUTO_RETURN_MS = 8_000; // Return to /live after 8 seconds

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
  const { user } = useAuth();
  const navigate = useNavigate();

  const [verdict, setVerdict] = useState(null);
  const [loading, setLoading] = useState(!!dropId);
  const [error, setError] = useState(null);

  // ── Fetch verdict document ─────────────────────────────────────────────────
  useEffect(() => {
    if (!dropId || !user) return;

    // Try fetching the verdict doc. The expiry sweeper may not have written
    // it yet (there can be a few seconds of delay), so we use onSnapshot
    // to catch it as soon as it appears.
    const unsubscribe = onSnapshot(
      doc(db, "verdicts", dropId),
      (snapshot) => {
        if (snapshot.exists()) {
          setVerdict({ id: snapshot.id, ...snapshot.data() });
          setLoading(false);
        }
        // If it doesn't exist yet, keep listening — the sweeper will write it soon
      },
      (err) => {
        console.error("Verdict fetch error:", err);
        setError("Could not load the verdict.");
        setLoading(false);
      },
    );

    // Timeout: if verdict never appears within 15s, stop waiting
    const timeout = setTimeout(() => {
      if (loading) {
        setLoading(false);
        setError("Verdict timed out — the results may have already expired.");
      }
    }, 15_000);

    return () => {
      unsubscribe();
      clearTimeout(timeout);
    };
  }, [dropId, user]);

  // ── Auto-return to Live Drop after showing the verdict ─────────────────────
  useEffect(() => {
    if (!verdict) return;

    const timer = setTimeout(() => {
      navigate("/live", { replace: true });
    }, AUTO_RETURN_MS);

    return () => clearTimeout(timer);
  }, [verdict, navigate]);

  // ── Derived state ──────────────────────────────────────────────────────────
  const reactions = verdict?.reactions || {};
  const dominantEmoji = getDominantEmoji(reactions);
  const caption = dominantEmoji
    ? VERDICT_CAPTIONS[dominantEmoji]
    : "No reactions this time";
  const subtitle = dominantEmoji
    ? VERDICT_SUBTITLES[dominantEmoji]
    : "The confession vanished into the void";
  const totalReactions = verdict?.totalReactions || 0;
  const maxCount = Math.max(1, ...Object.values(reactions));

  // ── RENDER: No dropId (navigated to /verdict directly) ─────────────────────
  if (!dropId) {
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
  if (loading) {
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
  if (error) {
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
    <div className="screen" id="verdict-screen">
      <div className="verdict-result">
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
                <span className="bar-count">{count}</span>
              </div>
            );
          })}
        </div>

        {/* Auto-return indicator */}
        <p className="verdict-return-hint">
          Returning to live feed shortly…
        </p>
      </div>
    </div>
  );
}
