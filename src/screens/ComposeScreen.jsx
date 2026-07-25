import { useState, useEffect } from "react";
import { collection, addDoc, doc, setDoc, onSnapshot } from "firebase/firestore";
import { db, serverTimestamp } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import { useDrop } from "../context/DropContext";
import ConnectionTest from "../components/ConnectionTest";

const MAX_CHARS = 280;

export default function ComposeScreen() {
  const { user } = useAuth();
  const { setIsComposing } = useDrop();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);

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

      await addDoc(collection(db, "pendingConfessions"), {
        text: text.trim(),
        submittedAt: serverTimestamp(),
        authorUid: user.uid,
        moderationStatus: "pending",
      });

      setText("");
      setQueued(true);
    } catch (err) {
      console.error("Failed to submit confession:", err);
      // TODO: surface error to user in a later iteration
    } finally {
      setSending(false);
    }
  }

  function handleNewConfession() {
    setQueued(false);
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

  // ── Queued confirmation state ──────────────────────────────────────────────
  if (queued) {
    return (
      <div className="screen" id="compose-screen">
        <div className="queued-container">
          <div className="queued-icon">📨</div>
          <h1 className="screen-title">Queued</h1>
          <p className="screen-subtitle">
            Your confession is queued for the next drop. Sit tight — the crowd
            will see it within 60 seconds.
          </p>

          <div className="queued-pulse-ring" />

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
        Write your anonymous confession. No one will ever know it was you.
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
