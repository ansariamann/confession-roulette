import { useState, useEffect, useRef, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { doc, onSnapshot, collection, query, orderBy } from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import { DROP_DURATION_MS } from "../constants";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

const VERDICT_CAPTIONS = {
  "😂": "Certified comedy gold",
  "💀": "The room did not survive",
  "😬": "The crowd winced in unison",
  "❤️": "Somehow, this one hit different",
  "😳": "Every jaw in the room just dropped",
};

const AUTO_RETURN_MS = 18_000;

function getDominantEmoji(reactions) {
  if (!reactions || Object.keys(reactions).length === 0) return null;
  let maxEmoji = null;
  let maxCount = 0;
  for (const emoji of EMOJIS) {
    const count = reactions[emoji] || 0;
    if (count > maxCount) { maxCount = count; maxEmoji = emoji; }
  }
  return maxCount > 0 ? maxEmoji : null;
}

// Thin SVG arc timer ring
function ArcTimer({ progress, seconds, isUrgent }) {
  const r = 44;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - progress);
  return (
    <div className="arc-timer-wrap">
      <svg className="arc-timer-svg" viewBox="0 0 100 100">
        <circle className="arc-bg" cx="50" cy="50" r={r} />
        <circle
          className={`arc-fill${isUrgent ? " arc-fill-urgent" : ""}`}
          cx="50" cy="50" r={r}
          strokeDasharray={circ}
          strokeDashoffset={dash}
        />
      </svg>
      <div className="arc-timer-inner">
        <span className={`arc-seconds${isUrgent ? " urgent" : ""}`}>{seconds}</span>
        <span className="arc-unit">sec</span>
      </div>
    </div>
  );
}

// Instagram-style horizontal emoji pill strip
function EmojiStrip({ reactions, dominant, isLive }) {
  const total = Object.values(reactions).reduce((a, b) => a + b, 0);
  return (
    <div className="emoji-strip">
      {EMOJIS.map((emoji) => {
        const count = reactions[emoji] || 0;
        const isDom = emoji === dominant && !isLive;
        return (
          <div key={emoji} className={`emoji-pill${isDom ? " emoji-pill-dom" : ""}`}>
            <span className="emoji-pill-icon">{emoji}</span>
            <span className="emoji-pill-count">{count}</span>
          </div>
        );
      })}
    </div>
  );
}

export default function VerdictScreen() {
  const { dropId: urlDropId } = useParams();
  const router = useRouter();
  const { user } = useAuth();
  const { authorVerdicts, activeAuthorDropId } = useDrop();

  // Use URL dropId first, otherwise fall back to the active author drop
  const effectiveDropId = urlDropId || activeAuthorDropId;

  // If we arrived at the generic /verdict route but have an active live drop, update the URL
  useEffect(() => {
    if (!urlDropId && activeAuthorDropId) {
      router.replace(`/verdict/${activeAuthorDropId}`);
    }
  }, [urlDropId, activeAuthorDropId, router]);

  const [urlVerdict, setUrlVerdict] = useState(null);
  const [loading, setLoading] = useState(!!effectiveDropId && authorVerdicts.length === 0);
  const [error, setError] = useState(null);

  const [isLive, setIsLive] = useState(false);
  const [liveDropText, setLiveDropText] = useState("");
  const [liveReactions, setLiveReactions] = useState({});
  const [liveComments, setLiveComments] = useState([]);
  const [userRemainingMs, setUserRemainingMs] = useState(DROP_DURATION_MS);

  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartXRef = useRef(null);
  const commentsEndRef = useRef(null);

  // ── 1. Live Drop Listener ─────────────────────────────────────────────────
  useEffect(() => {
    if (!effectiveDropId || !user) return;
    let pollInterval = null;
    let countdownInterval = null;
    let unsubComments = () => {};

    const unsubDrop = onSnapshot(doc(db, "drops", effectiveDropId), (snapshot) => {
      if (snapshot.exists() && snapshot.data().status === "broadcasting") {
        setIsLive(true);
        setLoading(false);
        const data = snapshot.data();
        setLiveDropText(data.text || "");

        if (data.broadcastStartedAt && typeof data.broadcastStartedAt.toMillis === "function") {
          const startMs = data.broadcastStartedAt.toMillis();
          if (!countdownInterval) {
            const tick = () => {
              const elapsed = Date.now() - startMs;
              const remaining = Math.max(0, DROP_DURATION_MS - elapsed);
              setUserRemainingMs(remaining);
              if (remaining <= 0) {
                setIsLive(false);
              }
            };
            tick();
            countdownInterval = setInterval(tick, 500);
          }
        }

        if (!pollInterval) {
          const poll = async () => {
            try {
              const res = await fetch(`/api/react?dropId=${effectiveDropId}`, { cache: "no-store" });
              if (res.ok) {
                const rData = await res.json();
                const counts = {};
                for (const [k, v] of Object.entries(rData.reactions || {})) {
                  counts[k] = parseInt(v, 10);
                }
                setLiveReactions(counts);
              }
            } catch {}
          };
          poll();
          pollInterval = setInterval(poll, 800);

          const commentsQuery = query(
            collection(db, "drops", effectiveDropId, "comments"),
            orderBy("createdAt", "asc")
          );
          unsubComments = onSnapshot(commentsQuery, (cSnap) => {
            setLiveComments(cSnap.docs.map((d) => ({ id: d.id, ...d.data() })));
          });
        }
      } else {
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
  }, [effectiveDropId, user]);

  // ── 2. Static Verdict Listener ───────────────────────────────────────────
  useEffect(() => {
    if (!effectiveDropId || !user || isLive) return;
    const existing = authorVerdicts.find((v) => v.id === effectiveDropId);
    if (existing) { setUrlVerdict(existing); setLoading(false); return; }

    const unsubscribe = onSnapshot(doc(db, "verdicts", effectiveDropId), (snapshot) => {
      if (snapshot.exists()) {
        setUrlVerdict({ id: snapshot.id, ...snapshot.data() });
        setLoading(false);
        setError(null);
      }
    }, (err) => {
      setError("Could not load the verdict.");
      setLoading(false);
    });

    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) { setError("Verdict timed out — results may have already expired."); return false; }
        return prev;
      });
    }, 15_000);

    return () => { unsubscribe(); clearTimeout(timeout); };
  }, [effectiveDropId, user, isLive, authorVerdicts]);

  // ── Data Resolution ───────────────────────────────────────────────────────
  const verdictsList = authorVerdicts.length > 0 ? authorVerdicts : urlVerdict ? [urlVerdict] : [];

  useEffect(() => {
    if (currentIndex >= verdictsList.length && verdictsList.length > 0) {
      setCurrentIndex(verdictsList.length - 1);
    }
  }, [verdictsList.length, currentIndex]);

  let activeText = "";
  let activeReactions = {};
  let activeComments = [];

  if (isLive) {
    activeText = liveDropText;
    activeReactions = liveReactions;
    activeComments = liveComments;
  } else {
    const v = verdictsList[currentIndex] || null;
    if (v) { activeText = v.text || ""; activeReactions = v.reactions || {}; activeComments = v.comments || []; }
  }

  // ── Auto-return ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (isLive || verdictsList.length === 0) return;
    const timer = setTimeout(() => router.replace("/"), AUTO_RETURN_MS);
    return () => clearTimeout(timer);
  }, [verdictsList.length, isLive, router]);

  // ── Auto-scroll comments ─────────────────────────────────────────────────
  useEffect(() => {
    if (commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [activeComments]);

  // ── Swipe handlers ────────────────────────────────────────────────────────
  const handlePrev = useCallback(() => { if (currentIndex > 0) setCurrentIndex((i) => i - 1); }, [currentIndex]);
  const handleNext = useCallback(() => { if (currentIndex < verdictsList.length - 1) setCurrentIndex((i) => i + 1); }, [currentIndex, verdictsList.length]);

  function handleTouchStart(e) { if (isLive) return; touchStartXRef.current = e.touches[0].clientX; }
  function handleTouchEnd(e) {
    if (isLive || touchStartXRef.current === null) return;
    const diffX = touchStartXRef.current - e.changedTouches[0].clientX;
    touchStartXRef.current = null;
    if (diffX > 40) handleNext();
    else if (diffX < -40) handlePrev();
  }

  // ── Derived ───────────────────────────────────────────────────────────────
  const dominant = getDominantEmoji(activeReactions);
  const caption = dominant ? VERDICT_CAPTIONS[dominant] : "The void received your confession";
  const userSeconds = Math.max(0, Math.ceil(userRemainingMs / 1000));
  const progress = Math.max(0, Math.min(1, userRemainingMs / DROP_DURATION_MS));
  const isUrgent = userSeconds <= 5;

  // ── RENDER: Empty ─────────────────────────────────────────────────────────
  if (!effectiveDropId && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="vrd-empty">
          <div className="vrd-empty-icon">⚖️</div>
          <h1 className="screen-title">Verdict</h1>
          <p className="screen-subtitle">No active verdict right now. Verdicts appear here automatically after a live drop expires.</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Loading ───────────────────────────────────────────────────────
  if (loading && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="vrd-empty">
          <div className="loading-spinner" />
          <p className="screen-subtitle">Tallying the reactions…</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Error ─────────────────────────────────────────────────────────
  if (error && verdictsList.length === 0 && !isLive) {
    return (
      <div className="screen" id="verdict-screen">
        <div className="vrd-empty">
          <div className="vrd-empty-icon">⚠️</div>
          <h1 className="screen-title">Gone</h1>
          <p className="screen-subtitle">{error}</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Main ──────────────────────────────────────────────────────────
  return (
    <div
      className="screen vrd-screen"
      id="verdict-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Multi-verdict dots */}
      {!isLive && verdictsList.length > 1 && (
        <div className="vrd-dots">
          {verdictsList.map((v, idx) => (
            <button
              key={v.id}
              className={`vrd-dot${idx === currentIndex ? " active" : ""}`}
              onClick={() => setCurrentIndex(idx)}
              aria-label={`Verdict ${idx + 1}`}
            />
          ))}
        </div>
      )}

      {/* Hero confession card */}
      <div className={`vrd-card${isLive ? " vrd-card-live" : ""}`}>
        {/* Live badge OR verdict crown */}
        {isLive ? (
          <div className="vrd-live-badge">
            <span className="vrd-live-dot" />
            <span>LIVE</span>
          </div>
        ) : dominant ? (
          <div className="vrd-crown">{dominant}</div>
        ) : null}

        {/* Confession text */}
        {activeText ? (
          <blockquote className="vrd-confession-text">"{activeText}"</blockquote>
        ) : null}

        {/* Arc timer (live only) */}
        {isLive && (
          <div className="vrd-timer-row">
            <ArcTimer progress={progress} seconds={userSeconds} isUrgent={isUrgent} />
            <div className="vrd-timer-hint">
              <span className="vrd-timer-label">reactions rolling in</span>
              <span className="vrd-timer-sub">verdict reveals at zero</span>
            </div>
          </div>
        )}

        {/* Static verdict caption */}
        {!isLive && (
          <p className="vrd-caption">{caption}</p>
        )}
      </div>

      {/* Instagram-style emoji strip */}
      <EmojiStrip reactions={activeReactions} dominant={dominant} isLive={isLive} />

      {/* Comment feed */}
      <div className="vrd-comments">
        <div className="vrd-comments-header">
          <span className="vrd-comments-label">
            {isLive ? "Live comments" : "Comments"}
          </span>
          {activeComments.length > 0 && (
            <span className="vrd-comments-count">{activeComments.length}</span>
          )}
        </div>
        <div className="vrd-comments-feed">
          {activeComments.length === 0 ? (
            <p className="vrd-no-comments">
              {isLive ? "Waiting for comments…" : "No comments were dropped"}
            </p>
          ) : (
            activeComments.map((c) => (
              <div className="vrd-comment-bubble" key={c.id}>
                <span className="vrd-comment-text">{c.text}</span>
              </div>
            ))
          )}
          <div ref={commentsEndRef} />
        </div>
      </div>

      {/* Footer hint */}
      {!isLive && (
        <p className="vrd-return-hint">Returning to compose shortly…</p>
      )}
    </div>
  );
}
