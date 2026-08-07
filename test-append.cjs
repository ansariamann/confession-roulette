const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const accountJson = env.match(/FIREBASE_SERVICE_ACCOUNT_JSON='([^']+)'/)[1];
const account = JSON.parse(accountJson);
const crypto = require('crypto');

function b64urlEncode(bytes) { return Buffer.from(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

async function getAdminToken() {
  const now = Math.floor(Date.now() / 1000);
  const jwt = `${b64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64urlEncode(JSON.stringify({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }))}`;
  const sign = crypto.createSign('RSA-SHA256'); sign.update(jwt);
  const signature = b64urlEncode(sign.sign(account.private_key));
  const res = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${jwt}.${signature}` }) });
  return (await res.json()).access_token;
}

(async () => {
  const token = await getAdminToken();
  const res = await fetch('https://firestore.googleapis.com/v1/projects/confession-roulette-a6b4b/databases/(default)/documents:commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      writes: [{
        transform: {
          document: 'projects/confession-roulette-a6b4b/databases/(default)/documents/users/2vM1xre4negsY4PgVgfUfmwkzkH2',
          fieldTransforms: [{ fieldPath: 'fcmTokens', appendMissingElements: { values: [{ stringValue: 'test-token-123' }] } }]
        }
      }]
    })
  });
  console.log('Commit Result:', await res.text());
})();
