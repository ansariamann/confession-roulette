import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function checkPresence() {
  const adminToken = await getAdminToken();
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;

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

  const data = await queryRes.json();
  data.forEach(d => {
    if (d.document) {
      console.log(`User: ${d.document.name.split('/').pop()}`);
      console.log(`Community: ${d.document.fields.communityId?.stringValue}`);
      console.log(`LastSeen: ${d.document.fields.lastSeen?.timestampValue}`);
    }
  });
}

checkPresence().catch(console.error);
