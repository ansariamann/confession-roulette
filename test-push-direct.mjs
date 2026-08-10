import 'dotenv/config';
import { getAdminToken } from "./app/api/_lib/adminToken.js";

async function testNotification() {
  const adminToken = await getAdminToken();
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;

  // Fetch ALL users with FCM tokens
  const BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
  const usersRes = await fetch(`${BASE}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  const usersData = await usersRes.json();
  
  const allTokens = [];
  for (const doc of (usersData.documents || [])) {
    const uid = doc.name.split("/").pop();
    const tokens = doc.fields?.fcmTokens?.arrayValue?.values?.map(v => v.stringValue).filter(Boolean) || [];
    if (tokens.length > 0) {
      allTokens.push(...tokens.map(t => ({ uid, token: t })));
    }
  }

  console.log(`Found ${allTokens.length} tokens across all users\n`);

  const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;

  for (const { uid, token } of allTokens) {
    const short = token.substring(0, 25) + '...';
    try {
      const res = await fetch(fcmUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
          message: {
            token,
            notification: {
              title: "🔔 Production Test",
              body: "Notifications are working! This came from the test script.",
            },
            android: {
              notification: { channel_id: "drops_channel" }
            },
            data: { url: "/" },
          },
        }),
      });
      const data = await res.json();
      if (data.name) {
        console.log(`✅ [${uid.substring(0,8)}] ${short} → DELIVERED`);
      } else {
        console.log(`❌ [${uid.substring(0,8)}] ${short} → ${data.error?.message}`);
      }
    } catch (err) {
      console.log(`❌ [${uid.substring(0,8)}] ${short} → ${err.message}`);
    }
  }
}

testNotification();
