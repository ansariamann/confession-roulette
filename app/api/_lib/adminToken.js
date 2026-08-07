// ─── Firebase Admin Token Helper ──────────────────────────────────────────────
// Mints a short-lived Google OAuth2 access token from a Firebase service account
// JSON stored as the FIREBASE_SERVICE_ACCOUNT_JSON env var.
//
// This replaces the insecure "sign in as bot@confessionroulette.com" pattern.
// Works inside Cloudflare Workers (pure fetch + Web Crypto, no firebase-admin SDK).
//
// Usage:
//   import { getAdminToken, firestoreBase } from "../_lib/adminToken";
//   const token = await getAdminToken();
//   const BASE = firestoreBase();
// ─────────────────────────────────────────────────────────────────────────────

let cachedToken = null;
let cachedTokenExpiry = 0;

function b64urlEncode(bytes) {
  const b64 = btoa(String.fromCharCode(...bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function createServiceAccountJWT(serviceAccount) {
  const now = Math.floor(Date.now() / 1000);
  const exp = now + 3600;

  const header = b64urlEncode(
    new TextEncoder().encode(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  );

  const payload = b64urlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        iss: serviceAccount.client_email,
        scope:
          "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/firebase https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp,
      })
    )
  );

  const signingInput = `${header}.${payload}`;

  const pemBody = serviceAccount.private_key
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");

  const keyBytes = Uint8Array.from(atob(pemBody), (c) => c.charCodeAt(0));

  const cryptoKey = await crypto.subtle.importKey(
    "pkcs8",
    keyBytes,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const signatureBytes = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    cryptoKey,
    new TextEncoder().encode(signingInput)
  );

  const signature = b64urlEncode(new Uint8Array(signatureBytes));
  return `${signingInput}.${signature}`;
}

/**
 * Get a valid Google OAuth2 access token for Firestore REST API calls.
 * Caches the token for 55 minutes (tokens are valid 1 hour).
 *
 * Requires env var: FIREBASE_SERVICE_ACCOUNT_JSON
 *   The full service account JSON string (NOT base64-encoded).
 */
export async function getAdminToken() {
  const now = Date.now();

  if (cachedToken && now < cachedTokenExpiry) {
    return cachedToken;
  }

  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccountJson) {
    throw new Error(
      "FIREBASE_SERVICE_ACCOUNT_JSON env var is not set. " +
        "Copy the contents of server/serviceAccountKey.json into this env var."
    );
  }

  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.");
  }

  const jwt = await createServiceAccountJWT(serviceAccount);

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
  });

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    throw new Error(`Failed to obtain admin token: ${err}`);
  }

  const tokenData = await tokenRes.json();
  cachedToken = tokenData.access_token;
  cachedTokenExpiry = now + 55 * 60 * 1000; // 55-minute cache

  return cachedToken;
}

/**
 * Verify a Firebase ID token via the REST accounts:lookup endpoint.
 * Returns the authenticated UID, or throws on failure.
 */
export async function verifyIdToken(idToken) {
  const apiKey = process.env.VITE_FIREBASE_API_KEY;
  if (!apiKey) throw new Error("VITE_FIREBASE_API_KEY not set.");

  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    }
  );

  const data = await res.json();
  if (!res.ok || !data.users?.[0]?.localId) {
    throw new Error("Invalid or expired ID token.");
  }

  return data.users[0].localId;
}

/**
 * Build the Firestore REST base URL for this project.
 */
export function firestoreBase() {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  if (!projectId) throw new Error("VITE_FIREBASE_PROJECT_ID not set.");
  return `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
}
