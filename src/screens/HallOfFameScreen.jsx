import { useState, useEffect, useMemo } from "react";
import {
  collection,
  query,
  orderBy,
  limit,
  onSnapshot,
  where,
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

const VIBE_COLORS = {
  "😂": "#f59e0b",
  "💀": "#8b5cf6",
  "😬": "#ef4444",
  "❤️": "#ec4899",
  "😳": "#3b82f6",
};

/**
 * Auto-generate a flavor headline from the day's stats.
 */
function generateHeadline(dominant, totalConfessions, totalReactions) {
  if (!dominant) return "Waiting for the first drop…";

  const label = EMOJI_LABELS[dominant] || "Unknown";

  const intros = {
    "😂": [
      `${totalConfessions} confessions dropped. The crowd chose laughter.`,
      `A comedy kind of day. ${totalReactions} reactions can't be wrong.`,
      `The jury says: funny. ${totalConfessions} confessions judged.`,
    ],
    "💀": [
      `${totalConfessions} confessions. The crowd is unhinged today.`,
      `Absolutely feral energy. ${totalReactions} reactions and counting.`,
      `No survivors. ${totalConfessions} drops went full chaos.`,
    ],
    "😬": [
      `${totalConfessions} confessions hit different. Peak cringe achieved.`,
      `The crowd winced ${totalReactions} times today.`,
      `Uncomfortable truths only. ${totalConfessions} drops, ${totalReactions} cringes.`,
    ],
    "❤️": [
      `${totalConfessions} confessions. Today, the crowd felt something.`,
      `The feels won. ${totalReactions} reactions from the heart.`,
      `An emotional day. ${totalConfessions} drops reached the soul.`,
    ],
    "😳": [
      `${totalConfessions} confessions left the crowd shook.`,
      `Jaw-dropping energy. ${totalReactions} stunned reactions.`,
      `The crowd couldn't even. ${totalConfessions} confessions did THAT.`,
    ],
  };

  const options = intros[dominant] || [
    `${totalConfessions} confessions. Dominant vibe: ${label}.`,
  ];
  // Deterministic pick based on totalConfessions so it doesn't flicker
  return options[totalConfessions % options.length];
}

/**
 * Format a date string (YYYY-MM-DD) into a human label.
 */
function formatDate(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return "Today";

  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (dateStr === yesterday) return "Yesterday";

  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

function formatDateShort(dateStr) {
  const today = new Date().toISOString().slice(0, 10);
  if (dateStr === today) return "Today";
  const yesterday = new Date(Date.now() - 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (dateStr === yesterday) return "Yest.";
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "UTC",
  });
}

/**
 * Find the dominant emoji from emojiTotals.
 */
function getDominant(emojiTotals) {
  let dominant = null;
  let maxCount = 0;
  for (const emoji of EMOJIS) {
    const count = emojiTotals[emoji] || 0;
    if (count > maxCount) {
      maxCount = count;
      dominant = emoji;
    }
  }
  return dominant;
}

export default function HallOfFameScreen() {
  const { user } = useAuth();
  const [todayStats, setTodayStats] = useState(null);
  const [weekStats, setWeekStats] = useState([]);
  const [loading, setLoading] = useState(true);

  // ── Listen to latest day stats (real-time) ──────────────────────────────
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
          setTodayStats({ id: doc.id, ...doc.data() });
        } else {
          setTodayStats(null);
        }
        setLoading(false);
      },
      (err) => {
        console.error("Pulse fetch error:", err);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [user]);

  // ── Fetch 7-day history ─────────────────────────────────────────────────
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, "hallOfFameStats"),
      orderBy("date", "desc"),
      limit(7),
    );

    const unsub = onSnapshot(q, (snapshot) => {
      const days = [];
      snapshot.forEach((doc) => {
        days.push({ id: doc.id, ...doc.data() });
      });
      setWeekStats(days.reverse()); // oldest first
    });

    return () => unsub();
  }, [user]);

  // ── Derived ─────────────────────────────────────────────────────────────
  const emojiTotals = todayStats?.emojiTotals || {};
  const totalReactions = todayStats?.totalReactions || 0;
  const totalConfessions = todayStats?.totalConfessions || 0;
  const maxCount = Math.max(1, ...Object.values(emojiTotals));
  const dominantEmoji = getDominant(emojiTotals);
  const vibeColor = dominantEmoji
    ? VIBE_COLORS[dominantEmoji]
    : "var(--ink-soft)";

  const headline = useMemo(
    () => generateHeadline(dominantEmoji, totalConfessions, totalReactions),
    [dominantEmoji, totalConfessions, totalReactions],
  );

  // Week sparkline data
  const weekMax = useMemo(() => {
    return Math.max(1, ...weekStats.map((d) => d.totalReactions || 0));
  }, [weekStats]);

  // ── RENDER: Loading ─────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="screen" id="halloffame-screen">
        <div className="pulse-loading">
          <div className="loading-spinner" />
          <p className="screen-subtitle">Reading the pulse…</p>
        </div>
      </div>
    );
  }

  // ── RENDER: Empty state ─────────────────────────────────────────────────
  if (!todayStats) {
    return (
      <div className="screen" id="halloffame-screen">
        <div className="pulse-empty">
          <div className="pulse-empty-icon">📡</div>
          <h1 className="pulse-title">The Pulse</h1>
          <p className="pulse-subtitle">
            No signal yet. Confessions need to drop before the community's pulse
            can be read.
          </p>
        </div>
      </div>
    );
  }

  // ── RENDER: The Pulse ───────────────────────────────────────────────────
  return (
    <div className="screen" id="halloffame-screen">
      <div className="pulse-content">
        {/* Header */}
        <div className="pulse-header">
          <div className="pulse-header-top">
            <h1 className="pulse-title">The Pulse</h1>
          </div>
          <span className="pulse-date">{formatDate(todayStats.date)}</span>
        </div>

        {/* ── Hero Vibe Card ── */}
        <div className="pulse-hero" style={{ "--vibe-color": vibeColor }}>
          <div className="pulse-hero-glow" />
          <span className="pulse-hero-emoji">{dominantEmoji}</span>
          <div className="pulse-hero-info">
            <span className="pulse-hero-eyebrow">COMMUNITY VIBE</span>
            <span className="pulse-hero-label">
              {EMOJI_LABELS[dominantEmoji]}
            </span>
          </div>
        </div>

        {/* ── Headline ── */}
        <p className="pulse-headline">{headline}</p>

        {/* ── Stats Grid ── */}
        <div className="pulse-stats-grid">
          <div className="pulse-stat-card">
            <span className="pulse-stat-number">{totalConfessions}</span>
            <span className="pulse-stat-label">
              {totalConfessions === 1 ? "Drop" : "Drops"}
            </span>
          </div>
          <div className="pulse-stat-card">
            <span className="pulse-stat-number">{totalReactions}</span>
            <span className="pulse-stat-label">
              {totalReactions === 1 ? "Reaction" : "Reactions"}
            </span>
          </div>
          <div className="pulse-stat-card">
            <span className="pulse-stat-number">
              {totalConfessions > 0
                ? Math.round(totalReactions / totalConfessions)
                : 0}
            </span>
            <span className="pulse-stat-label">Avg / Drop</span>
          </div>
        </div>

        {/* ── Reaction Breakdown ── */}
        <div className="pulse-breakdown">
          <span className="pulse-section-label">Reaction Breakdown</span>
          <div className="pulse-bars">
            {EMOJIS.map((emoji) => {
              const count = emojiTotals[emoji] || 0;
              const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
              const isDominant = emoji === dominantEmoji;
              return (
                <div
                  className={`pulse-bar-row ${isDominant ? "dominant" : ""}`}
                  key={emoji}
                >
                  <span className="pulse-bar-emoji">{emoji}</span>
                  <div className="pulse-bar-track">
                    <div
                      className="pulse-bar-fill"
                      style={{
                        width: `${pct}%`,
                        background: isDominant ? vibeColor : undefined,
                      }}
                    />
                  </div>
                  <span className="pulse-bar-count">{count}</span>
                </div>
              );
            })}
          </div>
        </div>

        {/* ── 7-Day Mood Timeline ── */}
        {weekStats.length > 1 && (
          <div className="pulse-timeline">
            <span className="pulse-section-label">7-Day Mood</span>
            <div className="pulse-timeline-row">
              {weekStats.map((day) => {
                const dom = getDominant(day.emojiTotals || {});
                const height =
                  weekMax > 0
                    ? Math.max(8, ((day.totalReactions || 0) / weekMax) * 56)
                    : 8;
                const color = dom ? VIBE_COLORS[dom] : "var(--hairline-strong)";
                const isToday = day.date === todayStats.date;
                return (
                  <div
                    className={`pulse-timeline-col ${isToday ? "today" : ""}`}
                    key={day.date}
                  >
                    <span className="pulse-timeline-emoji">{dom || "·"}</span>
                    <div className="pulse-timeline-bar-wrap">
                      <div
                        className="pulse-timeline-bar"
                        style={{ height: `${height}px`, background: color }}
                      />
                    </div>
                    <span className="pulse-timeline-date">
                      {formatDateShort(day.date)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── Footer Watermark ── */}
        <div className="pulse-footer">
          <span className="pulse-watermark">THE PULSE — {todayStats.date}</span>
        </div>
      </div>
    </div>
  );
}
