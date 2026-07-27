import { useState, useEffect } from "react";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
} from "firebase/firestore";
import { db } from "../firebase";
import { useAuth } from "../context/AuthProvider";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

const EMOJI_LABELS = {
  "😂": "Comedy Gold",
  "💀": "Unhinged",
  "😬": "Cringe",
  "❤️": "In The Feels",
  "😳": "Shook",
};

/**
 * Format a date string (YYYY-MM-DD) into a human label.
 */
function formatDate(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return "Today";

  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  if (dateStr === yesterday) return "Yesterday";

  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export default function HallOfFameScreen() {
  const { user } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showSettings, setShowSettings] = useState(false);

  // ── Settings (persisted to localStorage) ──────────────────────────────────
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("verdict-settings");
      return saved
        ? JSON.parse(saved)
        : { soundEffects: true, vibration: true, autoScrollComments: true };
    } catch {
      return { soundEffects: true, vibration: true, autoScrollComments: true };
    }
  });

  function toggleSetting(key) {
    setSettings((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      localStorage.setItem("verdict-settings", JSON.stringify(updated));
      return updated;
    });
  }

  // ── Listen to the most recent hallOfFameStats doc ──────────────────────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "hallOfFameStats"),
      orderBy("date", "desc"),
      limit(1),
    );

    const unsub = onSnapshot(
      q,
      (snapshot) => {
        if (!snapshot.empty) {
          const doc = snapshot.docs[0];
          setStats({ id: doc.id, ...doc.data() });
        } else {
          setStats(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("Hall of Fame fetch error:", err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [user]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const emojiTotals = stats?.emojiTotals || {};
  const totalReactions = stats?.totalReactions || 0;
  const totalConfessions = stats?.totalConfessions || 0;
  const maxCount = Math.max(1, ...Object.values(emojiTotals));

  // Find the dominant emoji of the day
  let dominantEmoji = null;
  let dominantCount = 0;
  for (const emoji of EMOJIS) {
    const count = emojiTotals[emoji] || 0;
    if (count > dominantCount) {
      dominantCount = count;
      dominantEmoji = emoji;
    }
  }

  // ── Settings panel render helper ───────────────────────────────────────────
  const settingsPanel = showSettings ? (
    <div className="settings-panel glass-card">
      {[
        { key: "soundEffects", label: "Sound Effects", desc: "Tap and reaction audio feedback" },
        { key: "vibration", label: "Vibration", desc: "Haptic feedback on reactions" },
        { key: "autoScrollComments", label: "Auto-Scroll Comments", desc: "Scroll to latest comment automatically" },
      ].map(({ key, label, desc }) => (
        <div className="setting-row" key={key}>
          <div className="setting-info">
            <span className="setting-label">{label}</span>
            <span className="setting-desc">{desc}</span>
          </div>
          <button
            className={`setting-switch ${settings[key] ? "on" : "off"}`}
            onClick={() => toggleSetting(key)}
            aria-label={`Toggle ${label}`}
            id={`setting-${key}`}
          >
            <span className="switch-knob" />
          </button>
        </div>
      ))}
    </div>
  ) : null;

  // ── RENDER: Loading ────────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="screen" id="halloffame-screen">
        <div className="hof-loading">
          <div className="loading-spinner" />
          <p className="screen-subtitle">Loading the archives…</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Empty state ────────────────────────────────────────────────────
  if (!stats) {
    return (
      <div className="screen" id="halloffame-screen">
        <div className="hof-empty">
          <div className="hof-header-row">
            <h1 className="screen-title">Hall of Fame</h1>
            <button
              className="settings-icon-btn"
              onClick={() => setShowSettings(!showSettings)}
              aria-label="Settings"
              id="settings-icon-toggle"
            >
              <span className="settings-icon">⚙</span>
            </button>
          </div>
          {settingsPanel}
          <p className="screen-subtitle" style={{ marginTop: showSettings ? 16 : 0 }}>
            No stats recorded yet. Confessions need to drop before the
            crowd's verdict can be tallied.
          </p>
        </div>
      </div>
    );
  }

  // ── RENDER: Stats display ──────────────────────────────────────────────────
  return (
    <div className="screen" id="halloffame-screen">
      <div className="hof-content">
        {/* Date label */}
        <span className="eyebrow">{formatDate(stats.date)}</span>

        <div className="hof-header-row">
          <h1 className="screen-title">Hall of Fame</h1>
          <button
            className="settings-icon-btn"
            onClick={() => setShowSettings(!showSettings)}
            aria-label="Settings"
            id="settings-icon-toggle"
          >
            <span className="settings-icon">⚙</span>
          </button>
        </div>
        {settingsPanel}

        {/* Hero stat — dominant vibe of the day */}
        {dominantEmoji && (
          <div className="hof-hero">
            <span className="hof-hero-emoji">{dominantEmoji}</span>
            <div className="hof-hero-text">
              <span className="hof-hero-label">Dominant Vibe</span>
              <span className="hof-hero-name">
                {EMOJI_LABELS[dominantEmoji]}
              </span>
            </div>
          </div>
        )}

        {/* Aggregate numbers */}
        <div className="hof-stats-row">
          <div className="hof-stat">
            <span className="hof-stat-number">{totalConfessions}</span>
            <span className="hof-stat-label">
              {totalConfessions === 1 ? "Confession" : "Confessions"}
            </span>
          </div>
          <div className="hof-stat-divider" />
          <div className="hof-stat">
            <span className="hof-stat-number">{totalReactions}</span>
            <span className="hof-stat-label">
              {totalReactions === 1 ? "Reaction" : "Reactions"}
            </span>
          </div>
        </div>

        {/* Emoji breakdown chart */}
        <div className="hof-chart">
          <span className="eyebrow">Reaction Breakdown</span>
          <div className="hof-bars">
            {EMOJIS.map((emoji) => {
              const count = emojiTotals[emoji] || 0;
              const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
              const isDominant = emoji === dominantEmoji;
              return (
                <div
                  className={`hof-bar-row ${isDominant ? "hof-bar-dominant" : ""}`}
                  key={emoji}
                >
                  <span className="hof-bar-emoji">{emoji}</span>
                  <span className="hof-bar-label">
                    {EMOJI_LABELS[emoji]}
                  </span>
                  <div className="hof-bar-track">
                    <div
                      className="hof-bar-fill"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="hof-bar-count">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Screenshot-friendly footer */}
        <div className="hof-footer">
          <span className="hof-watermark">VERDICT — {stats.date}</span>
        </div>
      </div>
    </div>
  );
}
