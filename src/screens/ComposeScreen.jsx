import { useState, useEffect, useRef } from "react";
import { collection, addDoc, doc, setDoc, onSnapshot } from "firebase/firestore";
import { db, serverTimestamp, auth, API_URL } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import ConnectionTest from "../components/ConnectionTest";
import useFeedback from "../hooks/useFeedback";

const MAX_CHARS = 280;
const DROP_CYCLE_SEC = 60;

export default function ComposeScreen() {
  const { user } = useAuth();
  const { setIsComposing } = useDrop();
  const { playTap, vibrate } = useFeedback();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [countdown, setCountdown] = useState(DROP_CYCLE_SEC);
  const countdownRef = useRef(null);

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
      () => {} // Ignore errors (doc may not exist yet)
    );

    return () => unsub();
  }, [user]);

  // Signal the global context whether the user is actively typing.
  // "Queued" state does NOT count — we want users to be pulled into
  // a live drop after they've submitted their confession.
  useEffect(() => {
    const composing = !queued && text.trim().length > 0;
    setIsComposing(composing);

    // Clear on unmount so navigating away doesn't leave it stuck
    return () => setIsComposing(false);
  }, [text, queued, setIsComposing]);

  const charsLeft = MAX_CHARS - text.length;
  const isEmpty = text.trim().length === 0;
  const isOverLimit = charsLeft < 0;

  async function handleSend() {
    if (isEmpty || isOverLimit || sending || !user) return;

    setSending(true);
    try {
      // Touch presence document so server immediately sees author as active
      await setDoc(doc(db, "presence", user.uid), {
        lastSeen: serverTimestamp(),
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
          communityId: user.communityId,
        }),
      });
      const result = await res.json();
      if (!res.ok) {
        throw new Error(result.error || "Submission failed");
      }

      setText("");
      setQueued(true);
      setCountdown(DROP_CYCLE_SEC);
      playTap();
      vibrate(30);
    } catch (err) {
      console.error("Failed to submit confession:", err);
      // TODO: surface error to user in a later iteration
    } finally {
      setSending(false);
    }
  }

  function handleNewConfession() {
    setQueued(false);
    setCountdown(DROP_CYCLE_SEC);
    if (countdownRef.current) clearInterval(countdownRef.current);
  }

  // ── Countdown timer when queued ────────────────────────────────────────────
  useEffect(() => {
    if (!queued) return;

    countdownRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(countdownRef.current);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
    };
  }, [queued]);

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

  // ── Queued confirmation state ──────────────────────────────────────────────
  if (queued) {
    const radius = 46;
    const circumference = 2 * Math.PI * radius;
    const progress = countdown / DROP_CYCLE_SEC;
    const strokeOffset = circumference * progress;

    return (
      <div className="screen" id="compose-screen">
        <div className="queued-container">
          <div className="countdown-ring-wrap">
            <svg className="countdown-ring" viewBox="0 0 100 100">
              <circle
                className="countdown-ring-bg"
                cx="50" cy="50" r={radius}
              />
              <circle
                className="countdown-ring-fill"
                cx="50" cy="50" r={radius}
                strokeDasharray={circumference}
                strokeDashoffset={circumference - strokeOffset}
                transform="rotate(-90 50 50)"
              />
            </svg>
            <div className="countdown-inner">
              {countdown > 0 ? (
                <>
                  <span className="countdown-number">{countdown}</span>
                  <span className="countdown-unit">sec</span>
                </>
              ) : (
                <span className="countdown-done">📡</span>
              )}
            </div>
          </div>

          <h1 className="screen-title">
            {countdown > 0 ? "Queued" : "Dropping now…"}
          </h1>
          <p className="screen-subtitle">
            {countdown > 0
              ? "Your confession is waiting for the next drop cycle."
              : "Your confession is being broadcast to the crowd!"}
          </p>

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
        Write your anonymous confession. It will only drop to users in <strong>{user?.communityId}</strong>.
      </p>

      <div className="compose-card glass-card">
        <textarea
          id="confession-input"
          className="compose-textarea"
          placeholder="I have something to confess…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={MAX_CHARS + 20} /* allow slight overshoot so counter goes red */
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
