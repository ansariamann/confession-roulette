import { useState, useEffect, useRef, useCallback } from "react";
import {
  collection,
  addDoc,
  onSnapshot,
  doc,
  getDoc,
  serverTimestamp,
  query,
  orderBy,
} from "firebase/firestore";
import { db, auth, API_URL } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import useFeedback from "../hooks/useFeedback";
import { REACTION_WINDOW_MS } from "../constants";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
const USER_VIEW_DURATION_MS = REACTION_WINDOW_MS;
const COUNTDOWN_TICK_MS = 500;
const MAX_COMMENT_LENGTH = 80;
const EXPIRED_DROPS_KEY = "expired-drop-ids";

function loadExpiredMap() {
  try {
    const raw = sessionStorage.getItem(EXPIRED_DROPS_KEY);
    if (!raw) return {};
    return Object.fromEntries(JSON.parse(raw).map((id) => [id, true]));
  } catch { return {}; }
}

function saveExpiredMap(map) {
  try {
    sessionStorage.setItem(EXPIRED_DROPS_KEY, JSON.stringify(Object.keys(map).filter((id) => map[id])));
  } catch {}
}

function remainingMsForDrop(drop) {
  if (!drop?.broadcastStartedAt) return USER_VIEW_DURATION_MS;
  return Math.max(0, USER_VIEW_DURATION_MS - (Date.now() - drop.broadcastStartedAt));
}

// Thin arc timer for the LiveDrop header
function ArcTimerSmall({ progress, seconds, isUrgent }) {
  const r = 18;
  const circ = 2 * Math.PI * r;
  const dash = circ * (1 - progress);
  return (
    <div className="arc-sm-wrap">
      <svg className="arc-sm-svg" viewBox="0 0 40 40">
        <circle className="arc-bg" cx="20" cy="20" r={r} />
        <circle
          className={`arc-fill${isUrgent ? " arc-fill-urgent" : ""}`}
          cx="20" cy="20" r={r}
          strokeDasharray={circ}
          strokeDashoffset={dash}
        />
      </svg>
      <span className={`arc-sm-seconds${isUrgent ? " urgent" : ""}`}>{seconds}</span>
    </div>
  );
}

export default function LiveDropScreen() {
  const { user } = useAuth();
  const { activeDrops, markDropSeen } = useDrop();
  const { playReaction, playDrop, vibrate } = useFeedback();

  const [expiredMap, setExpiredMap] = useState(loadExpiredMap);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [userRemainingMs, setUserRemainingMs] = useState(USER_VIEW_DURATION_MS);
  const [reactionsMap, setReactionsMap] = useState({});
  const [votedMap, setVotedMap] = useState({});
  const [reportedMap, setReportedMap] = useState({});

  const touchStartXRef = useRef(null);
  const countdownRef = useRef(null);

  // Emoji burst particles
  const [bursts, setBursts] = useState([]);
  const burstIdRef = useRef(0);

  // Rising remote emoji
  const [risers, setRisers] = useState([]);
  const riserIdRef = useRef(0);
  const prevReactionsRef = useRef({});

  const [settings] = useState(() => {
    try {
      const saved = localStorage.getItem("verdict-settings");
      return saved ? JSON.parse(saved) : { soundEffects: true, vibration: true, autoScrollComments: true };
    } catch { return { soundEffects: true, vibration: true, autoScrollComments: true }; }
  });

  const [commentsMap, setCommentsMap] = useState({});
  const [commentedMap, setCommentedMap] = useState({});
  const [commentText, setCommentText] = useState("");
  const commentsEndRef = useRef(null);

  // Mark already-expired drops on load
  useEffect(() => {
    if (activeDrops.length === 0) return;
    const updates = {};
    for (const drop of activeDrops) {
      if (!expiredMap[drop.id] && remainingMsForDrop(drop) <= 0) updates[drop.id] = true;
    }
    if (Object.keys(updates).length > 0) {
      setExpiredMap((prev) => { const next = { ...prev, ...updates }; saveExpiredMap(next); return next; });
    }
  }, [activeDrops]);

  const visibleDrops = activeDrops.filter((d) => !expiredMap[d.id]);

  useEffect(() => {
    if (currentIndex >= visibleDrops.length && visibleDrops.length > 0) setCurrentIndex(visibleDrops.length - 1);
  }, [visibleDrops.length, currentIndex]);

  const currentDrop = visibleDrops[currentIndex] || null;

  useEffect(() => { if (currentDrop) markDropSeen(currentDrop.id); }, [currentDrop, markDropSeen]);

  // Countdown
  useEffect(() => {
    if (!currentDrop) return;
    const tick = () => {
      const remaining = remainingMsForDrop(currentDrop);
      setUserRemainingMs(remaining);
      if (remaining <= 0) {
        setExpiredMap((prev) => { const next = { ...prev, [currentDrop.id]: true }; saveExpiredMap(next); return next; });
      }
    };
    setUserRemainingMs(remainingMsForDrop(currentDrop));
    tick();
    countdownRef.current = setInterval(tick, COUNTDOWN_TICK_MS);
    return () => { if (countdownRef.current) clearInterval(countdownRef.current); };
  }, [currentDrop]);

  // Poll reactions
  useEffect(() => {
    if (!currentDrop) return;
    const poll = async () => {
      try {
        const res = await fetch(`/api/react?dropId=${currentDrop.id}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = await res.json();
        const counts = {};
        for (const [k, v] of Object.entries(data.reactions || {})) counts[k] = parseInt(v, 10);

        // Fire rising emoji for remote reactions
        const prev = prevReactionsRef.current[currentDrop.id] || {};
        for (const emoji of EMOJIS) {
          const diff = (counts[emoji] || 0) - (prev[emoji] || 0);
          if (diff > 0) {
            const newRisers = Array.from({ length: Math.min(diff, 3) }, () => {
              riserIdRef.current += 1;
              return { key: riserIdRef.current, emoji, x: 10 + Math.random() * 80, delay: Math.random() * 200, scale: 0.6 + Math.random() * 0.6 };
            });
            setRisers((r) => [...r, ...newRisers]);
            setTimeout(() => { const keys = new Set(newRisers.map((r) => r.key)); setRisers((r) => r.filter((ri) => !keys.has(ri.key))); }, 2000);
          }
        }
        prevReactionsRef.current[currentDrop.id] = counts;
        setReactionsMap((prev) => ({ ...prev, [currentDrop.id]: counts }));
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 800);
    return () => clearInterval(interval);
  }, [currentDrop]);

  // Check voted status
  useEffect(() => {
    if (!currentDrop || !user || votedMap[currentDrop.id]) return;
    const dropId = currentDrop.id;
    getDoc(doc(db, "drops", dropId, "voters", user.uid))
      .then((snap) => { if (snap.exists()) setVotedMap((prev) => ({ ...prev, [dropId]: true })); })
      .catch(() => {});
  }, [currentDrop, user]);

  // Load comments
  useEffect(() => {
    if (!currentDrop) return;
    const dropId = currentDrop.id;
    const unsub = onSnapshot(
      query(collection(db, "drops", dropId, "comments"), orderBy("createdAt", "asc")),
      (snapshot) => setCommentsMap((prev) => ({ ...prev, [dropId]: snapshot.docs.map((d) => ({ id: d.id, ...d.data() })) }))
    );
    return () => unsub();
  }, [currentDrop]);

  // Auto-scroll comments
  useEffect(() => {
    if (settings.autoScrollComments && commentsEndRef.current) {
      commentsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [commentsMap, settings.autoScrollComments]);

  const isVoted = currentDrop ? !!votedMap[currentDrop.id] : false;
  const canVote = currentDrop && !isVoted && userRemainingMs > 0;

  const handleReaction = useCallback(async (emoji) => {
    if (!currentDrop || !canVote || !user) return;
    const dropId = currentDrop.id;
    setVotedMap((prev) => ({ ...prev, [dropId]: true }));
    setReactionsMap((prev) => {
      const cur = prev[dropId] || {};
      return { ...prev, [dropId]: { ...cur, [emoji]: (cur[emoji] || 0) + 1 } };
    });
    playReaction();
    vibrate(40);

    // Burst particles
    const seeds = Array.from({ length: 7 }, () => {
      burstIdRef.current += 1;
      return { key: burstIdRef.current, emoji, x: (Math.random() - 0.5) * 140, delay: Math.random() * 180, scale: 0.7 + Math.random() * 0.8 };
    });
    setBursts((prev) => [...prev, ...seeds]);
    setTimeout(() => { const keys = new Set(seeds.map((s) => s.key)); setBursts((prev) => prev.filter((b) => !keys.has(b.key))); }, 1400);

    try {
      const res = await fetch("/api/react", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dropId, emoji, uid: user.uid }),
      });
      if (!res.ok) throw new Error("Reaction failed");
    } catch {
      setVotedMap((prev) => ({ ...prev, [dropId]: false }));
      setReactionsMap((prev) => {
        const cur = prev[dropId] || {};
        return { ...prev, [dropId]: { ...cur, [emoji]: Math.max(0, (cur[emoji] || 0) - 1) } };
      });
    }
  }, [currentDrop, canVote, user]);

  const isReported = currentDrop ? !!reportedMap[currentDrop.id] : false;

  const handleReport = useCallback(async () => {
    if (!currentDrop || !user || isReported) return;
    const dropId = currentDrop.id;
    setReportedMap((prev) => ({ ...prev, [dropId]: true }));
    try {
      const token = await auth.currentUser.getIdToken();
      const res = await fetch(`${API_URL}/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ dropId }),
      });
      if (!res.ok) throw new Error("Failed to report");
    } catch {
      setReportedMap((prev) => ({ ...prev, [dropId]: false }));
    }
  }, [currentDrop, user, isReported]);

  const handleCommentSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!currentDrop || !user || !commentText.trim()) return;
    const dropId = currentDrop.id;
    if (commentedMap[dropId]) return;
    const trimmed = commentText.trim().slice(0, MAX_COMMENT_LENGTH);
    setCommentedMap((prev) => ({ ...prev, [dropId]: true }));
    setCommentText("");
    try {
      await addDoc(collection(db, "drops", dropId, "comments"), { text: trimmed, createdAt: serverTimestamp() });
    } catch {
      setCommentedMap((prev) => ({ ...prev, [dropId]: false }));
    }
  }, [currentDrop, user, commentText, commentedMap]);

  const handlePrev = useCallback(() => { if (currentIndex > 0) setCurrentIndex((i) => i - 1); }, [currentIndex]);
  const handleNext = useCallback(() => { if (currentIndex < visibleDrops.length - 1) setCurrentIndex((i) => i + 1); }, [currentIndex, visibleDrops.length]);

  function handleTouchStart(e) { touchStartXRef.current = e.touches[0].clientX; }
  function handleTouchEnd(e) {
    if (touchStartXRef.current === null) return;
    const diffX = touchStartXRef.current - e.changedTouches[0].clientX;
    touchStartXRef.current = null;
    if (diffX > 40) handleNext();
    else if (diffX < -40) handlePrev();
  }

  const userSeconds = Math.max(0, Math.ceil(userRemainingMs / 1000));
  const progress = Math.max(0, Math.min(1, userRemainingMs / USER_VIEW_DURATION_MS));
  const isUrgent = userSeconds <= 5;
  const currentReactions = currentDrop ? reactionsMap[currentDrop.id] || {} : {};
  const totalVotes = Object.values(currentReactions).reduce((a, b) => a + b, 0);
  const topEmoji = EMOJIS.reduce((best, e) => (currentReactions[e] || 0) > (currentReactions[best] || 0) ? e : best, EMOJIS[0]);

  // ── RENDER: Waiting ────────────────────────────────────────────────────────
  if (!currentDrop || visibleDrops.length === 0) {
    return (
      <div className="screen" id="livedrop-screen">
        <div className="ld-waiting">
          <div className="ld-waiting-orbit">
            <div className="ld-orbit-ring ld-orbit-1" />
            <div className="ld-orbit-ring ld-orbit-2" />
            <div className="ld-orbit-ring ld-orbit-3" />
            <span className="ld-orbit-dot">📡</span>
          </div>
          <h1 className="screen-title">Listening…</h1>
          <p className="screen-subtitle">
            Waiting for the next confession drop. You'll be pulled in automatically — no need to stay here.
          </p>
        </div>
      </div>
    );
  }

  const comments = currentDrop ? commentsMap[currentDrop.id] || [] : [];
  const hasCommented = currentDrop ? !!commentedMap[currentDrop.id] : false;

  // ── RENDER: Live ───────────────────────────────────────────────────────────
  return (
    <div
      className="screen live-stage"
      id="livedrop-screen"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* Story-style segment bars */}
      <div className="story-bars">
        {visibleDrops.map((d, idx) => (
          <button key={d.id} className="story-bar" onClick={() => setCurrentIndex(idx)} aria-label={`Confession ${idx + 1}`}>
            <span className="story-bar-fill" style={{
              width: idx < currentIndex ? "100%" : idx === currentIndex ? `${(1 - progress) * 100}%` : "0%",
            }} />
          </button>
        ))}
      </div>

      {/* Top meta row */}
      <div className="live-meta">
        <span className="live-meta-left">
          <span className="live-pulse" />
          Anonymous · {currentIndex + 1}/{visibleDrops.length}
        </span>
        <ArcTimerSmall progress={progress} seconds={userSeconds} isUrgent={isUrgent} />
      </div>

      {/* Dark confession card */}
      <div className="confession-stage swipeable-card" key={currentDrop.id}>
        <span className="stage-quote" aria-hidden="true">"</span>
        <p className="stage-text">{currentDrop.text}</p>
        <div className="stage-foot">
          <button
            className={`report-btn${isReported ? " reported" : ""}`}
            onClick={handleReport}
            disabled={isReported}
            id="report-btn"
          >
            {isReported ? "Reported" : "Report"}
          </button>
        </div>

        {/* Burst particles */}
        <div className="burst-layer" aria-hidden="true">
          {bursts.map((b) => (
            <span key={b.key} className="burst-emoji" style={{ "--bx": `${b.x}px`, animationDelay: `${b.delay}ms`, fontSize: `${22 * b.scale}px` }}>
              {b.emoji}
            </span>
          ))}
        </div>
      </div>

      {/* Rising remote emoji */}
      <div className="rise-layer" aria-hidden="true">
        {risers.map((r) => (
          <span key={r.key} className="rise-emoji" style={{ left: `${r.x}%`, animationDelay: `${r.delay}ms`, fontSize: `${20 * r.scale}px` }}>
            {r.emoji}
          </span>
        ))}
      </div>

      {/* Instagram-style emoji pill strip (replaces slidebars) */}
      <div className="emoji-strip ld-emoji-strip">
        {EMOJIS.map((emoji) => {
          const count = currentReactions[emoji] || 0;
          const isTop = emoji === topEmoji && totalVotes > 0;
          return (
            <button
              key={emoji}
              className={`emoji-pill emoji-pill-btn${!canVote ? " disabled" : ""}${isTop && isVoted ? " emoji-pill-dom" : ""}`}
              onClick={() => handleReaction(emoji)}
              disabled={!canVote}
              id={`reaction-${emoji}`}
              aria-label={`React with ${emoji}`}
            >
              <span className="emoji-pill-icon">{emoji}</span>
              <span className="emoji-pill-count">{count || ""}</span>
            </button>
          );
        })}
      </div>

      {/* Comment feed */}
      <div className="ld-comment-section">
        {comments.length > 0 && (
          <div className="ld-comment-stream">
            {comments.map((c) => (
              <div className="ld-comment-bubble" key={c.id}>
                <span className="ld-comment-text">{c.text}</span>
              </div>
            ))}
            <div ref={commentsEndRef} />
          </div>
        )}
        <form className="ld-comment-bar" onSubmit={handleCommentSubmit}>
          <input
            type="text"
            className="ld-comment-input"
            placeholder={hasCommented ? "Comment sent ✓" : "Drop a comment…"}
            value={commentText}
            onChange={(e) => setCommentText(e.target.value)}
            maxLength={MAX_COMMENT_LENGTH}
            disabled={hasCommented || userRemainingMs <= 0}
            id="comment-input"
          />
          <button
            type="submit"
            className="ld-comment-send"
            disabled={hasCommented || !commentText.trim() || userRemainingMs <= 0}
            id="comment-send-btn"
          >
            ↑
          </button>
        </form>
      </div>
    </div>
  );
}
