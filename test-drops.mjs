import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function checkDrops() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;

  // 1. Check recent drops
  const res = await fetch(`${BASE}/drops`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  
  if (res.ok) {
    const data = await res.json();
    const drops = data.documents || [];
    console.log(`Found ${drops.length} total drops.`);
    drops.slice(-3).forEach(drop => {
      console.log(`Drop ID: ${drop.name.split('/').pop()}`);
      console.log(`Author: ${drop.fields?.authorUid?.stringValue}`);
      const recipients = drop.fields?.recipientUids?.arrayValue?.values || [];
      console.log(`Recipients count: ${recipients.length}`);
      console.log("---");
    });
  }

  // 2. Check active users in presence
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const queryRes = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "presence" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "lastSeen" },
              op: "GREATER_THAN",
              value: { timestampValue: cutoff },
            },
          },
        },
      }),
    }
  );

  if (queryRes.ok) {
    const queryData = await queryRes.json();
    const activeCount = Array.isArray(queryData)
      ? queryData.filter((r) => r.document).length
      : 0;
    console.log(`\nActive users in presence (last 2 mins): ${activeCount}`);
  } else {
    console.error("Failed to query presence:", await queryRes.text());
  }
}

checkDrops().catch(console.error);
