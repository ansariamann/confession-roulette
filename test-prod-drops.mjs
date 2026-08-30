import 'dotenv/config';
import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function checkRecentDrops() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();

  const res = await fetch(`${BASE}/drops`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  
  if (!res.ok) {
    console.error("Failed to fetch drops:", await res.text());
    return;
  }

  const data = await res.json();
  const drops = (data.documents || [])
    .map(d => ({
      id: d.name.split("/").pop(),
      authorUid: d.fields.authorUid?.stringValue,
      text: d.fields.text?.stringValue,
      time: d.fields.broadcastStartedAt?.timestampValue,
      recipients: d.fields.recipientUids?.arrayValue?.values?.map(v => v.stringValue) || []
    }))
    .sort((a, b) => new Date(b.time) - new Date(a.time))
    .slice(0, 5); // last 5 drops

  console.log("LAST 5 DROPS IN PRODUCTION:");
  console.log(JSON.stringify(drops, null, 2));

  // Check active users right now
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
  const pRes = await fetch(`https://firestore.googleapis.com/v1/projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "presence" }],
        where: {
          fieldFilter: {
            field: { fieldPath: "lastSeen" },
            op: "GREATER_THAN",
            value: { timestampValue: cutoff }
          }
        }
      }
    })
  });
  
  const pData = await pRes.json();
  const activeUids = (Array.isArray(pData) ? pData : [])
    .filter(r => r.document)
    .map(r => r.document.name.split("/").pop());

  console.log(`\nCURRENT ACTIVE USERS (<2 mins): ${activeUids.length}`);
  console.log(activeUids);
}

checkRecentDrops();
