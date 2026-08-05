const { getAdminToken, firestoreBase } = require("./app/api/_lib/adminToken.js");

// We need to polyfill fetch and Web Crypto if we are just running this in Node.js
// Wait, Node.js 18+ has fetch. WebCrypto is in globalThis.crypto.
async function checkDrops() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();

  const res = await fetch(`${BASE}/drops`, {
    headers: { Authorization: `Bearer ${adminToken}` }
  });
  
  if (!res.ok) {
    console.error("Failed to fetch drops:", await res.text());
    return;
  }
  const data = await res.json();
  const drops = data.documents || [];
  
  console.log(`Found ${drops.length} drops.`);
  drops.slice(-3).forEach(drop => {
    console.log(`Drop ID: ${drop.name.split('/').pop()}`);
    console.log(`Author: ${drop.fields?.authorUid?.stringValue}`);
    
    const recipients = drop.fields?.recipientUids?.arrayValue?.values || [];
    console.log(`Recipients count: ${recipients.length}`);
    console.log(`Recipients:`, recipients.map(r => r.stringValue));
    console.log("---");
  });
}

checkDrops().catch(console.error);
