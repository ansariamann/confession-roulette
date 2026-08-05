require('dotenv').config({ path: './server/.env.example' });
const fs = require('fs');

async function test() {
  const apiKey = 'AIzaSyCn1M6nfNHC1hdky-egJVN6dFYo6xkxKRo';
  const projectId = 'confession-roulette-a6b4b';

  // Bot auth
  const botAuthRes = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
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

  const res = await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/users`,
    {
      headers: { Authorization: `Bearer ${botToken}` }
    }
  );
  const data = await res.json();
  console.log(JSON.stringify(data, null, 2));
}

test().catch(console.error);
