// ─── Shared Drop Scheduling Logic ────────────────────────────────────────────
// Used by the moderate Lambda (immediate drop) and drop-scheduler (fallback).
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("./firebase-admin");
const {
  EMOJIS,
  DROP_RECIPIENT_COUNT,
  DROP_DURATION_MS,
  ACTIVE_WINDOW_MS,
  MAX_CONFESSIONS_PER_TICK,
} = require("./constants");
const { randomInt } = require("crypto");
const { SQSClient, SendMessageCommand } = require("@aws-sdk/client-sqs");
const { normalizeCommunityId } = require("./community");

const sqsClient = new SQSClient({ region: process.env.AWS_REGION || "us-east-1" });

function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
    const communityId = normalizeCommunityId(data.communityId);

    if (!communityMap[communityId]) {
      communityMap[communityId] = [];
    }
    communityMap[communityId].push(uid);
  });

  return communityMap;
}

function selectRecipients(activeUids, authorUid, count) {
  if (!activeUids) activeUids = [];

  const pool = activeUids.filter((uid) => uid !== authorUid);
  
  // If we are testing solo (or nobody is online), simulate a fake recipient
  // so the author can still experience the drop locally.
  if (pool.length === 0) {
    return ["fake-recipient-123"];
  }

  if (pool.length <= count) return pool;

  const shuffled = fisherYatesShuffle(pool);
  return shuffled.slice(0, count);
}

/**
 * Schedule a single passed confession as a live drop.
 * Returns { dropId, recipientCount } or null if no eligible recipients.
 */
async function scheduleConfession(confessionDoc, expiryQueueUrl, communityMap) {
  const confessionData = confessionDoc.data();
  if (confessionData.moderationStatus !== "passed") {
    return null;
  }

  const confessionId = confessionDoc.id;
  const authorUid = confessionData.authorUid;
  const targetCommunity = normalizeCommunityId(confessionData.communityId);

  const activeMap = communityMap || await getActiveUsersByCommunity();
  const activeUids = activeMap[targetCommunity] || [];
  const recipients = selectRecipients(activeUids, authorUid, DROP_RECIPIENT_COUNT);

  if (recipients.length === 0) {
    return null;
  }

  await confessionDoc.ref.update({
    moderationStatus: "scheduled",
    scheduledAt: FieldValue.serverTimestamp(),
  });

  const dropRef = await db.collection("drops").add({
    confessionId,
    authorUid,
    text: confessionData.text,
    recipientUids: recipients,
    recipientCount: recipients.length,
    status: "broadcasting",
    broadcastStartedAt: FieldValue.serverTimestamp(),
  });

  const reactionBatch = db.batch();
  for (const emoji of EMOJIS) {
    reactionBatch.set(dropRef.collection("reactions").doc(emoji), { count: 0 });
  }
  await reactionBatch.commit();

  if (expiryQueueUrl) {
    const delaySec = Math.min(900, Math.ceil(DROP_DURATION_MS / 1000) + 2);
    await sqsClient.send(new SendMessageCommand({
      QueueUrl: expiryQueueUrl,
      MessageBody: JSON.stringify({ dropId: dropRef.id, confessionId }),
      DelaySeconds: delaySec,
    }));
  }

  return { dropId: dropRef.id, recipientCount: recipients.length };
}

/**
 * Schedule a confession by ID (used right after moderation passes).
 */
async function scheduleConfessionById(confessionId, expiryQueueUrl) {
  const confessionDoc = await db.collection("pendingConfessions").doc(confessionId).get();
  if (!confessionDoc.exists) return null;

  const communityMap = await getActiveUsersByCommunity();
  const result = await scheduleConfession(confessionDoc, expiryQueueUrl, communityMap);

  if (!result) {
    console.log(`⏳ ${confessionId}: no eligible recipients — will retry on next scheduler tick`);
  } else {
    console.log(`📡 Drop ${result.dropId} → ${result.recipientCount} recipients (immediate)`);
  }

  return result;
}

/**
 * Process all passed confessions (fallback scheduler tick).
 */
async function scheduleAllPassed(expiryQueueUrl) {
  const passedSnapshot = await db
    .collection("pendingConfessions")
    .where("moderationStatus", "==", "passed")
    .limit(MAX_CONFESSIONS_PER_TICK)
    .get();

  if (passedSnapshot.empty) {
    return { scheduled: 0 };
  }

  const communityMap = await getActiveUsersByCommunity();
  const totalActive = Object.values(communityMap).reduce((acc, arr) => acc + arr.length, 0);

  if (totalActive === 0) {
    return { scheduled: 0 };
  }

  let scheduled = 0;

  for (const confessionDoc of passedSnapshot.docs) {
    const result = await scheduleConfession(confessionDoc, expiryQueueUrl, communityMap);
    if (result) {
      scheduled++;
      console.log(`📡 Drop ${result.dropId} → ${result.recipientCount} recipients`);
    } else {
      console.log(`⏳ ${confessionDoc.id}: no eligible recipients in community`);
    }
  }

  return { scheduled };
}

module.exports = {
  scheduleConfession,
  scheduleConfessionById,
  scheduleAllPassed,
};
