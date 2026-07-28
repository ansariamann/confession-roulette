// ─── WebSocket Message Lambda ────────────────────────────────────────────────
// Trigger: API Gateway WebSocket $default route
//
// Handles incoming messages from connected clients. Currently supports:
//   - "send_comment": Validates, stores in Firestore, and broadcasts to all
//     connections subscribed to the same dropId.
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("../../shared/firebase-admin");
const {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} = require("@aws-sdk/client-apigatewaymanagementapi");

const MAX_COMMENT_LENGTH = 80;

exports.handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  const domainName = event.requestContext.domainName;
  const stage = event.requestContext.stage;

  // Build the Management API client for posting back to connected clients
  const apiClient = new ApiGatewayManagementApiClient({
    endpoint: `https://${domainName}/${stage}`,
  });

  try {
    // Parse the incoming message
    let message;
    try {
      message = JSON.parse(event.body);
    } catch {
      return { statusCode: 400, body: "Invalid JSON" };
    }

    const { action, dropId, text } = message;

    if (action !== "send_comment") {
      return { statusCode: 400, body: "Unknown action" };
    }

    if (!dropId || !text || typeof text !== "string" || text.trim().length === 0) {
      return { statusCode: 400, body: "dropId and text are required" };
    }

    const trimmed = text.trim().slice(0, MAX_COMMENT_LENGTH);
    const commentId = Math.random().toString(36).substring(2, 9);

    // Store comment in Firestore (ephemeral — deleted with the drop)
    const commentDoc = {
      text: trimmed,
      createdAt: FieldValue.serverTimestamp(),
    };
    await db.collection("drops").doc(dropId).collection("comments").doc(commentId).set(commentDoc);

    // Build the broadcast payload
    const broadcastPayload = JSON.stringify({
      type: "new_comment",
      comment: {
        id: commentId,
        text: trimmed,
        createdAt: Date.now(),
      },
    });

    // Find all connections subscribed to this dropId
    const connectionsSnapshot = await db
      .collection("wsConnections")
      .where("dropId", "==", dropId)
      .get();

    // Broadcast to all connected clients
    const staleConnections = [];

    const broadcastPromises = connectionsSnapshot.docs.map(async (doc) => {
      const targetConnectionId = doc.id;
      try {
        await apiClient.send(
          new PostToConnectionCommand({
            ConnectionId: targetConnectionId,
            Data: Buffer.from(broadcastPayload),
          })
        );
      } catch (err) {
        // Connection is stale (client disconnected without $disconnect firing)
        if (err.statusCode === 410 || err.$metadata?.httpStatusCode === 410) {
          staleConnections.push(targetConnectionId);
        } else {
          console.warn(`Failed to post to ${targetConnectionId}:`, err.message);
        }
      }
    });

    await Promise.all(broadcastPromises);

    // Clean up stale connections
    if (staleConnections.length > 0) {
      const batch = db.batch();
      staleConnections.forEach((id) => {
        batch.delete(db.collection("wsConnections").doc(id));
      });
      await batch.commit();
    }

    console.log(
      `💬 Comment broadcast to ${connectionsSnapshot.size} connection(s) ` +
      `for drop ${dropId} (${staleConnections.length} stale cleaned)`
    );

    return { statusCode: 200, body: "Comment sent" };
  } catch (err) {
    console.error("WebSocket message error:", err);
    return { statusCode: 500, body: "Internal error" };
  }
};
