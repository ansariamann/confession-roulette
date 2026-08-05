// ─── POST /api/report ─────────────────────────────────────────────────────────
// Handles user reports submitted during live drops.
// 1. Verifies the reporter's ID token
// 2. Logs to moderationLog (hashed/truncated — never full plaintext)
// 3. Increments reportCount on the author's user doc
// 4. Freezes the account if reportCount crosses the threshold
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { getAdminToken, verifyIdToken, firestoreBase } from "../_lib/adminToken";

const FREEZE_THRESHOLD = 5;

/**
 * SHA-256 hash of text (for moderationLog — never store full plaintext).
 */
async function hashText(text) {
  const bytes = new TextEncoder().encode(text);
  const hashBuffer = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hashBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function truncateText(text) {
  if (!text || text.length <= 20) return text || "";
  return text.slice(0, 20) + "…";
}

export async function POST(req) {
  try {
    // ── 1. Auth ────────────────────────────────────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let reporterUid;
    try {
      reporterUid = await verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { dropId } = await req.json();
    if (!dropId) {
      return NextResponse.json({ error: "Missing dropId" }, { status: 400 });
    }

    const adminToken = await getAdminToken();
    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const BASE = firestoreBase();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    // ── 2. Fetch drop to get text and authorUid ────────────────────────────
    let confessionText = "[text unavailable]";
    let authorUid = null;

    const dropRes = await fetch(`${BASE}/drops/${dropId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (dropRes.ok) {
      const dropDoc = await dropRes.json();
      confessionText = dropDoc.fields?.text?.stringValue || confessionText;
      authorUid = dropDoc.fields?.authorUid?.stringValue || null;
    }

    // ── 3. Write moderationLog entry (hashed/truncated — never full plaintext) ─
    const textHash = await hashText(confessionText);
    const textPreview = truncateText(confessionText);

    await fetch(`${BASE}/moderationLog`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        fields: {
          dropId: { stringValue: dropId },
          reason: { stringValue: "user-reported" },
          description: { stringValue: "Reported by user during live drop" },
          textHash: { stringValue: textHash },
          textPreview: { stringValue: textPreview },
          reporterUid: { stringValue: reporterUid },
          priority: { stringValue: "NORMAL" },
          timestamp: { timestampValue: new Date().toISOString() },
        },
      }),
    });

    // ── 4. Increment reportCount + check freeze threshold ──────────────────
    if (authorUid) {
      // Atomic increment via Firestore field transform
      await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            writes: [
              {
                transform: {
                  document: `projects/${projectId}/databases/(default)/documents/users/${authorUid}`,
                  fieldTransforms: [
                    {
                      fieldPath: "reportCount",
                      increment: { integerValue: 1 },
                    },
                  ],
                },
              },
            ],
          }),
        }
      );

      // Read updated reportCount
      const updatedUserRes = await fetch(`${BASE}/users/${authorUid}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });

      if (updatedUserRes.ok) {
        const updatedUser = await updatedUserRes.json();
        const reportCount = parseInt(
          updatedUser.fields?.reportCount?.integerValue ?? "0",
          10
        );

        if (reportCount >= FREEZE_THRESHOLD) {
          await fetch(
            `${BASE}/users/${authorUid}?updateMask.fieldPaths=isFrozen`,
            {
              method: "PATCH",
              headers,
              body: JSON.stringify({
                fields: { isFrozen: { booleanValue: true } },
              }),
            }
          );
          console.log(
            `🧊 User ${authorUid} frozen (reportCount: ${reportCount} >= ${FREEZE_THRESHOLD})`
          );
        }
      }
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Report error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
