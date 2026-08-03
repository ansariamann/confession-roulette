const fs = require('fs');
require('dotenv').config({ path: '.env.local' });
require('dotenv').config();

async function run() {
  const pid = process.env.VITE_FIREBASE_PROJECT_ID;
  const key = process.env.VITE_FIREBASE_API_KEY;

  const botAuthRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "bot@confessionroulette.com",
        password: "super_secret_bot_password",
        returnSecureToken: true,
      }),
    }
  );
  const botAuthData = await botAuthRes.json();
  const botToken = botAuthData.idToken;

  const BASE = `https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents`;
  
  // Try to list communities
  const commRes = await fetch(`${BASE}/communities`, {
    headers: { Authorization: `Bearer ${botToken}` }
  });
  const commData = await commRes.json();
  console.log(JSON.stringify(commData, null, 2));
}
run();
