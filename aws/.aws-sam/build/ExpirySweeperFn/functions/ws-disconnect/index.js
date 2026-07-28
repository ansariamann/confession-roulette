// ─── WebSocket Disconnect Lambda ─────────────────────────────────────────────
// Trigger: API Gateway WebSocket $disconnect route
//
// Removes the connectionId document from Firestore wsConnections when a
// client disconnects.
// ─────────────────────────────────────────────────────────────────────────────

const { db } = require("../../shared/firebase-admin");

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  try {
    await db.collection("wsConnections").doc(connectionId).delete();
    console.log(`🔌 Disconnected: ${connectionId}`);
    return { statusCode: 200, body: "Disconnected" };
  } catch (err) {
    console.error("WebSocket disconnect error:", err);
    // Non-fatal — connection doc will be cleaned up by stale detection
    return { statusCode: 200, body: "Disconnected (cleanup warning)" };
  }
};
