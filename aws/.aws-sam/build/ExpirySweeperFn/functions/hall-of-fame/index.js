// ─── Hall of Fame Rollup Lambda ──────────────────────────────────────────────
// Trigger: Amazon EventBridge scheduled rule (rate: 60 minutes)
//
// Sums reaction totals from expired verdicts into daily hallOfFameStats
// documents. Only aggregate counts — never any confession text or
// individual verdict data.
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const { EMOJIS, VERDICT_RETENTION_MS } = require("../../shared/constants");

/**
 * Get today's date key in YYYY-MM-DD (UTC).
 */
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

exports.handler = async (event) => {
  const today = getTodayKey();
  const retentionCutoff = new Date(Date.now() - VERDICT_RETENTION_MS);

  try {
    // Only query verdicts that are at least 5 minutes old
    const verdictsSnapshot = await db
      .collection("verdicts")
      .where("expiredAt", "<=", retentionCutoff)
      .get();

    if (verdictsSnapshot.empty) {
      console.log("🏆 No old verdicts to roll up");
      return { statusCode: 200, body: "Nothing to roll up" };
    }

    // Check existing stats for today
    const existingDoc = await db.collection("hallOfFameStats").doc(today).get();
    const existing = existingDoc.exists ? existingDoc.data() : null;

    // Sum reaction counts across all old verdicts
    const emojiTotals = {};
    let totalConfessions = 0;
    let totalReactions = 0;

    for (const emoji of EMOJIS) {
      emojiTotals[emoji] = 0;
    }

    verdictsSnapshot.forEach((doc) => {
      const data = doc.data();
      const reactions = data.reactions || {};

      totalConfessions++;
      for (const [emoji, count] of Object.entries(reactions)) {
        emojiTotals[emoji] = (emojiTotals[emoji] || 0) + (count || 0);
        totalReactions += (count || 0);
      }
    });

    // Merge with existing daily totals
    if (existing) {
      const prevTotals = existing.emojiTotals || {};
      for (const emoji of EMOJIS) {
        emojiTotals[emoji] = (emojiTotals[emoji] || 0) + (prevTotals[emoji] || 0);
      }
      totalConfessions += (existing.totalConfessions || 0);
      totalReactions += (existing.totalReactions || 0);
    }

    // Write the rollup
    await db.collection("hallOfFameStats").doc(today).set({
      date: today,
      emojiTotals,
      totalConfessions,
      totalReactions,
      lastUpdated: FieldValue.serverTimestamp(),
    });

    // Clean up consumed verdicts
    const deleteBatch = db.batch();
    verdictsSnapshot.docs.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();

    console.log(
      `🏆 Hall of Fame rollup: ${today} — ` +
      `${verdictsSnapshot.size} verdict(s) consumed, ` +
      `${totalReactions} total reactions`
    );

    return {
      statusCode: 200,
      body: `Rolled up ${verdictsSnapshot.size} verdict(s)`,
    };
  } catch (err) {
    console.error("Hall of Fame rollup error:", err);
    return { statusCode: 500, body: err.message };
  }
};
