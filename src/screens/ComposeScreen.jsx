import { useState, useEffect } from "react";
import { doc, setDoc, onSnapshot } from "firebase/firestore";
import { db, serverTimestamp, auth, API_URL } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import ConnectionTest from "../components/ConnectionTest";
import useFeedback from "../hooks/useFeedback";
import { useCommunityStats } from "../hooks/useCommunityStats";
import { DROP_DURATION_MS, DROP_DURATION_SEC } from "../constants";

const MAX_CHARS = 280;

function composeStorageKey(uid) {
  return `compose-state-${uid}`;
}

function loadComposeState(uid) {
  try {
    const raw = sessionStorage.getItem(composeStorageKey(uid));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveComposeState(uid, state) {
  try {
    if (state) {
      sessionStorage.setItem(composeStorageKey(uid), JSON.stringify(state));
    } else {
      sessionStorage.removeItem(composeStorageKey(uid));
    }
  } catch {}
}

export default function ComposeScreen() {
  const { user } = useAuth();
  const { setIsComposing, pendingVerdict } = useDrop();
  const { stats: communityStats } = useCommunityStats(user?.communityId);
  const { playTap, vibrate } = useFeedback();

  const savedState = user ? loadComposeState(user.uid) : null;

  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(savedState?.queued ?? false);
  const [confessionId, setConfessionId] = useState(savedState?.confessionId ?? null);
  const [dropId, setDropId] = useState(savedState?.dropId ?? null);
  const [dropStatus, setDropStatus] = useState(savedState?.dropStatus ?? "waiting");
  const [isFrozen, setIsFrozen] = useState(false);
  const [remainingSec, setRemainingSec] = useState(DROP_DURATION_SEC);
  const [scheduledAtMs, setScheduledAtMs] = useState(savedState?.scheduledAtMs ?? null);

  // Persist queued state so reload restores the waiting/live UI
  useEffect(() => {
    if (!user) return;
    if (queued && confessionId) {
      saveComposeState(user.uid, {
        queued: true,
        confessionId,
        dropId,
        dropStatus,
        scheduledAtMs,
      });
    } else {
      saveComposeState(user.uid, null);
    }
  }, [user, queued, confessionId, dropId, dropStatus, scheduledAtMs]);

  // ── Listen to user doc for frozen status ─────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const unsub = onSnapshot(
      doc(db, "users", user.uid),
      (snapshot) => {
        if (snapshot.exists()) {
          setIsFrozen(snapshot.data().isFrozen === true);
        }
      },
      () => {},
    );

    return () => unsub();
  }, [user]);

  // Signal the global context — block auto-nav while typing OR waiting for verdict
  useEffect(() => {
    const composing = queued || (!queued && text.trim().length > 0);
    setIsComposing(composing);
    return () => setIsComposing(false);
  }, [text, queued, setIsComposing]);

  // When verdict arrives, clear queued state (DropAutoNav handles navigation)
  useEffect(() => {
    if (queued && pendingVerdict) {
      setQueued(false);
      setConfessionId(null);
      setDropId(null);
      setDropStatus("waiting");
      setScheduledAtMs(null);
      setRemainingSec(DROP_DURATION_SEC);
    }
  }, [queued, pendingVerdict]);

  // Listen for confession status and server-synced scheduledAt timestamp
  useEffect(() => {
    if (!queued || !confessionId) return;

    const unsub = onSnapshot(
      doc(db, "pendingConfessions", confessionId),
      (snapshot) => {
        if (!snapshot.exists()) return;
        const data = snapshot.data();

        if (data.moderationStatus === "scheduled") {
          setDropStatus("live");
          if (data.scheduledAt?.toMillis) {
            setScheduledAtMs(data.scheduledAt.toMillis());
          }
        }
      },
      (err) => console.error("Confession status listener error:", err),
    );

    return () => unsub();
  }, [queued, confessionId]);

  // Server-synced countdown while live (uses scheduledAt from Firestore)
  useEffect(() => {
    if (!queued || dropStatus !== "live") return;

    const tick = () => {
      if (scheduledAtMs) {
        const elapsed = Date.now() - scheduledAtMs;
        const remaining = Math.max(0, DROP_DURATION_MS - elapsed);
        setRemainingSec(Math.ceil(remaining / 1000));
        if (remaining <= 0) {
          setDropStatus("tallying");
        }
      } else {
        // Fallback before scheduledAt arrives from server
        setRemainingSec((prev) => {
          const next = Math.max(0, prev - 1);
          if (next <= 0) setDropStatus("tallying");
          return next;
        });
      }
    };

    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [queued, dropStatus, scheduledAtMs]);

  const charsLeft = MAX_CHARS - text.length;
  const isEmpty = text.trim().length === 0;
  const isOverLimit = charsLeft < 0;

  async function handleSend() {
    if (isEmpty || isOverLimit || sending || !user) return;

    setSending(true);
    try {
      await setDoc(doc(db, "presence", user.uid), {
        lastSeen: serverTimestamp(),
        communityId: user.communityId,
      });

      const token = await auth.currentUser.getIdToken();
      const res = await fetch(`${API_URL}/confess`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          text: text.trim(),
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Submission failed");
      }

      setText("");
      setQueued(true);
      setConfessionId(result.confessionId || null);
      setDropId(result.dropId || null);
      setRemainingSec(DROP_DURATION_SEC);
      setDropStatus(result.status === "live" ? "live" : "waiting");
      playTap();
      vibrate(30);
    } catch (err) {
      console.error("Failed to submit confession:", err);
    } finally {
      setSending(false);
    }
  }

  function handleNewConfession() {
    setQueued(false);
    setConfessionId(null);
    setDropId(null);
    setDropStatus("waiting");
    setScheduledAtMs(null);
    setRemainingSec(DROP_DURATION_SEC);
  }

  // ── Frozen account state ─────────────────────────────────────────────────
  if (isFrozen) {
    return (
      <div className="screen" id="compose-screen">
        <div className="frozen-container">
          <h1 className="screen-title">Account Under Review</h1>
          <p className="screen-subtitle">
            Your account has been temporarily frozen due to multiple reports
            from other users. You cannot submit new confessions while your
            account is under review.
          </p>
          <p className="frozen-hint">
            If you believe this is an error, please wait for a moderator
            to review your account.
          </p>
        </div>
      </div>
    );
  }

  // ── Queued / live / tallying state ───────────────────────────────────────
  if (queued) {
    const statusTitle = {
      waiting: "Finding audience…",
      live: "You're LIVE!",
      tallying: "Tallying reactions…",
    }[dropStatus];

    const statusSubtitle = {
      waiting: "Looking for active users in your community to receive your confession.",
      live: "Your confession is being broadcast right now. Reactions are rolling in!",
      tallying: "The drop just ended — your verdict is on its way.",
    }[dropStatus];

    return (
      <div className="screen" id="compose-screen">
        <div className="queued-container">
          <div className="countdown-ring-wrap">
            <div className={`live-pulse ${dropStatus === "live" ? "active" : ""}`} style={{ fontSize: "3rem" }}>
              {dropStatus === "live" ? "🔴" : dropStatus === "tallying" ? "⚖️" : "📡"}
            </div>
          </div>

          <h1 className="screen-title">{statusTitle}</h1>
          <p className="screen-subtitle">{statusSubtitle}</p>

          {dropStatus === "live" && (
            <p className="screen-subtitle" style={{ opacity: 0.7 }}>
              {remainingSec}s remaining
            </p>
          )}

          <button
            className="compose-btn secondary"
            onClick={handleNewConfession}
            id="new-confession-btn"
          >
            Write Another
          </button>
        </div>

        <ConnectionTest />
      </div>
    );
  }

  // ── Compose state ──────────────────────────────────────────────────────────
  return (
    <div className="screen" id="compose-screen">
      <div className="screen-icon">✍️</div>
      <h1 className="screen-title">Compose</h1>
      <p className="screen-subtitle">
        Write your anonymous confession. It drops only to users in{" "}
        <strong>{user?.communityId}</strong>
        {communityStats && (
          <>
            {" "}({communityStats.activeCount} online · {communityStats.memberCount} total members)
          </>
        )}
        .
      </p>

      <div className="compose-card glass-card">
        <textarea
          id="confession-input"
          className="compose-textarea"
          placeholder="I have something to confess…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_CHARS + 20}
          rows={5}
          disabled={sending}
        />

        <div className="compose-footer">
          <span
            className={`char-counter ${
              charsLeft <= 20
                ? charsLeft <= 0
                  ? "over"
                  : "warn"
                : ""
            }`}
          >
            {charsLeft}
          </span>

          <button
            id="send-confession-btn"
            className="compose-btn primary"
            onClick={handleSend}
            disabled={isEmpty || isOverLimit || sending}
          >
            {sending ? (
              <span className="btn-spinner" />
            ) : (
              "Drop It 🎤"
            )}
          </button>
        </div>
      </div>

      {user && (
        <div className="uid-tag">uid: {user.uid.slice(0, 12)}…</div>
      )}

      <ConnectionTest />
    </div>
  );
}
