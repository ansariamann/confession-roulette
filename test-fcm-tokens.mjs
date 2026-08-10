import 'dotenv/config';
import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function testFCM() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();
  
  const res = await fetch(`${BASE}/users`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  
  if (!res.ok) {
    console.error("Failed to fetch users", await res.text());
    return;
  }
  
  const data = await res.json();
  const users = data.documents || [];
  
  for (const doc of users) {
    const uid = doc.name.split("/").pop();
    const tokens = doc.fields?.fcmTokens?.arrayValue?.values?.map(v => v.stringValue) || [];
    console.log(`User ${uid}:`, tokens);
  }
}

testFCM();
