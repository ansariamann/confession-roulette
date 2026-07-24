import { useState } from "react";
import { collection, addDoc } from "firebase/firestore";
import { db, serverTimestamp } from "../firebase";
import { useAuth } from "../context/AuthProvider";
import ConnectionTest from "../components/ConnectionTest";

const MAX_CHARS = 280;

export default function ComposeScreen() {
  const { user } = useAuth();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [queued, setQueued] = useState(false);

  const charsLeft = MAX_CHARS - text.length;
  const isEmpty = text.trim().length === 0;
  const isOverLimit = charsLeft < 0;

  async function handleSend() {
    if (isEmpty || isOverLimit || sending || !user) return;

    setSending(true);
    try {
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
