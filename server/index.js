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

// ─── Firebase Admin Init ─────────────────────────────────────────────────────
const serviceAccountPath = path.join(__dirname, "serviceAccountKey.json");

let app;
try {
  const serviceAccount = require(serviceAccountPath);
  app = initializeApp({ credential: cert(serviceAccount) });
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
  // Credentials are picked up from env vars AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY
});

// ─── Moderation Thresholds ───────────────────────────────────────────────────
// Conservative by default — over-reject is the acceptable failure mode.
// These can be loosened later based on false-positive data.
const THRESHOLDS = {
  HATE_SPEECH:          0.5,
  HARASSMENT_OR_ABUSE:  0.5,
  SEXUAL:               0.5,   // HIGH priority — covers CSAM direction
  VIOLENCE_OR_THREAT:   0.5,   // CRITICAL priority — covers self-harm, threats
  GRAPHIC:              0.5,
  INSULT:               0.7,
  PROFANITY:            0.7,
};

// Overall toxicity threshold
const OVERALL_TOXICITY_THRESHOLD = 0.5;

// Priority mapping for moderationLog
const PRIORITY_MAP = {
  SEXUAL:             "HIGH",
  VIOLENCE_OR_THREAT: "CRITICAL",
};

// ─── PII Regex Patterns ─────────────────────────────────────────────────────
const PII_PATTERNS = [
  {
    name: "PII_PHONE",
    // US: (555) 123-4567, 555-123-4567, +1 555 123 4567
    // International: +91 98765 43210, +44 20 7946 0958
    pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b/,
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
    pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Terr(?:ace)?|Pike|Hwy|Highway)\b/i,
    description: "Street address pattern detected",
  },
  {
    name: "PII_ADDRESS_UNIT",
    pattern: /\b(?:Apt|Apartment|Suite|Ste|Unit|Bldg|Building|Fl(?:oor)?|Rm|Room)\s*[#.]?\s*\d+\b/i,
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
  { reason: "SELF_HARM", pattern: /\b(?:suicide|kill\s+myself|end\s+my\s+life|self-harm|want\s+to\s+die)\b/i, priority: "CRITICAL" },
  { reason: "VIOLENCE_OR_THREAT", pattern: /\b(?:bomb|shoot\s+up|kill\s+everyone|massacre|terrorist)\b/i, priority: "CRITICAL" },
  { reason: "HATE_SPEECH", pattern: /\b(?:nigger|faggot|retard|chink|kike|spic)\b/i, priority: "HIGH" },
  { reason: "SEXUAL", pattern: /\b(?:child\s+porn|cp\b|explicit\s+nude)\b/i, priority: "HIGH" },
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
    console.warn(`  ⚠️  AWS Comprehend API notice (${err.message}) — using local safety fallback.`);
    return checkLocalSafety(text);
  }
}

/**
 * Write a rejection entry to the moderationLog collection.
 * Stores hashed + truncated text — never full plaintext.
 */
async function logRejection(confessionId, text, reason, description, scores, priority) {
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
      await logRejection(docId, text, piiResult.reason, piiResult.description, {}, "NORMAL");
      return;
    }

    // ── Step 2: AWS Comprehend toxicity check ─────────────────────────────
    const safetyResult = await checkContentSafety(text);
    if (!safetyResult.passed) {
      console.log(`  ❌ ${docId}: ${safetyResult.reason} — ${safetyResult.description}`);
      await docRef.update({ moderationStatus: "rejected" });
      await logRejection(
        docId, text,
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

const DROP_INTERVAL_MS = 60_000;       // Run every 60 seconds
const ACTIVE_WINDOW_MS = 2 * 60_000;   // "Active" = heartbeat within last 2 minutes
const DROP_RECIPIENT_COUNT = 100;      // Fixed blast radius
const MAX_CONFESSIONS_PER_TICK = 10;   // Process at most 10 confessions per cycle
const DROP_DURATION_MS = 10_000;       // Confession is live for exactly 10 seconds

// Reaction emojis — must match client-side EMOJIS array
const EMOJIS = ['😂', '💀', '😬', '❤️', '😳'];

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
 * Get all currently active user UIDs (heartbeat within ACTIVE_WINDOW_MS).
 */
async function getActiveUserUids() {
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);

  const snapshot = await db
    .collection("presence")
    .where("lastSeen", ">", cutoff)
    .get();

  return snapshot.docs.map((doc) => doc.id);
}

/**
 * Select up to `count` random recipients from the active pool,
 * excluding the confession author. Uses Fisher-Yates for uniform fairness.
 */
function selectRecipients(activeUids, authorUid, count) {
  // Remove author — you never see your own confession
  const pool = activeUids.filter((uid) => uid !== authorUid);

  if (pool.length === 0) return [];
  if (pool.length <= count) return pool; // everyone gets it

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

    // 2. Write verdict (reaction totals only — never the confession text)
    await db.collection("verdicts").doc(dropId).set({
      dropId,
      confessionId,
      recipientUids: dropData.recipientUids || [],
      recipientCount: dropData.recipientCount || 0,
      reactions: reactionTotals,
      totalReactions: Object.values(reactionTotals).reduce((a, b) => a + b, 0),
      expiredAt: FieldValue.serverTimestamp(),
    });

    // 3. Hard-delete: reactions subcollection
    await deleteSubcollection(dropRef, "reactions");

    // 4. Hard-delete: the drop document itself
    await dropRef.delete();

    // 5. Hard-delete: the original pendingConfession
    if (confessionId) {
      await db.collection("pendingConfessions").doc(confessionId).delete();
    }

    console.log(
      `  🗑️  Drop ${dropId} fully expired → verdict written, ` +
      `drop + reactions + confession ${confessionId} hard-deleted`
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
  console.log(`🧹 Expiry sweeper started (every ${EXPIRY_SWEEP_INTERVAL_MS / 1000}s)\n`);
  setInterval(expirySweepTick, EXPIRY_SWEEP_INTERVAL_MS);
}

/**
 * One tick of the drop scheduler.
 * Queries passed confessions, selects random recipients, creates drops,
 * seeds reaction subdocs, and schedules 10-second expiry.
 */
async function dropSchedulerTick() {
  try {
    // 1. Find passed confessions that haven't been scheduled yet
    const passedSnapshot = await db
      .collection("pendingConfessions")
      .where("moderationStatus", "==", "passed")
      .limit(MAX_CONFESSIONS_PER_TICK)
      .get();

    if (passedSnapshot.empty) return; // nothing to schedule

    // 2. Get active user pool
    const activeUids = await getActiveUserUids();

    if (activeUids.length === 0) {
      console.log("  ⏳ No active users — skipping drop cycle");
      return;
    }

    console.log(`\n🎯 Drop tick: ${passedSnapshot.size} confession(s), ${activeUids.length} active user(s)`);

    // 3. Create a drop for each passed confession
    for (const confessionDoc of passedSnapshot.docs) {
      const confessionData = confessionDoc.data();
      const confessionId = confessionDoc.id;
      const authorUid = confessionData.authorUid;

      // Select random recipients
      const recipients = selectRecipients(activeUids, authorUid, DROP_RECIPIENT_COUNT);

      if (recipients.length === 0) {
        console.log(`  ⏳ ${confessionId}: no eligible recipients (author is the only active user)`);
        continue;
      }

      // Create the drop document
      const dropRef = await db.collection("drops").add({
        confessionId,
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

      // Mark the confession as scheduled (so it won't be picked up again)
      await confessionDoc.ref.update({ moderationStatus: "scheduled" });

      console.log(
        `  📡 Drop created: ${dropRef.id} → ${recipients.length} recipients ` +
        `(confession: ${confessionId})`
      );

      // Expiry is handled by the sweeper — no setTimeout needed
    }
  } catch (err) {
    console.error("  ❌ Drop scheduler error:", err.message);
  }
}

function startDropScheduler() {
  console.log(`⏱️  Drop scheduler started (every ${DROP_INTERVAL_MS / 1000}s)\n`);

  // Run once immediately, then on interval
  dropSchedulerTick();
  setInterval(dropSchedulerTick, DROP_INTERVAL_MS);
}

// ─── Start Server ────────────────────────────────────────────────────────────
console.log("╔══════════════════════════════════════════════╗");
console.log("║   Verdict — Moderation + Drop Server         ║");
console.log("╚══════════════════════════════════════════════╝");

startListening();
startDropScheduler();
startExpirySweeper();
