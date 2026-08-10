import 'dotenv/config';
import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function testPresence() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();
  
  const res = await fetch(`${BASE}/presence`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  
  if (!res.ok) {
    console.error("Failed to fetch presence", await res.text());
    return;
  }
  
  const data = await res.json();
  const docs = data.documents || [];
  const now = Date.now();
  
  for (const doc of docs) {
    const uid = doc.name.split("/").pop();
    const lastSeenStr = doc.fields?.lastSeen?.timestampValue;
    const lastSeen = lastSeenStr ? new Date(lastSeenStr).getTime() : 0;
    const isActive = (now - lastSeen) < 120000; // 2 mins
    console.log(`User ${uid}: lastSeen=${lastSeenStr} (Active: ${isActive})`);
  }
}

testPresence();
