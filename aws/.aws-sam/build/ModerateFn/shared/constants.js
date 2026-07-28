// ─── Shared Constants ────────────────────────────────────────────────────────
// Used across multiple Lambda functions. Single source of truth.
// ─────────────────────────────────────────────────────────────────────────────

// Reaction emojis — must match client-side EMOJIS array
const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

// Drop configuration
const DROP_RECIPIENT_COUNT = 100;       // Fixed blast radius
const DROP_DURATION_MS = 60_000;        // Confession is live for 60 seconds
const ACTIVE_WINDOW_MS = 2 * 60_000;   // "Active" = heartbeat within last 2 minutes
const MAX_CONFESSIONS_PER_TICK = 10;    // Process at most 10 confessions per scheduler tick

// Moderation
const FREEZE_THRESHOLD = 5;            // Freeze account after this many user reports

// Hall of Fame
const VERDICT_RETENTION_MS = 5 * 60_000; // Keep verdicts for 5 min so clients can view

module.exports = {
  EMOJIS,
  DROP_RECIPIENT_COUNT,
  DROP_DURATION_MS,
  ACTIVE_WINDOW_MS,
  MAX_CONFESSIONS_PER_TICK,
  FREEZE_THRESHOLD,
  VERDICT_RETENTION_MS,
};
