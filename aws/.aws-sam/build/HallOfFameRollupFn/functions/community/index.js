// ─── Community Lambda ───────────────────────────────────────────────────────
// POST /community/join  — join or switch community (updates member counts)
// GET  /community/stats — member + active counts for a community
// ─────────────────────────────────────────────────────────────────────────────

const { getAuth } = require("firebase-admin/auth");
const { joinCommunity, getCommunityStats } = require("../../shared/community");

const auth = getAuth();

async function verifyToken(authHeader) {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  try {
    return await auth.verifyIdToken(authHeader.slice(7));
  } catch {
    return null;
  }
}

function response(statusCode, body, methods = "GET, POST, OPTIONS") {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": methods,
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  const method = event.requestContext?.http?.method;

  if (method === "OPTIONS") {
    return response(204, {});
  }

  try {
    const decodedToken = await verifyToken(
      event.headers?.authorization || event.headers?.Authorization,
    );
    if (!decodedToken) {
      return response(401, { error: "Unauthorized — invalid or missing token" });
    }

    if (method === "GET") {
      const communityName =
        event.queryStringParameters?.communityName ||
        event.queryStringParameters?.name;

      if (!communityName) {
        return response(400, { error: "communityName query parameter is required" });
      }

      const stats = await getCommunityStats(communityName);
      return response(200, stats);
    }

    if (method === "POST") {
      let body;
      try {
        body = typeof event.body === "string" ? JSON.parse(event.body) : event.body;
      } catch {
        return response(400, { error: "Invalid JSON body" });
      }

      const communityName = body?.communityName?.trim();
      if (!communityName || communityName.length < 2) {
        return response(400, { error: "communityName is required (min 2 characters)" });
      }

      const result = await joinCommunity(decodedToken.uid, communityName);
      console.log(`✅ ${decodedToken.uid} joined community "${result.communityId}" (${result.memberCount} members, ${result.activeCount} online)`);
      return response(200, result);
    }

    return response(405, { error: "Method not allowed" });
  } catch (err) {
    console.error("Community Lambda error:", err);
    return response(500, { error: "Internal server error" });
  }
};
