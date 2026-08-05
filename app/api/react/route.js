// ─── POST /api/react — Submit a reaction ──────────────────────────────────────
// GET  /api/react — Get current reaction counts (used as fallback only)
//
// Reactions are stored in Firestore sub-documents: drops/{dropId}/reactions/{emoji}
// Deduplication is enforced via drops/{dropId}/voters/{uid}.
//
// Clients should subscribe via Firestore onSnapshot for real-time updates.
// This GET endpoint exists only as a fallback.
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { getAdminToken, verifyIdToken, firestoreBase } from "../_lib/adminToken";

const EMOJIS = new Set(["😂", "💀", "😬", "❤️", "😳"]);

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const dropId = searchParams.get("dropId");
  if (!dropId) {
    return NextResponse.json({ error: "Missing dropId" }, { status: 400 });
  }

  try {
    const adminToken = await getAdminToken();
    const BASE = firestoreBase();
    const headers = { Authorization: `Bearer ${adminToken}` };

    const res = await fetch(`${BASE}/drops/${dropId}/reactions`, { headers });
    if (!res.ok) {
      return NextResponse.json({ reactions: {} });
    }

    const data = await res.json();
    const reactions = {};
    for (const doc of data.documents || []) {
      const emoji = doc.name.split("/").pop();
      reactions[emoji] = parseInt(doc.fields?.count?.integerValue ?? "0", 10);
    }

    return NextResponse.json({ reactions });
  } catch (error) {
    console.error("GET /api/react error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    // ── 1. Auth ────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;

    let uid = "anon";
    if (idToken) {
      try {
        uid = await verifyIdToken(idToken);
      } catch {
        return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
      }
    }

    const { dropId, emoji } = await req.json();

    if (!dropId || !emoji) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    if (!EMOJIS.has(emoji)) {
      return NextResponse.json({ error: "Invalid emoji" }, { status: 400 });
    }

    const adminToken = await getAdminToken();
    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const BASE = firestoreBase();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    // ── 2. Dedup check — has this user already voted on this drop? ──────────
    const voterRes = await fetch(`${BASE}/drops/${dropId}/voters/${uid}`, {
      headers,
    });

    if (voterRes.ok && (await voterRes.json()).fields) {
      // Document exists → already voted
      return NextResponse.json({ error: "Already reacted" }, { status: 429 });
    }

    // ── 3. Atomically: create voter doc + increment reaction count ──────────
    // Using Firestore batch commit for atomicity.
    const now = new Date().toISOString();
    await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          writes: [
            // Create voter doc (prevents double-voting)
            {
              update: {
                name: `projects/${projectId}/databases/(default)/documents/drops/${dropId}/voters/${uid}`,
                fields: {
                  emoji: { stringValue: emoji },
                  votedAt: { timestampValue: now },
                },
              },
            },
            // Increment the emoji reaction count
            {
              transform: {
                document: `projects/${projectId}/databases/(default)/documents/drops/${dropId}/reactions/${emoji}`,
                fieldTransforms: [
                  {
                    fieldPath: "count",
                    increment: { integerValue: 1 },
                  },
                ],
              },
            },
          ],
        }),
      }
    );

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("POST /api/react error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
