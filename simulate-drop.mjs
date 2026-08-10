import 'dotenv/config';
import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function simulateDrop() {
  const adminToken = await getAdminToken();
  const BASE = firestoreBase();

  const dropId = "mock-drop-" + Date.now();
  
  const res = await fetch(`https://confession-roulette.iamamanansari786a.workers.dev/api/confess`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}` // Using admin token to bypass auth check in local dev
    },
    body: JSON.stringify({
      text: "This is a fake confession from another user to test notifications!",
      communityId: ""
    })
  });
  
  if (!res.ok) {
    console.error("Failed", await res.text());
  } else {
    console.log("Mock drop created successfully! Push notifications should be sent to active users.");
  }
}

simulateDrop();
