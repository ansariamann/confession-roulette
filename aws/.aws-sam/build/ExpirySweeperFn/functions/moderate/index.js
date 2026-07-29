// ─── Moderate Lambda ─────────────────────────────────────────────────────────
// Trigger: API Gateway HTTP POST /confess
// Auth: Validates Firebase ID token from Authorization header
//
// This is the BLOCKING moderation gate. The confession must pass all checks
// before it is written to Firestore. Bad content never touches the database.
//
// Order of checks (per 04_MODERATION_SPEC.md):
//   1. PII regex detection (cheapest, runs first)
//   2. AWS Comprehend toxicity/harassment/threat classification
//   3. CSAM / minor-endangerment (covered by Comprehend SEXUAL label)
//   4. Self-harm / suicide content → block + surface crisis resources
//   5. Illegal content / doxxing / credible threats → block + flag
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const { checkPII, checkContentSafety, logRejection } = require("../../shared/moderation");
const { scheduleConfessionById } = require("../../shared/schedule-drop");

// Firebase Auth — verify ID tokens
const { getAuth } = require("firebase-admin/auth");
const auth = getAuth();

// Crisis resources message for self-harm content
const CRISIS_MESSAGE =
  "If you or someone you know is struggling, please reach out: " +
  "National Suicide Prevention Lifeline: 988 | Crisis Text Line: Text HOME to 741741 | " +
  "International Association for Suicide Prevention: https://www.iasp.info/resources/Crisis_Centres/";

/**
 * Verify Firebase ID token from Authorization header.
 * Returns the decoded token (contains uid, email, etc.) or null.
 */
async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const idToken = authHeader.slice(7);
  try {
    return await auth.verifyIdToken(idToken);
  } catch (err) {
    console.warn("Token verification failed:", err.message);
    return null;
  }
}

/**
 * Build a standard API Gateway HTTP response.
 */
function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  // Handle CORS preflight
  if (event.requestContext?.http?.method === "OPTIONS") {
    return response(204, {});
  }

  try {
    // ── Auth ────────────────────────────────────────────────────────────────
    const decodedToken = await verifyToken(
      event.headers?.authorization || event.headers?.Authorization
    );
    if (!decodedToken) {
      return response(401, { error: "Unauthorized — invalid or missing token" });
    }
    const uid = decodedToken.uid;

    // ── Parse body ──────────────────────────────────────────────────────────
    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch {
      return response(400, { error: "Invalid JSON body" });
    }

    const text = body?.text?.trim();

    if (!text || typeof text !== "string" || text.length === 0) {
      return response(400, { error: "Confession text is required" });
    }
    if (text.length > 300) {
      return response(400, { error: "Confession too long (max 280 characters)" });
    }

    // ── Check frozen status + resolve community from server-side user doc ───
    const userDoc = await db.collection("users").doc(uid).get();
    if (userDoc.exists && userDoc.data().isFrozen === true) {
      return response(403, { error: "Your account is frozen due to multiple reports" });
    }

    const { normalizeCommunityId } = require("../../shared/community");
    const userCommunity = userDoc.exists ? userDoc.data().communityId : null;
    const communityId = normalizeCommunityId(userCommunity);

    if (!userCommunity) {
      return response(403, { error: "You must join a community before confessing" });
    }

    // ── Step 1: PII regex check (cheapest, runs first) ──────────────────────
    const piiResult = checkPII(text);
    if (piiResult) {
      console.log(`❌ PII detected for ${uid}: ${piiResult.reason}`);
      await logRejection(db, FieldValue, `pii-${Date.now()}`, text, piiResult.reason, piiResult.description, {}, "NORMAL");
      return response(422, {
        error: "Your confession contains personal information (phone, email, address, or social handle). Please remove it and try again.",
        reason: "PII_DETECTED",
      });
    }

    // ── Step 2: AWS Comprehend toxicity check ────────────────────────────────
    const safetyResult = await checkContentSafety(text);
    if (!safetyResult.passed) {
      console.log(`❌ Safety rejected for ${uid}: ${safetyResult.reason} — ${safetyResult.description}`);
      await logRejection(db, FieldValue, `safety-${Date.now()}`, text, safetyResult.reason, safetyResult.description, safetyResult.scores, safetyResult.priority);

      // Special handling: self-harm → surface crisis resources, don't just reject silently
      if (safetyResult.reason === "SELF_HARM" || safetyResult.reason === "VIOLENCE_OR_THREAT") {
        const isSelfHarm = safetyResult.reason === "SELF_HARM";
        return response(422, {
          error: isSelfHarm
            ? "We care about you. This content can't be broadcast, but please know help is available."
            : "This confession was flagged for safety and cannot be broadcast.",
          reason: safetyResult.reason,
          crisisResources: isSelfHarm ? CRISIS_MESSAGE : undefined,
        });
      }

      return response(422, {
        error: "Your confession was flagged by our safety filter and cannot be broadcast. Please rephrase and try again.",
        reason: "SAFETY_FLAGGED",
      });
    }

    // ── Step 3: All checks passed — write to Firestore ──────────────────────
    const confessionRef = await db.collection("pendingConfessions").add({
      text,
      submittedAt: FieldValue.serverTimestamp(),
      authorUid: uid,
      communityId,
      moderationStatus: "passed",
    });

    // Also touch presence so the drop scheduler sees the author as active
    await db.collection("presence").doc(uid).set(
      { lastSeen: FieldValue.serverTimestamp(), communityId },
      { merge: true }
    );

    console.log(`✅ Confession ${confessionRef.id} passed moderation for ${uid}`);

    // Drop immediately — don't wait for the scheduler tick
    const dropResult = await scheduleConfessionById(
      confessionRef.id,
      process.env.EXPIRY_QUEUE_URL,
    );

    return response(200, {
      status: dropResult ? "live" : "queued",
      confessionId: confessionRef.id,
      dropId: dropResult?.dropId || null,
    });
  } catch (err) {
    console.error("Moderate Lambda error:", err);
    return response(500, { error: "Internal server error" });
  }
};
