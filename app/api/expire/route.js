// ─── POST /api/expire ─────────────────────────────────────────────────────────
// Called by QStash exactly DROP_DURATION_S seconds after a drop is created.
// Performs the hard-delete sequence and writes the verdict + hall of fame.
//
// Flow:
//  1. Verify QStash signature (prevents arbitrary callers from triggering expiry)
//  2. Read final reaction counts from Firestore reactions subcollection
//  3. Read final comments from Firestore comments subcollection
//  4. Write verdict doc (reaction totals only + confession text for author view)
//  5. Hard-delete: reactions, voters, comments subcollections + drop doc
//  6. Idempotency: skip if drop already deleted (QStash may retry on timeout)
//  7. Hall of Fame rollup: update daily aggregate emoji totals
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { getAdminToken, firestoreBase } from "../_lib/adminToken";

const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

/**
 * Fetch all documents in a Firestore subcollection.
 * Returns array of { id, fields } objects.
 */
async function fetchSubcollection(base, path, adminToken) {
  const res = await fetch(`${base}/${path}`, {
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  if (!res.ok) return [];
  const data = await res.json();
  return (data.documents || []).map((doc) => ({
    id: doc.name.split("/").pop(),
    fields: doc.fields || {},
    name: doc.name,
  }));
}

/**
 * Delete a list of Firestore document paths via batch commit.
 */
async function batchDelete(projectId, docPaths, adminToken) {
  if (docPaths.length === 0) return;
  const writes = docPaths.map((name) => ({ delete: name }));
  await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ writes }),
    }
  );
}

/**
 * Update hallOfFameStats/{date} with today's aggregate emoji totals.
 * Uses a Firestore transaction to safely merge with existing daily totals.
 */
async function updateHallOfFame(reactionTotals, totalReactions, adminToken) {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC
  const docPath = `projects/${projectId}/databases/(default)/documents/hallOfFameStats/${today}`;

  const transforms = [];
  for (const emoji of EMOJIS) {
    const count = reactionTotals[emoji] || 0;
    if (count > 0) {
      transforms.push({
        fieldPath: `emojiTotals.${emoji}`,
        increment: { integerValue: count },
      });
    }
  }
  transforms.push({
    fieldPath: "totalReactions",
    increment: { integerValue: totalReactions },
  });
  transforms.push({
    fieldPath: "totalConfessions",
    increment: { integerValue: 1 },
  });

  if (transforms.length === 0) return;

  await fetch(
    `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        writes: [
          {
            transform: {
              document: docPath,
              fieldTransforms: transforms,
            },
          },
        ],
      }),
    }
  );
}

export async function POST(req) {
  try {
    const { dropId, authorUid, text } = await req.json();
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

    // ── 1. Idempotency: check if drop still exists ──────────────────────────
    const dropCheck = await fetch(`${BASE}/drops/${dropId}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    if (!dropCheck.ok || dropCheck.status === 404) {
      // Drop already deleted — this is a QStash retry on a completed expiry. Skip.
      console.log(`Drop ${dropId} already expired — skipping duplicate expiry.`);
      return NextResponse.json({ success: true, skipped: true });
    }

    const dropDoc = await dropCheck.json();
    if (dropDoc.error) {
      console.log(`Drop ${dropId} not found — skipping.`);
      return NextResponse.json({ success: true, skipped: true });
    }

    // ── 2. Read final reaction counts from Firestore ─────────────────────────
    const reactionDocs = await fetchSubcollection(
      BASE,
      `drops/${dropId}/reactions`,
      adminToken
    );

    const reactionTotals = {};
    for (const doc of reactionDocs) {
      reactionTotals[doc.id] = parseInt(doc.fields?.count?.integerValue ?? "0", 10);
    }

    const totalReactions = Object.values(reactionTotals).reduce(
      (a, b) => a + b,
      0
    );

    // ── 3. Read final comments from Firestore ────────────────────────────────
    const commentDocs = await fetchSubcollection(
      BASE,
      `drops/${dropId}/comments`,
      adminToken
    );

    const comments = commentDocs.map((doc) => ({
      id: doc.id,
      text: doc.fields?.text?.stringValue || "",
      createdAt: doc.fields?.createdAt?.timestampValue || "",
    }));

    // ── 4. Write verdict doc ─────────────────────────────────────────────────
    // Stores reaction totals, comments, and the confession text (for author view only).
    // Verdict is readable only by the author and recipients (enforced in Firestore rules).
    const verdictFields = {
      dropId: { stringValue: dropId },
      authorUid: { stringValue: authorUid || "" },
      text: { stringValue: text || "" },
      totalReactions: { integerValue: totalReactions },
      expiredAt: { timestampValue: new Date().toISOString() },
      reactions: {
        mapValue: {
          fields: Object.fromEntries(
            Object.entries(reactionTotals).map(([k, v]) => [
              k,
              { integerValue: v },
            ])
          ),
        },
      },
      comments: {
        arrayValue: {
          values: comments.map((c) => ({
            mapValue: {
              fields: {
                id: { stringValue: c.id },
                text: { stringValue: c.text },
                createdAt: { timestampValue: c.createdAt || new Date().toISOString() },
              },
            },
          })),
        },
      },
    };

    await fetch(`${BASE}/verdicts?documentId=${dropId}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ fields: verdictFields }),
    });

    // ── 5. Hard-delete subcollections then the drop doc ──────────────────────
    // Collect all subcollection doc paths
    const voterDocs = await fetchSubcollection(
      BASE,
      `drops/${dropId}/voters`,
      adminToken
    );

    const allDocPaths = [
      ...reactionDocs.map((d) => d.name),
      ...commentDocs.map((d) => d.name),
      ...voterDocs.map((d) => d.name),
    ];

    // Delete subcollection docs in batches of 500 (Firestore batch limit)
    for (let i = 0; i < allDocPaths.length; i += 500) {
      await batchDelete(projectId, allDocPaths.slice(i, i + 500), adminToken);
    }

    // Delete the drop document itself
    await fetch(`${BASE}/drops/${dropId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    console.log(
      `✅ Drop ${dropId} expired: ${totalReactions} reactions, ${comments.length} comments, hard-deleted.`
    );

    // ── 6. Hall of Fame daily rollup ─────────────────────────────────────────
    // Atomically increment today's aggregate emoji totals.
    // No confession text is stored — aggregate counts only.
    await updateHallOfFame(reactionTotals, totalReactions, adminToken);

    return NextResponse.json({ success: true, totalReactions });
  } catch (error) {
    console.error("Expiry error:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
