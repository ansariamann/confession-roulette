// ─── Expiry Sweeper Lambda ───────────────────────────────────────────────────
// Trigger: SQS message from ExpiryQueue (arrives exactly 60s after drop creation)
//
// For each expired drop:
//   1. Read final reaction counts from the reactions subcollection
//   2. Write verdict doc (reaction totals only — NO confession text)
//   3. Hard-delete: reactions, voters, comments subcollections
//   4. Hard-delete: the drop document itself
//   5. Hard-delete: the original pendingConfession document
//
// This replaces the old setInterval polling sweeper with a precise,
// zero-polling serverless delay pattern.
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const { EMOJIS } = require("../../shared/constants");

/**
 * Delete all documents in a subcollection.
 * Firestore doesn't support recursive deletes from the client SDK.
 */
async function deleteSubcollection(parentRef, subcollectionName) {
  const snapshot = await parentRef.collection(subcollectionName).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

/**
 * Process a single expired drop.
 */
async function processExpiredDrop(dropId, confessionId) {
  const dropRef = db.collection("drops").doc(dropId);
  const dropDoc = await dropRef.get();

  if (!dropDoc.exists) {
    console.log(`⏭️ Drop ${dropId} already deleted — skipping`);
    return;
  }

  const dropData = dropDoc.data();

  // Use confessionId from the message, fall back to the drop doc
  const cId = confessionId || dropData.confessionId;

  try {
    // 1. Capture final reaction counts
    const reactionsSnapshot = await dropRef.collection("reactions").get();
    const reactionTotals = {};
    reactionsSnapshot.forEach((doc) => {
      reactionTotals[doc.id] = doc.data().count || 0;
    });

    // 2. Write verdict (reaction totals only — never the confession text)
    await db.collection("verdicts").doc(dropId).set({
      dropId,
      confessionId: cId,
      authorUid: dropData.authorUid || null,
      recipientUids: dropData.recipientUids || [],
      recipientCount: dropData.recipientCount || 0,
      reactions: reactionTotals,
      totalReactions: Object.values(reactionTotals).reduce((a, b) => a + b, 0),
      expiredAt: FieldValue.serverTimestamp(),
    });

    // 3. Hard-delete subcollections
    await deleteSubcollection(dropRef, "reactions");
    await deleteSubcollection(dropRef, "voters");
    await deleteSubcollection(dropRef, "comments");

    // 4. Hard-delete the drop document
    await dropRef.delete();

    // 5. Hard-delete the original pendingConfession
    if (cId) {
      await db.collection("pendingConfessions").doc(cId).delete();
    }

    console.log(
      `🗑️ Drop ${dropId} expired → verdict written, ` +
      `drop + reactions + confession ${cId} hard-deleted`
    );
  } catch (err) {
    console.error(`❌ Failed to expire drop ${dropId}:`, err.message);
    throw err; // Let SQS retry
  }
}

exports.handler = async (event) => {
  // SQS delivers one or more messages in event.Records
  const results = [];

  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body);
      const { dropId, confessionId } = message;

      if (!dropId) {
        console.warn("⚠️ SQS message missing dropId — skipping");
        continue;
      }

      await processExpiredDrop(dropId, confessionId);
      results.push({ dropId, status: "expired" });
    } catch (err) {
      console.error("Expiry Sweeper error for record:", err.message);
      // Throw so SQS retries this specific message
      throw err;
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify(results),
  };
};
