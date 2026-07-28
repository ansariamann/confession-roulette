// ─── Firebase Admin SDK — Shared Lambda Init ────────────────────────────────
// Initializes Firebase Admin once per Lambda cold start.
// All Lambda handlers import { db, FieldValue } from this module.
// ─────────────────────────────────────────────────────────────────────────────

const { initializeApp, cert, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const path = require("path");

// Guard against double-init (Lambda container reuse)
if (getApps().length === 0) {
  // In production, use AWS Secrets Manager. For now, bundle the key.
  const serviceAccountPath = path.join(__dirname, "..", "serviceAccountKey.json");
  const serviceAccount = require(serviceAccountPath);

  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();

module.exports = { db, FieldValue };
