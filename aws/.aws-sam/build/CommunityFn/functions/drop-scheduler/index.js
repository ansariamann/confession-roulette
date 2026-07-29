// ─── Drop Scheduler Lambda ───────────────────────────────────────────────────
// Trigger: Amazon EventBridge scheduled rule (rate: 1 minute)
// Fallback for confessions that couldn't be dropped immediately (no recipients).
// ─────────────────────────────────────────────────────────────────────────────

const { scheduleAllPassed } = require("../../shared/schedule-drop");

const EXPIRY_QUEUE_URL = process.env.EXPIRY_QUEUE_URL;

exports.handler = async () => {
  try {
    const { scheduled } = await scheduleAllPassed(EXPIRY_QUEUE_URL);

    if (scheduled === 0) {
      return { statusCode: 200, body: "No confessions to schedule" };
    }

    return {
      statusCode: 200,
      body: `Scheduled ${scheduled} drop(s)`,
    };
  } catch (err) {
    console.error("Drop Scheduler error:", err);
    return { statusCode: 500, body: err.message };
  }
};
