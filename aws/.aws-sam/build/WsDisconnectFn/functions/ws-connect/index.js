// ─── WebSocket Connect Lambda ────────────────────────────────────────────────
// Trigger: API Gateway WebSocket $connect route
//
// Stores the connectionId in Firestore wsConnections collection so we can
// look up all connections for a given dropId when broadcasting comments.
//
// The client connects with: wss://xxx.execute-api.region.amazonaws.com/prod?dropId=abc123
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const dropId = event.queryStringParameters?.dropId;

  if (!dropId) {
    console.warn(`⚠️ WebSocket connect without dropId — connectionId: ${connectionId}`);
    return { statusCode: 400, body: "Missing dropId query parameter" };
  }

  try {
    await db.collection("wsConnections").doc(connectionId).set({
      connectionId,
      dropId,
      connectedAt: FieldValue.serverTimestamp(),
    });

    console.log(`🔌 Connected: ${connectionId} → drop ${dropId}`);
    return { statusCode: 200, body: "Connected" };
  } catch (err) {
    console.error("WebSocket connect error:", err);
    return { statusCode: 500, body: "Failed to register connection" };
  }
};
