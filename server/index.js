// ─── Verdict — Self-Hosted Moderation Server ────────────────────────────────
// Watches Firestore for new pendingConfessions, runs PII regex + AWS Comprehend
// toxicity detection, and updates moderationStatus to "passed" or "rejected".
// Rejections are logged to moderationLog with hashed/truncated text.
//
// Usage:
//   1. Place your Firebase service account key at server/serviceAccountKey.json
//   2. Copy .env.example to .env and fill in your AWS credentials
//   3. npm start
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { createHash, randomInt } = require("crypto");
const path = require("path");

// AWS Comprehend
const {
  ComprehendClient,
  DetectToxicContentCommand,
} = require("@aws-sdk/client-comprehend");

// HTTP and Socket.IO
const http = require("http");
const { Server } = require("socket.io");

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

try {
  const serviceAccount = require(serviceAccountPath);
  initializeApp({ credential: cert(serviceAccount) });
  console.log("✅ Firebase Admin initialized");
} catch (err) {
  console.error(
    "❌ Failed to initialize Firebase Admin.\n" +
      "   Make sure serviceAccountKey.json exists in the server/ directory.\n" +
      "   Download it from: Firebase Console → Project Settings → Service accounts → Generate new private key\n",
    err.message,
  );
  process.exit(1);
}

const db = getFirestore();

// ─── AWS Comprehend Init ─────────────────────────────────────────────────────
const comprehendClient = new ComprehendClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials:
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
      ? {
          accessKeyId: process.env.AWS_ACCESS_KEY_ID,
          secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        }
      : undefined,
});

// ─── Moderation Thresholds ───────────────────────────────────────────────────
// Conservative by default — over-reject is the acceptable failure mode.
// These can be loosened later based on false-positive data.
const THRESHOLDS = {
  HATE_SPEECH: 0.5,
  HARASSMENT_OR_ABUSE: 0.5,
  SEXUAL: 0.5, // HIGH priority — covers CSAM direction
  VIOLENCE_OR_THREAT: 0.5, // CRITICAL priority — covers self-harm, threats
  GRAPHIC: 0.5,
  INSULT: 0.7,
  PROFANITY: 0.7,
};

// Overall toxicity threshold
const OVERALL_TOXICITY_THRESHOLD = 0.5;

// Priority mapping for moderationLog
const PRIORITY_MAP = {
  SEXUAL: "HIGH",
  VIOLENCE_OR_THREAT: "CRITICAL",
};

// ─── PII Regex Patterns ─────────────────────────────────────────────────────
const PII_PATTERNS = [
  {
    name: "PII_PHONE",
    // US: (555) 123-4567, 555-123-4567, +1 555 123 4567
    // International: +91 98765 43210, +44 20 7946 0958
    pattern:
      /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b/,
    description: "Phone number pattern detected",
  },
  {
    name: "PII_EMAIL",
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/,
    description: "Email address detected",
  },
  {
    name: "PII_ADDRESS",
    // Street addresses: "123 Main St", "456 Oak Avenue"
    pattern:
      /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Terr(?:ace)?|Pike|Hwy|Highway)\b/i,
    description: "Street address pattern detected",
  },
  {
    name: "PII_ADDRESS_UNIT",
    pattern:
      /\b(?:Apt|Apartment|Suite|Ste|Unit|Bldg|Building|Fl(?:oor)?|Rm|Room)\s*[#.]?\s*\d+\b/i,
    description: "Address unit pattern detected",
  },
  {
    name: "PII_SOCIAL",
    // Social media handles: @username (not email-like)
    pattern: /(?:^|\s)@[a-zA-Z_]\w{2,29}(?!\.\w)/m,
    description: "Social media handle detected",
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function truncateText(text) {
  if (text.length <= 20) return text;
  return text.slice(0, 20) + "…";
}

/**
 * Run PII regex checks. Returns first match or null.
 */
function checkPII(text) {
  for (const { name, pattern, description } of PII_PATTERNS) {
    if (pattern.test(text)) {
      return { reason: name, description };
    }
  }
  return null;
}

/**
 * Local fallback safety check (used if AWS Comprehend API is unreachable/unsubscribed).
 */
const LOCAL_SAFETY_PATTERNS = [
  {
    reason: "SELF_HARM",
    pattern:
      /\b(?:suicide|kill\s+myself|end\s+my\s+life|self-harm|want\s+to\s+die)\b/i,
    priority: "CRITICAL",
  },
  {
    reason: "VIOLENCE_OR_THREAT",
    pattern: /\b(?:bomb|shoot\s+up|kill\s+everyone|massacre|terrorist)\b/i,
    priority: "CRITICAL",
  },
  {
    reason: "HATE_SPEECH",
    pattern: /\b(?:nigger|faggot|retard|chink|kike|spic)\b/i,
    priority: "HIGH",
  },
  {
    reason: "SEXUAL",
    pattern: /\b(?:child\s+porn|cp\b|explicit\s+nude)\b/i,
    priority: "HIGH",
  },
];

function checkLocalSafety(text) {
  for (const { reason, pattern, priority } of LOCAL_SAFETY_PATTERNS) {
    if (pattern.test(text)) {
      return {
        passed: false,
        reason,
        description: `Local fallback safety rule triggered: ${reason}`,
        scores: { _fallback: 1.0 },
        priority,
      };
    }
  }
  return { passed: true, scores: { _fallback: 0 }, priority: "NORMAL" };
}

/**
 * Call AWS Comprehend DetectToxicContent with local fallback if AWS is unsubscribed/unavailable.
 * Returns { passed, reason, description, scores, priority }.
 */
async function checkContentSafety(text) {
  try {
    const command = new DetectToxicContentCommand({
      LanguageCode: "en",
      TextSegments: [{ Text: text }],
    });

    const response = await comprehendClient.send(command);
    const result = response.ResultList?.[0];

    if (!result) {
      return checkLocalSafety(text);
    }

    // Build scores map for logging
    const scores = {};
    for (const label of result.Labels || []) {
      scores[label.Name] = label.Score;
    }
    scores._overallToxicity = result.Toxicity;

    // Check overall toxicity first
    if (result.Toxicity >= OVERALL_TOXICITY_THRESHOLD) {
      return {
        passed: false,
        reason: "TOXICITY",
        description: `Overall toxicity ${result.Toxicity.toFixed(2)} >= ${OVERALL_TOXICITY_THRESHOLD}`,
        scores,
        priority: "NORMAL",
      };
    }

    // Check each label against its threshold
    for (const label of result.Labels || []) {
      const threshold = THRESHOLDS[label.Name];
      if (threshold !== undefined && label.Score >= threshold) {
        const priority = PRIORITY_MAP[label.Name] || "NORMAL";
        return {
          passed: false,
          reason: label.Name,
          description: `${label.Name} score ${label.Score.toFixed(2)} >= threshold ${threshold}`,
          scores,
          priority,
        };
      }
    }

    return { passed: true, scores, priority: "NORMAL" };
  } catch (err) {
    console.warn(
      `  ⚠️  AWS Comprehend API notice (${err.message}) — using local safety fallback.`,
    );
    return checkLocalSafety(text);
  }
}

/**
 * Write a rejection entry to the moderationLog collection.
 * Stores hashed + truncated text — never full plaintext.
 */
async function logRejection(
  confessionId,
  text,
  reason,
  description,
  scores,
  priority,
) {
  await db.collection("moderationLog").add({
    confessionId,
    reason,
    description,
    textHash: hashText(text),
    textPreview: truncateText(text),
    scores: scores || {},
    priority,
    timestamp: FieldValue.serverTimestamp(),
  });
}

/**
 * Moderate a single confession document.
 */
async function moderateConfession(docSnapshot) {
  const docId = docSnapshot.id;
  const data = docSnapshot.data();
  const text = data.text;

  // Guard: only process "pending" documents
  if (data.moderationStatus !== "pending") {
    return;
  }

  if (!text || typeof text !== "string" || text.trim().length === 0) {
    console.log(`  ⚠️  ${docId}: empty text → rejected`);
    await docSnapshot.ref.update({ moderationStatus: "rejected" });
    return;
  }

  const docRef = docSnapshot.ref;

  try {
    // ── Step 1: PII regex check (cheapest, runs first) ────────────────────
    const piiResult = checkPII(text);
    if (piiResult) {
      console.log(`  ❌ ${docId}: PII detected — ${piiResult.reason}`);
      await docRef.update({ moderationStatus: "rejected" });
      await logRejection(
        docId,
        text,
        piiResult.reason,
        piiResult.description,
        {},
        "NORMAL",
      );
      return;
    }

    // ── Step 2: AWS Comprehend toxicity check ─────────────────────────────
    const safetyResult = await checkContentSafety(text);
    if (!safetyResult.passed) {
      console.log(
        `  ❌ ${docId}: ${safetyResult.reason} — ${safetyResult.description}`,
      );
      await docRef.update({ moderationStatus: "rejected" });
      await logRejection(
        docId,
        text,
        safetyResult.reason,
        safetyResult.description,
        safetyResult.scores,
        safetyResult.priority,
      );
      return;
    }

    // ── Step 3: All checks passed ─────────────────────────────────────────
    console.log(`  ✅ ${docId}: passed all moderation checks`);
    await docRef.update({ moderationStatus: "passed" });

    // Trigger drop scheduler immediately so drops don't wait for 60s tick
    dropSchedulerTick();
  } catch (err) {
    // Fail closed — leave as "pending" so it can be retried
    console.error(`  ⚠️  Error moderating ${docId}:`, err.message);
  }
}

// ─── Firestore Listener (Moderation) ─────────────────────────────────────────

function startListening() {
  console.log("\n🔍 Listening for pending confessions...\n");

  const query = db
    .collection("pendingConfessions")
    .where("moderationStatus", "==", "pending");

  query.onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          const doc = change.doc;
          console.log(`📨 New confession: ${doc.id}`);
          moderateConfession(doc);
        }
      });
    },
    (error) => {
      console.error("❌ Firestore listener error:", error.message);
      console.log("   Reconnecting in 5 seconds...");
      setTimeout(startListening, 5000);
    },
  );
}

// ─── User Reports Listener ──────────────────────────────────────────────────
// Watches the `reports` collection for user-submitted reports during live drops.
// Processes each report: logs to moderationLog, increments reportCount on the
// author, and freezes the account if it crosses the threshold.

const FREEZE_THRESHOLD = 5; // Configurable: freeze after this many reports

/**
 * Process a single user report.
 * 1. Read the drop to get confession text + authorUid
 * 2. Write moderationLog entry (hashed/truncated text)
 * 3. Increment reportCount on the author's user doc
 * 4. If reportCount >= threshold, set isFrozen = true
 * 5. Delete the report document
 */
async function processReport(reportDoc) {
  const reportId = reportDoc.id;
  const reportData = reportDoc.data();
  const { dropId, reporterUid } = reportData;

  try {
    // 1. Read the drop document to get confession text and author
    let confessionText = reportData.confessionText || "[text unavailable]";
    let authorUid = null;
    let confessionId = null;

    const dropDoc = await db.collection("drops").doc(dropId).get();
    if (dropDoc.exists) {
      const dropData = dropDoc.data();
      confessionText = dropData.text || confessionText;
      confessionId = dropData.confessionId;

      // Look up the author from the pendingConfession if available
      if (confessionId) {
        const confessionDoc = await db
          .collection("pendingConfessions")
          .doc(confessionId)
          .get();
        if (confessionDoc.exists) {
          authorUid = confessionDoc.data().authorUid;
        }
      }
    }

    // 2. Write moderationLog entry (hashed/truncated, not full plaintext)
    await db.collection("moderationLog").add({
      confessionId: confessionId || dropId,
      dropId,
      reason: "user-reported",
      description: `Reported by user during live drop`,
      textHash: hashText(confessionText),
      textPreview: truncateText(confessionText),
      reporterUid,
      priority: "NORMAL",
      timestamp: FieldValue.serverTimestamp(),
    });

    // 3. Increment reportCount on author's user doc + check freeze
    if (authorUid) {
      const userRef = db.collection("users").doc(authorUid);
      await userRef.set(
        { reportCount: FieldValue.increment(1) },
        { merge: true },
      );

      // Check if the author should be frozen
      const updatedUser = await userRef.get();
      const reportCount = updatedUser.data()?.reportCount || 0;

      if (reportCount >= FREEZE_THRESHOLD) {
        await userRef.update({ isFrozen: true });
        console.log(
          `  🧊 User ${authorUid} frozen (reportCount: ${reportCount} >= ${FREEZE_THRESHOLD})`,
        );
      }

      console.log(
        `  🚩 Report processed: drop ${dropId}, author ${authorUid} ` +
          `(reportCount: ${reportCount})`,
      );
    } else {
      console.log(`  🚩 Report processed: drop ${dropId} (author unknown)`);
    }

    // 4. Delete the processed report
    await reportDoc.ref.delete();
  } catch (err) {
    console.error(`  ❌ Failed to process report ${reportId}:`, err.message);
    // Still try to clean up the report doc
    try {
      await reportDoc.ref.delete();
    } catch {
      /* ignore cleanup error */
    }
  }
}

function startReportListener() {
  console.log("🚩 Listening for user reports...\n");

  db.collection("reports").onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === "added") {
          processReport(change.doc);
        }
      });
    },
    (error) => {
      console.error("❌ Report listener error:", error.message);
      setTimeout(startReportListener, 5000);
    },
  );
}

const DROP_INTERVAL_MS = 60_000; // Run every 60 seconds
const ACTIVE_WINDOW_MS = 2 * 60_000; // "Active" = heartbeat within last 2 minutes
const DROP_RECIPIENT_COUNT = 100; // Fixed blast radius
const MAX_CONFESSIONS_PER_TICK = 10; // Process at most 10 confessions per cycle
const DROP_DURATION_MS = 60_000; // Confession is live for 60 seconds total to gather reactions

// Reaction emojis — must match client-side EMOJIS array
const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

/**
 * Fisher-Yates shuffle — O(n), uniform distribution.
 * Uses crypto.randomInt() for cryptographically secure randomness.
 */
function fisherYatesShuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(0, i + 1); // [0, i] inclusive
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * Get all currently active user UIDs grouped by communityId (heartbeat within ACTIVE_WINDOW_MS).
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
 * Always EXCLUDES the confession author so the confessing author never receives
 * their own confession drop — only other active users react to it.
 */
function selectRecipients(activeUids, authorUid, count) {
  if (!activeUids || activeUids.length === 0) return [];

  // Exclude the author from the recipient pool
  const pool = activeUids.filter((uid) => uid !== authorUid);

  if (pool.length === 0) return [];
  if (pool.length <= count) return pool;

  const shuffled = fisherYatesShuffle(pool);
  return shuffled.slice(0, count);
}

// ─── Expiry Sweeper ──────────────────────────────────────────────────────────
// Polls every few seconds for drops whose broadcast window has elapsed.
// For each expired drop: snapshot reactions → write verdict → hard-delete everything.

const EXPIRY_SWEEP_INTERVAL_MS = 5_000; // Check every 5 seconds

/**
 * Delete all documents in a subcollection. Firestore doesn't support
 * recursive deletes from the client SDK, so we fetch + batch-delete.
 */
async function deleteSubcollection(parentRef, subcollectionName) {
  const snapshot = await parentRef.collection(subcollectionName).get();
  if (snapshot.empty) return;

  const batch = db.batch();
  snapshot.docs.forEach((doc) => batch.delete(doc.ref));
  await batch.commit();
}

/**
 * Process a single expired drop:
 * 1. Read final reaction counts from the reactions subcollection
 * 2. Write a verdict doc (reaction totals only — NO confession text)
 * 3. Hard-delete: reactions subcollection, drop doc, pendingConfession doc
 */
async function processExpiredDrop(dropDoc) {
  const dropId = dropDoc.id;
  const dropData = dropDoc.data();
  const confessionId = dropData.confessionId;
  const dropRef = dropDoc.ref;

  try {
    // 1. Capture final reaction counts
    const reactionsSnapshot = await dropRef.collection("reactions").get();
    const reactionTotals = {};
    reactionsSnapshot.forEach((doc) => {
      reactionTotals[doc.id] = doc.data().count || 0;
    });

    // Capture comments with proper sorting
    const commentsSnapshot = await dropRef
      .collection("comments")
      .orderBy("createdAt", "asc")
      .get();
    const finalComments = [];
    commentsSnapshot.forEach((doc) => {
      const commentData = doc.data();
      finalComments.push({
        id: doc.id,
        text: commentData.text,
        createdAt: commentData.createdAt,
        uid: commentData.uid,
      });
    });

    // 2. Write verdict (reaction totals, comments, AND confession text for the author)
    await db
      .collection("verdicts")
      .doc(dropId)
      .set({
        dropId,
        confessionId,
        authorUid: dropData.authorUid || null,
        recipientUids: dropData.recipientUids || [],
        recipientCount: dropData.recipientCount || 0,
        text: dropData.text || "", // Store confession text so author can see it
        reactions: reactionTotals,
        comments: finalComments,
        totalReactions: Object.values(reactionTotals).reduce(
          (a, b) => a + b,
          0,
        ),
        expiredAt: FieldValue.serverTimestamp(),
      });

    // 3. Hard-delete: reactions subcollection
    await deleteSubcollection(dropRef, "reactions");

    // 3b. Hard-delete: voters subcollection (reaction dedup records)
    await deleteSubcollection(dropRef, "voters");

    // 3c. Hard-delete: comments subcollection (ephemeral anonymous comments)
    await deleteSubcollection(dropRef, "comments");

    // 3d. Clear in-memory comment cache for this drop
    if (global.commentsCache && global.commentsCache[dropId]) {
      delete global.commentsCache[dropId];
    }

    // 4. Hard-delete: the drop document itself
    await dropRef.delete();

    // 5. Hard-delete: the original pendingConfession
    if (confessionId) {
      await db.collection("pendingConfessions").doc(confessionId).delete();
    }

    console.log(
      `  🗑️  Drop ${dropId} fully expired → verdict written, ` +
        `drop + reactions + confession ${confessionId} hard-deleted`,
    );
  } catch (err) {
    console.error(`  ❌ Failed to expire drop ${dropId}:`, err.message);
  }
}

/**
 * One tick of the expiry sweeper.
 * Finds all "broadcasting" drops where broadcastStartedAt + 10s has passed.
 */
async function expirySweepTick() {
  try {
    const cutoff = new Date(Date.now() - DROP_DURATION_MS);

    const expiredSnapshot = await db
      .collection("drops")
      .where("status", "==", "broadcasting")
      .where("broadcastStartedAt", "<=", cutoff)
      .get();

    if (expiredSnapshot.empty) return;

    console.log(`\n⏰ Expiry sweep: ${expiredSnapshot.size} drop(s) to expire`);

    for (const dropDoc of expiredSnapshot.docs) {
      await processExpiredDrop(dropDoc);
    }
  } catch (err) {
    console.error("  ❌ Expiry sweeper error:", err.message);
  }
}

function startExpirySweeper() {
  console.log(
    `🧹 Expiry sweeper started (every ${EXPIRY_SWEEP_INTERVAL_MS / 1000}s)\n`,
  );
  setInterval(expirySweepTick, EXPIRY_SWEEP_INTERVAL_MS);
}

let isScheduling = false;

/**
 * One tick of the drop scheduler.
 * Queries passed confessions, selects random recipients, creates drops,
 * seeds reaction subdocs, and schedules 10-second expiry.
 */
async function dropSchedulerTick() {
  if (isScheduling) return;
  isScheduling = true;
  try {
    // 1. Find passed confessions that haven't been scheduled yet
    const passedSnapshot = await db
      .collection("pendingConfessions")
      .where("moderationStatus", "==", "passed")
      .limit(MAX_CONFESSIONS_PER_TICK)
      .get();

    if (passedSnapshot.empty) return; // nothing to schedule

    // 2. Get active user pool grouped by community
    const communityMap = await getActiveUsersByCommunity();
    const totalActive = Object.values(communityMap).reduce(
      (acc, arr) => acc + arr.length,
      0,
    );

    if (totalActive === 0) {
      console.log("  ⏳ No active users — skipping drop cycle");
      return;
    }

    console.log(
      `\n🎯 Drop tick: ${passedSnapshot.size} confession(s), ${totalActive} active user(s)`,
    );

    // 3. Create a drop for each passed confession
    for (const confessionDoc of passedSnapshot.docs) {
      // Immediately mark as scheduled to prevent concurrent ticks from processing it
      await confessionDoc.ref.update({ moderationStatus: "scheduled" });

      const confessionData = confessionDoc.data();
      const confessionId = confessionDoc.id;
      const authorUid = confessionData.authorUid;
      const targetCommunity = confessionData.communityId || "global";

      const activeUids = communityMap[targetCommunity] || [];

      // Select random recipients
      const recipients = selectRecipients(
        activeUids,
        authorUid,
        DROP_RECIPIENT_COUNT,
      );

      if (recipients.length === 0) {
        console.log(
          `  ⏳ ${confessionId}: no eligible recipients in community '${targetCommunity}'`,
        );
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

      console.log(
        `  📡 Drop created: ${dropRef.id} → ${recipients.length} recipients ` +
          `(confession: ${confessionId})`,
      );

      // Expiry is handled by the sweeper — no setTimeout needed
    }
  } catch (err) {
    console.error("  ❌ Drop scheduler error:", err.message);
  } finally {
    isScheduling = false;
  }
}

function startDropScheduler() {
  console.log(
    `⏱️  Drop scheduler started (every ${DROP_INTERVAL_MS / 1000}s)\n`,
  );

  // Run once immediately, then on interval
  dropSchedulerTick();
  setInterval(dropSchedulerTick, DROP_INTERVAL_MS);
}

// ─── Hall of Fame Daily Rollup ───────────────────────────────────────────────
// Runs periodically, checks if the current UTC day has un-rolled verdicts,
// and sums all reaction totals into a single hallOfFameStats/{date} doc.
// Only aggregate counts — never any confession text or individual verdict data.

const ROLLUP_CHECK_INTERVAL_MS = 60_000; // Check every 60 seconds

/**
 * Get today's date key in YYYY-MM-DD (UTC).
 */
function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Run the daily rollup: query all verdicts whose expiredAt is at least 5 minutes old,
 * sum their reaction counts, update hallOfFameStats/{date}, and clean up old verdict docs.
 * Leaving recent verdicts intact gives clients time to view the Verdict screen.
 */
async function rollupHallOfFame() {
  const today = getTodayKey();
  const FIVE_MINUTES_AGO = new Date(Date.now() - 5 * 60_000);

  try {
    // Only query verdicts that are at least 5 minutes old (clients have finished viewing)
    const verdictsSnapshot = await db
      .collection("verdicts")
      .where("expiredAt", "<=", FIVE_MINUTES_AGO)
      .get();

    if (verdictsSnapshot.empty) return; // nothing old enough to roll up yet

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
        totalReactions += count || 0;
      }
    });

    // Merge with existing daily totals
    if (existing) {
      const prevTotals = existing.emojiTotals || {};
      for (const emoji of EMOJIS) {
        emojiTotals[emoji] =
          (emojiTotals[emoji] || 0) + (prevTotals[emoji] || 0);
      }
      totalConfessions += existing.totalConfessions || 0;
      totalReactions += existing.totalReactions || 0;
    }

    // Write the rollup
    await db.collection("hallOfFameStats").doc(today).set({
      date: today,
      emojiTotals,
      totalConfessions,
      totalReactions,
      lastUpdated: FieldValue.serverTimestamp(),
    });

    // Clean up consumed verdicts that are at least 5 minutes old
    const deleteBatch = db.batch();
    verdictsSnapshot.docs.forEach((doc) => deleteBatch.delete(doc.ref));
    await deleteBatch.commit();

    console.log(
      `  🏆 Hall of Fame rollup: ${today} — ` +
        `${verdictsSnapshot.size} verdict(s) (>=5m old) consumed, ` +
        `${totalReactions} total reactions`,
    );
  } catch (err) {
    console.error("  ❌ Hall of Fame rollup error:", err.message);
  }
}

function startHallOfFameRollup() {
  console.log(
    `🏆 Hall of Fame rollup started (checks every ${ROLLUP_CHECK_INTERVAL_MS / 1000}s)\n`,
  );
  setInterval(rollupHallOfFame, ROLLUP_CHECK_INTERVAL_MS);
}

// ─── Start Server ────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════╗");
console.log("║   Verdict — Moderation + Drop Server         ║");
console.log("╚══════════════════════════════════════════════╝");

startListening();
startReportListener();
startDropScheduler();
startExpirySweeper();
startHallOfFameRollup();

// ─── Socket.IO Server for Comments ──────────────────────────────────────────
const httpServer = http.createServer();
const io = new Server(httpServer, {
  cors: {
    origin: "*", // allow all origins for dev
  },
});

// Cache comments in memory so late joiners can see them
global.commentsCache = {}; // { [dropId]: [{ id, text, createdAt }] }

io.on("connection", (socket) => {
  // Client joins a specific drop's room
  socket.on("join_drop", (dropId) => {
    socket.join(dropId);

    // Send existing comments to the newly joined client
    const existingComments = global.commentsCache[dropId] || [];
    socket.emit("initial_comments", existingComments);
  });

  // Client sends a new comment
  socket.on("send_comment", (data) => {
    const { dropId, text } = data;
    if (!dropId || !text || text.trim().length === 0) return;

    const trimmed = text.trim().slice(0, 80);
    const commentObj = {
      id: Math.random().toString(36).substring(2, 9),
      text: trimmed,
      createdAt: { toMillis: () => Date.now() }, // Mock Firestore Timestamp shape for client compat
    };

    if (!global.commentsCache[dropId]) {
      global.commentsCache[dropId] = [];
    }
    global.commentsCache[dropId].push(commentObj);

    // Broadcast to everyone in the room (including sender to trigger optimistic update if needed, but we rely on the broadcast for everyone)
    io.to(dropId).emit("new_comment", commentObj);
  });
});

const SOCKET_PORT = process.env.SOCKET_PORT || 3001;
httpServer.listen(SOCKET_PORT, () => {
  console.log(`🔌 Socket.IO server running on port ${SOCKET_PORT}`);
});
