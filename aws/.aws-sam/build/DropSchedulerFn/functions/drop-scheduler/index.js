// ─── Drop Scheduler Lambda ───────────────────────────────────────────────────
// Trigger: Amazon EventBridge scheduled rule (rate: 1 minute)
//
// Queries passed confessions, selects random recipients, creates drop
// documents in Firestore, seeds reaction subdocs, and sends a delayed
// SQS message to trigger expiry exactly 60 seconds later.
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const {
  EMOJIS,
  DROP_RECIPIENT_COUNT,
  DROP_DURATION_MS,
  ACTIVE_WINDOW_MS,
  MAX_CONFESSIONS_PER_TICK,
} = require("../../shared/constants");
const { randomInt } = require("crypto");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });
const EXPIRY_QUEUE_URL = process.env.EXPIRY_QUEUE_URL;

/**
 * Fisher-Yates shuffle — O(n), uniform distribution.
 * Uses crypto.randomInt() for cryptographically secure randomness.
 */
function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Get all currently active user UIDs grouped by communityId.
 */
async function getActiveUsersByCommunity() {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);

  const snapshot = await db
    .collection("presence")
    .where("lastSeen", ">", cutoff)
    .get();

  const communityMap = {};
  snapshot.docs.forEach((doc) => {
    const data = doc.data();
    const uid = doc.id;
    const communityId = data.communityId || "global";

    if (!communityMap[communityId]) {
      communityMap[communityId] = [];
    }
    communityMap[communityId].push(uid);
  });

  return communityMap;
}

/**
 * Select up to `count` random recipients from the active pool.
 * Excludes the confession author.
 */
function selectRecipients(activeUids, authorUid, count) {
  if (!activeUids || activeUids.length === 0) return [];

  const pool = activeUids.filter((uid) => uid !== authorUid);
  if (pool.length === 0) return [];
  if (pool.length <= count) return pool;

  const shuffled = fisherYatesShuffle(pool);
  return shuffled.slice(0, count);
}

exports.handler = async (event) => {
  try {
    // 1. Find passed confessions that haven't been scheduled yet
    const passedSnapshot = await db
      .collection("pendingConfessions")
      .where("moderationStatus", "==", "passed")
      .limit(MAX_CONFESSIONS_PER_TICK)
      .get();

    if (passedSnapshot.empty) {
      console.log("⏳ No passed confessions — skipping drop cycle");
      return { statusCode: 200, body: "No confessions to schedule" };
    }

    // 2. Get active user pool grouped by community
    const communityMap = await getActiveUsersByCommunity();
    const totalActive = Object.values(communityMap).reduce((acc, arr) => acc + arr.length, 0);

    if (totalActive === 0) {
      console.log("⏳ No active users — skipping drop cycle");
      return { statusCode: 200, body: "No active users" };
    }

    console.log(`🎯 Drop tick: ${passedSnapshot.size} confession(s), ${totalActive} active user(s)`);

    let dropsCreated = 0;

    // 3. Create a drop for each passed confession
    for (const confessionDoc of passedSnapshot.docs) {
      // Atomically mark as scheduled to prevent concurrent ticks
      await confessionDoc.ref.update({ moderationStatus: "scheduled" });

      const confessionData = confessionDoc.data();
      const confessionId = confessionDoc.id;
      const authorUid = confessionData.authorUid;
      const targetCommunity = confessionData.communityId || "global";

      const activeUids = communityMap[targetCommunity] || [];
      const recipients = selectRecipients(activeUids, authorUid, DROP_RECIPIENT_COUNT);

      if (recipients.length === 0) {
        console.log(`⏳ ${confessionId}: no eligible recipients in '${targetCommunity}'`);
        // Revert to passed so it can be tried next tick
        await confessionDoc.ref.update({ moderationStatus: "passed" });
        continue;
      }

      // Create the drop document
      const dropRef = await db.collection("drops").add({
        confessionId,
        authorUid,
        text: confessionData.text,
        recipientUids: recipients,
        recipientCount: recipients.length,
        status: "broadcasting",
        broadcastStartedAt: FieldValue.serverTimestamp(),
      });

      // Seed reaction subdocs (one per emoji, count: 0)
      const reactionBatch = db.batch();
      for (const emoji of EMOJIS) {
        const reactionRef = dropRef.collection("reactions").doc(emoji);
        reactionBatch.set(reactionRef, { count: 0 });
      }
      await reactionBatch.commit();

      // 4. Send delayed SQS message to trigger expiry
      if (EXPIRY_QUEUE_URL) {
        const delaySec = Math.ceil(DROP_DURATION_MS / 1000);
        await sqsClient.send(new SendMessageCommand({
          QueueUrl: EXPIRY_QUEUE_URL,
          MessageBody: JSON.stringify({
            dropId: dropRef.id,
            confessionId,
          }),
          DelaySeconds: delaySec,
        }));
        console.log(`📡 Drop ${dropRef.id} → ${recipients.length} recipients, expiry in ${delaySec}s`);
      } else {
        console.warn("⚠️ EXPIRY_QUEUE_URL not set — expiry will not be scheduled");
      }

      dropsCreated++;
    }

    return {
      statusCode: 200,
      body: `Scheduled ${dropsCreated} drop(s)`,
    };
  } catch (err) {
    console.error("Drop Scheduler error:", err);
    return { statusCode: 500, body: err.message };
  }
};
