// ─── POST /api/confess ────────────────────────────────────────────────────────
// Handles the full confession submission flow:
//  1. Auth verification (user's own Firebase ID token)
//  2. PII + NLP moderation (BLOCKING — drop never created if this fails)
//  3. Frozen account check
//  4. Rate limit check (max 3 confessions / 5 minutes)
//  5. Scale-safe audience selection via sortKey pivot sampling
//  6. Drop document creation in Firestore
//  7. Reaction sub-doc seeding (Firestore, not Redis)
//  8. Expiry scheduling via QStash (T+60s → /api/expire)
// ─────────────────────────────────────────────────────────────────────────────

import { NextResponse } from "next/server";
import { getAdminToken, verifyIdToken, firestoreBase } from "../_lib/adminToken";
import { moderateText } from "../_lib/moderation";

const DROP_DURATION_S = 60;
const DROP_RECIPIENT_COUNT = 100;
const RATE_LIMIT_WINDOW_MS = 5 * 60_000; // 5 minutes
const RATE_LIMIT_MAX = 3;
const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];

/**
 * Scale-safe audience selection using sortKey pivot sampling.
 *
 * Each presence doc has a random float sortKey in [0, 1) written at heartbeat time.
 * We generate a random pivot and query two ranges to wrap around the circle.
 * This gives a uniform random sample from any size pool in exactly 2 Firestore queries,
 * each returning at most `count` documents.
 *
 * Scales to millions of users with no in-memory shuffle.
 */
async function selectRecipients(communityId, authorUid, count, adminToken) {
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  const BASE_QUERY = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${adminToken}`,
  };

  const pivot = Math.random();
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();

  // Build the Firestore community filter — if no communityId, query all active users
  const communityFilter = communityId
    ? {
        fieldFilter: {
          field: { fieldPath: "communityId" },
          op: "EQUAL",
          value: { stringValue: communityId },
        },
      }
    : null;

  const activeFilter = {
    fieldFilter: {
      field: { fieldPath: "lastSeen" },
      op: "GREATER_THAN",
      value: { timestampValue: cutoff },
    },
  };

  function buildQuery(pivotValue, op, remaining) {
    const filters = [
      activeFilter,
      {
        fieldFilter: {
          field: { fieldPath: "sortKey" },
          op,
          value: { doubleValue: pivotValue },
        },
      },
    ];
    if (communityFilter) filters.push(communityFilter);

    return {
      structuredQuery: {
        from: [{ collectionId: "presence" }],
        where: { compositeFilter: { op: "AND", filters } },
        orderBy: [{ field: { fieldPath: "sortKey" }, direction: op === "GREATER_THAN_OR_EQUAL" ? "ASCENDING" : "ASCENDING" }],
        limit: remaining,
      },
    };
  }

  const extractUids = (rows) =>
    (Array.isArray(rows) ? rows : [])
      .filter((r) => r.document)
      .map((r) => r.document.name.split("/").pop())
      .filter((uid) => uid !== authorUid);

  // First pass: sortKey >= pivot (ascending)
  const res1 = await fetch(BASE_QUERY, {
    method: "POST",
    headers,
    body: JSON.stringify(buildQuery(pivot, "GREATER_THAN_OR_EQUAL", count)),
  });
  const data1 = await res1.json();
  const firstBatch = extractUids(data1);

  let recipients = firstBatch;

  // Wrap-around: if we didn't get enough, query from the beginning [0, pivot)
  if (recipients.length < count) {
    const remaining = count - recipients.length;
    const res2 = await fetch(BASE_QUERY, {
      method: "POST",
      headers,
      body: JSON.stringify(buildQuery(pivot, "LESS_THAN", remaining)),
    });
    const data2 = await res2.json();
    recipients = [...recipients, ...extractUids(data2)];
  }

  // Deduplicate (shouldn't happen, but be safe)
  return [...new Set(recipients)].slice(0, count);
}

/**
 * Fetch FCM tokens for recipients via batchGet and send push notifications.
 * Runs asynchronously and doesn't block the drop.
 */
async function sendDropNotifications(recipientUids, dropId, adminToken, projectId) {
  if (!recipientUids || recipientUids.length === 0) return;
  
  try {
    const BASE_URL = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const documents = recipientUids.map(uid => `projects/${projectId}/databases/(default)/documents/users/${uid}`);
    
    const batchRes = await fetch(`${BASE_URL}:batchGet`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({ documents })
    });
    
    if (!batchRes.ok) return;

    const data = await batchRes.json();
    const tokens = [];
    if (Array.isArray(data)) {
      for (const item of data) {
        if (item.found?.fields?.fcmTokens?.arrayValue?.values) {
          const vals = item.found.fields.fcmTokens.arrayValue.values;
          vals.forEach(v => {
            if (v.stringValue) tokens.push(v.stringValue);
          });
        }
      }
    }

    if (tokens.length === 0) return;

    const fcmUrl = `https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`;
    
    const FOMO_TITLES = [
      "👀 Someone just confessed...",
      "🔥 A wild secret just dropped!",
      "🤫 Someone spilled the tea.",
      "⚠️ 10-second confession LIVE now."
    ];
    const FOMO_BODIES = [
      "Tap fast! It deletes itself in exactly 10 seconds.",
      "You are one of the 100 randomly chosen to see this. Hurry!",
      "Are you fast enough? It vanishes forever in 10s.",
      "100 people are reading this right now. Don't miss it!"
    ];

    // Fire and forget
    tokens.forEach(async (token) => {
      const title = FOMO_TITLES[Math.floor(Math.random() * FOMO_TITLES.length)];
      const body = FOMO_BODIES[Math.floor(Math.random() * FOMO_BODIES.length)];

      try {
        const sendRes = await fetch(fcmUrl, {
          method: "POST",
          headers: {
             "Content-Type": "application/json",
             Authorization: `Bearer ${adminToken}`,
          },
          body: JSON.stringify({
            message: {
              token,
              notification: {
                title,
                body
              },
              data: {
                dropId,
                url: "/live"
              }
            }
          })
        });
        
        if (!sendRes.ok) {
           const err = await sendRes.json();
           if (err?.error?.details?.[0]?.errorCode === 'UNREGISTERED') {
             console.warn(`Token stale/unregistered: ${token}`);
             // Ideally we remove the token here, but skipping for brevity
           }
        }
      } catch (err) {
        console.error("FCM send error:", err);
      }
    });

  } catch (error) {
    console.error("Error sending drop notifications:", error);
  }
}

export async function POST(req) {
  try {
    // ── 1. Auth — verify the user's own token ──────────────────────────────
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    let uid;
    try {
      uid = await verifyIdToken(idToken);
    } catch {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { text, communityId } = await req.json();
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      return NextResponse.json({ error: "Missing confession text" }, { status: 400 });
    }

    const trimmedText = text.trim();
    if (trimmedText.length > 280) {
      return NextResponse.json({ error: "Confession too long (max 280 characters)" }, { status: 400 });
    }

    // ── 2. Moderation gate (BLOCKING — must pass before any drop is created) ──
    const modResult = await moderateText(trimmedText, false /* isSpicier */);

    if (!modResult.passed) {
      // Special case: self-harm content — don't silently reject, signal the client
      // so it can show crisis resources instead of a generic error.
      if (modResult.selfHarm) {
        return NextResponse.json(
          {
            error: "SELF_HARM",
            message:
              "It sounds like you might be going through something really hard. " +
              "Please reach out for support.",
            crisisLine: "https://988lifeline.org",
          },
          { status: 422 }
        );
      }

      return NextResponse.json(
        { error: "Content did not pass safety check", reason: modResult.reason },
        { status: 403 }
      );
    }

    // ── 3. Get admin token for all subsequent Firestore operations ──────────
    const adminToken = await getAdminToken();
    const BASE = firestoreBase();
    const adminHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };

    // ── 4. Frozen account check ────────────────────────────────────────────
    const userRes = await fetch(`${BASE}/users/${uid}`, { headers: adminHeaders });
    if (userRes.ok) {
      const userDoc = await userRes.json();
      if (userDoc.fields?.isFrozen?.booleanValue === true) {
        return NextResponse.json(
          { error: "Your account is frozen due to multiple reports." },
          { status: 403 }
        );
      }
    }

    // ── 5. Rate limit check (max 3 per 5 minutes) ─────────────────────────
    const windowStart = new Date(Date.now() - RATE_LIMIT_WINDOW_MS).toISOString();
    const rateLimitRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers: adminHeaders,
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
                      value: { stringValue: uid },
                    },
                  },
                  {
                    fieldFilter: {
                      field: { fieldPath: "broadcastStartedAt" },
                      op: "GREATER_THAN",
                      value: { timestampValue: windowStart },
                    },
                  },
                ],
              },
            },
            limit: RATE_LIMIT_MAX,
          },
        }),
      }
    );

    if (rateLimitRes.ok) {
      const rateLimitData = await rateLimitRes.json();
      const recentCount = Array.isArray(rateLimitData)
        ? rateLimitData.filter((r) => r.document).length
        : 0;
      if (recentCount >= RATE_LIMIT_MAX) {
        return NextResponse.json(
          { error: "Rate limit exceeded. Max 3 confessions per 5 minutes." },
          { status: 429 }
        );
      }
    }

    // ── 6. Update presence heartbeat + sortKey ─────────────────────────────
    // sortKey is a random float used for scale-safe pivot sampling.
    await fetch(
      `${BASE}/presence/${uid}?updateMask.fieldPaths=lastSeen&updateMask.fieldPaths=communityId&updateMask.fieldPaths=sortKey`,
      {
        method: "PATCH",
        headers: adminHeaders,
        body: JSON.stringify({
          fields: {
            lastSeen: { timestampValue: new Date().toISOString() },
            ...(communityId ? { communityId: { stringValue: communityId } } : {}),
            sortKey: { doubleValue: Math.random() },
          },
        }),
      }
    );

    // ── 7. Scale-safe audience selection ───────────────────────────────────
    const recipients = await selectRecipients(
      communityId || null,
      uid,
      DROP_RECIPIENT_COUNT,
      adminToken
    );

    if (recipients.length === 0) {
      // No active users — still create the drop but with empty recipient list
      // The author can see their own confession via the verdict screen.
      console.log(`No active recipients for community "${communityId}" — proceeding with empty audience.`);
    }

    // ── 8. Create the drop document ────────────────────────────────────────
    const dropRes = await fetch(`${BASE}/drops`, {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({
        fields: {
          authorUid: { stringValue: uid },
          text: { stringValue: trimmedText },
          communityId: { stringValue: communityId || "global" },
          recipientUids: {
            arrayValue: { values: recipients.map((r) => ({ stringValue: r })) },
          },
          recipientCount: { integerValue: recipients.length },
          status: { stringValue: "broadcasting" },
          broadcastStartedAt: { timestampValue: new Date().toISOString() },
        },
      }),
    });

    if (!dropRes.ok) {
      const err = await dropRes.json();
      console.error("Failed to create drop:", err);
      return NextResponse.json({ error: "Failed to create drop" }, { status: 500 });
    }

    const dropData = await dropRes.json();
    const dropId = dropData.name.split("/").pop();

    // ── 9. Seed reaction sub-documents in Firestore ────────────────────────
    // Using commit (batch write) for atomicity
    const reactionWrites = EMOJIS.map((emoji) => ({
      update: {
        name: `projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents/drops/${dropId}/reactions/${emoji}`,
        fields: { count: { integerValue: 0 } },
      },
    }));

    await fetch(
      `https://firestore.googleapis.com/v1/projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents:commit`,
      {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ writes: reactionWrites }),
      }
    );

    // ── 9.5 Send FCM Notifications ─────────────────────────────────────────
    if (recipients.length > 0) {
      sendDropNotifications(recipients, dropId, adminToken, process.env.VITE_FIREBASE_PROJECT_ID).catch(err => {
         console.error("Non-fatal error sending notifications:", err);
      });
    }

    // ── 10. Schedule expiry via QStash (T+60s → /api/expire) ───────────────
    const baseUrl =
      process.env.NEXT_PUBLIC_SITE_URL ||
      "https://confession-roulette.iamamanansari786a.workers.dev";
    const qstashToken = process.env.QSTASH_TOKEN || "";

    if (qstashToken) {
      await fetch(`https://qstash.upstash.io/v2/publish/${baseUrl}/api/expire`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${qstashToken}`,
          "Content-Type": "application/json",
          "Upstash-Delay": `${DROP_DURATION_S}s`,
          // Idempotency key prevents duplicate expiry if QStash retries
          "Upstash-Deduplication-Id": `expire-${dropId}`,
        },
        body: JSON.stringify({ dropId, authorUid: uid, text: trimmedText }),
      });
    } else {
      console.warn("QSTASH_TOKEN not set — expiry will not be scheduled.");
    }

    return NextResponse.json({ success: true, dropId });
  } catch (error) {
    console.error("FATAL ERROR in /api/confess:", error);
    return NextResponse.json(
      { error: error.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
