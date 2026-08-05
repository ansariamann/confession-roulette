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

  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const rateLimitRes = await fetch(`https://firestore.googleapis.com/v1/projects/${pid}/databases/(default)/documents:runQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${botToken}` },
    body: JSON.stringify({
      structuredQuery: {
        from: [{ collectionId: "drops" }],
        where: {
          compositeFilter: {
            op: "AND",
            filters: [
              {
                fieldFilter: {
                  field: { fieldPath: "authorUid" },
                  op: "EQUAL",
                  value: { stringValue: "test-uid" }
                }
              },
              {
                fieldFilter: {
                  field: { fieldPath: "broadcastStartedAt" },
                  op: "GREATER_THAN",
                  value: { timestampValue: oneMinuteAgo }
                }
              }
            ]
          }
        },
        limit: 3
      }
    })
  });
  console.log(JSON.stringify(await rateLimitRes.json(), null, 2));
}
run();
