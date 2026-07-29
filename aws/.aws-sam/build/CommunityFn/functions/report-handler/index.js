// ─── Report Handler Lambda ───────────────────────────────────────────────────
// Trigger: API Gateway HTTP POST /report
// Auth: Validates Firebase ID token from Authorization header
//
// Processes user reports during live drops:
//   1. Log to moderationLog (hashed/truncated text)
//   2. Increment reportCount on the confession author
//   3. Freeze account if reportCount >= threshold
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const { hashText, truncateText } = require("../../shared/moderation");
const { FREEZE_THRESHOLD } = require("../../shared/constants");
const { getAuth } = require("firebase-admin/auth");

const auth = getAuth();

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
    // ── Auth ──────────────────────────────────────────────────────────────
    const decodedToken = await verifyToken(
      event.headers?.authorization || event.headers?.Authorization
    );
    if (!decodedToken) {
      return response(401, { error: "Unauthorized" });
    }
    const reporterUid = decodedToken.uid;

    // ── Parse body ────────────────────────────────────────────────────────
    let body;
    try {
      body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
    } catch {
      return response(400, { error: "Invalid JSON body" });
    }

    const { dropId } = body;
    if (!dropId) {
      return response(400, { error: "dropId is required" });
    }

    // ── Read the drop document ────────────────────────────────────────────
    let confessionText = "[text unavailable]";
    let authorUid = null;
    let confessionId = null;

    const dropDoc = await db.collection("drops").doc(dropId).get();
    if (dropDoc.exists) {
      const dropData = dropDoc.data();
      confessionText = dropData.text || confessionText;
      confessionId = dropData.confessionId;

      // Look up the author from the pendingConfession if available
      if (confessionId) {
        const confessionDoc = await db.collection("pendingConfessions").doc(confessionId).get();
        if (confessionDoc.exists) {
          authorUid = confessionDoc.data().authorUid;
        }
      }

      // Fallback: author might be on the drop doc directly
      if (!authorUid) {
        authorUid = dropData.authorUid;
      }
    }

    // ── Write moderationLog entry (hashed/truncated, not full plaintext) ──
    await db.collection("moderationLog").add({
      confessionId: confessionId || dropId,
      dropId,
      reason: "user-reported",
      description: "Reported by user during live drop",
      textHash: hashText(confessionText),
      textPreview: truncateText(confessionText),
      reporterUid,
      priority: "NORMAL",
      timestamp: FieldValue.serverTimestamp(),
    });

    // ── Increment reportCount on author + check freeze ────────────────────
    if (authorUid) {
      const userRef = db.collection("users").doc(authorUid);
      await userRef.set(
        { reportCount: FieldValue.increment(1) },
        { merge: true }
      );

      const updatedUser = await userRef.get();
      const reportCount = updatedUser.data()?.reportCount || 0;

      if (reportCount >= FREEZE_THRESHOLD) {
        await userRef.update({ isFrozen: true });
        console.log(`🧊 User ${authorUid} frozen (reportCount: ${reportCount} >= ${FREEZE_THRESHOLD})`);
      }

      console.log(`🚩 Report processed: drop ${dropId}, author ${authorUid} (reportCount: ${reportCount})`);
    } else {
      console.log(`🚩 Report processed: drop ${dropId} (author unknown)`);
    }

    return response(200, { status: "reported" });
  } catch (err) {
    console.error("Report Handler error:", err);
    return response(500, { error: "Internal server error" });
  }
};
