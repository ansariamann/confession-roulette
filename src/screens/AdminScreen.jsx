import { useState, useEffect } from "react";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  doc,
  getDoc,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";

export default function AdminScreen() {
  const { user } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [logs, setLogs] = useState([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [error, setError] = useState(null);

  // ── Check Admin Status ───────────────────────────────────────────────────
  useEffect(() => {
    if (!user) {
      setIsAdmin(false);
      setCheckingAdmin(false);
      return;
    }

    async function checkAdminStatus() {
      try {
        const userDocRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userDocRef);
        if (userSnap.exists() && userSnap.data()?.isAdmin === true) {
          setIsAdmin(true);
        } else {
          setIsAdmin(false);
        }
      } catch (err) {
        console.error("Failed to check admin status:", err);
        setIsAdmin(false);
      } finally {
        setCheckingAdmin(false);
      }
    }

    checkAdminStatus();
  }, [user]);

  // ── Fetch Moderation Logs (if Admin) ──────────────────────────────────────
  useEffect(() => {
    if (!isAdmin) return;

    setLoadingLogs(true);
    const q = query(
      collection(db, "moderationLog"),
      orderBy("timestamp", "desc"),
      limit(50)
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        const fetchedLogs = snapshot.docs.map((d) => ({
          id: d.id,
          ...d.data(),
        }));
        setLogs(fetchedLogs);
        setLoadingLogs(false);
      },
      (err) => {
        console.error("Error loading moderation logs:", err);
        setError("Failed to load moderation logs (permission denied or network issue).");
        setLoadingLogs(false);
      }
    );

    return () => unsub();
  }, [isAdmin]);

  if (checkingAdmin) {
    return (
      <div className="screen" id="admin-screen">
        <div className="loading-spinner" />
        <span className="loading-text">Verifying Admin Access…</span>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div className="screen" id="admin-screen">
        <div className="admin-access-denied">
          <span className="eyebrow">RESTRICTED AREA</span>
          <h1 className="screen-title">Access Denied</h1>
          <p className="screen-subtitle">
            Your account ({user?.uid?.slice(0, 8)}…) does not have administrator privileges.
          </p>
          <div className="admin-notice-card glass-card">
            <p>
              To grant admin access for testing, set <code>isAdmin: true</code> on the document{" "}
              <code>users/{user?.uid}</code> in Firestore console or via Admin SDK.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="screen" id="admin-screen">
      <span className="eyebrow">ADMINISTRATOR AUDIT LOG</span>
      <h1 className="screen-title">Moderation Queue</h1>
      <p className="screen-subtitle">
        Reviewing automated rejections and user-reported confessions.
      </p>

      {error && <div className="admin-error">{error}</div>}

      {loadingLogs ? (
        <div className="loading-spinner" />
      ) : logs.length === 0 ? (
        <div className="admin-empty glass-card">
          <p>No moderation log entries recorded yet.</p>
        </div>
      ) : (
        <div className="admin-log-list">
          {logs.map((log) => (
            <div key={log.id} className="admin-log-card glass-card">
              <div className="log-header">
                <span className={`log-badge priority-${(log.priority || "NORMAL").toLowerCase()}`}>
                  {log.priority || "NORMAL"}
                </span>
                <span className="log-reason">{log.reason}</span>
                <span className="log-time">
                  {log.timestamp?.toDate
                    ? log.timestamp.toDate().toLocaleTimeString()
                    : "just now"}
                </span>
              </div>
              <div className="log-preview">
                <span className="log-preview-label">Preview:</span> "{log.textPreview || "[truncated]"}"
              </div>
              <div className="log-details">
                <span className="log-hash">Hash: {log.textHash?.slice(0, 16)}…</span>
                {log.reporterUid && (
                  <span className="log-reporter">Reporter: {log.reporterUid.slice(0, 8)}…</span>
                )}
                {log.description && (
                  <span className="log-desc">{log.description}</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
