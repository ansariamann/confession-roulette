import { NextResponse } from "next/server";
import { getAdminToken, verifyIdToken, firestoreBase } from "../../_lib/adminToken";

/**
 * POST /api/notifications/test
 * Sends a test push notification to the calling user's registered FCM tokens.
 * This bypasses the confession/drop flow entirely — useful for verifying
 * that the notification pipeline (token registration → FCM delivery → device display)
 * is working correctly.
 */
export async function POST(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let uid;
    try {
      uid = await verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const adminToken = await getAdminToken();
    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const BASE = firestoreBase();

    // Fetch user's FCM tokens
    const userRes = await fetch(`${BASE}/users/${uid}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (!userRes.ok) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const userData = await userRes.json();
    const tokens = userData.fields?.fcmTokens?.arrayValue?.values
      ?.map((v) => v.stringValue)
      .filter(Boolean) || [];

    if (tokens.length === 0) {
      return NextResponse.json({
        error: "No FCM tokens registered. Make sure you've allowed notifications.",
        tokenCount: 0,
      }, { status: 400 });
    }

    // Send a test push to each token
    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    const results = [];

    for (const token of tokens) {
      try {
        const sendRes = await fetch(fcmUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title: "🔔 Test Notification",
                body: "If you see this, your notifications are working perfectly!",
              },
              android: {
                notification: {
                  channel_id: "drops_channel",
                },
              },
              data: { url: "/settings" },
            },
          }),
        });

        const sendData = await sendRes.json();
        if (sendData.name) {
          results.push({ token: token.substring(0, 20) + "...", status: "delivered" });
        } else {
          results.push({
            token: token.substring(0, 20) + "...",
            status: "failed",
            error: sendData.error?.message || "Unknown error",
          });
        }
      } catch (err) {
        results.push({
          token: token.substring(0, 20) + "...",
          status: "error",
          error: err.message,
        });
      }
    }

    return NextResponse.json({
      success: true,
      tokenCount: tokens.length,
      results,
    });
  } catch (error) {
    console.error("Error in /api/notifications/test:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
