import { NextResponse } from "next/server";

/**
 * POST /api/community/join
 * Body: { communityName: string }
 * Auth: Bearer token (Firebase ID token)
 *
 * - Verifies the token via Firebase REST API
 * - Normalises communityName (trim, max 40 chars)
 * - Upserts the community doc in Firestore
 * - Updates users/{uid}.communityId
 * - Returns { communityId, memberCount, activeCount }
 */
export async function POST(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const apiKey    = process.env.VITE_FIREBASE_API_KEY;
    if (!projectId || !apiKey) {
      return NextResponse.json({ error: "Server misconfiguration" }, { status: 500 });
    }

    // ── 1. Verify ID token via Firebase Auth REST ──────────────────────────
    const verifyRes = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken }),
      },
    );
    const verifyData = await verifyRes.json();
    if (!verifyRes.ok || !verifyData.users?.[0]?.localId) {
      return NextResponse.json({ error: "Invalid token" }, { status: 401 });
    }
    const uid = verifyData.users[0].localId;

    // ── 2. Parse + validate body ────────────────────────────────────────────
    const body = await req.json();
    const rawName = (body.communityName || "").trim().slice(0, 40);
    if (rawName.length < 2) {
      return NextResponse.json({ error: "Community name must be at least 2 characters" }, { status: 400 });
    }
    const communityId   = rawName;
    const communityNameLower = rawName.toLowerCase();

    // ── 3. Bot auth for Firestore REST ──────────────────────────────────────
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
      },
    );
    const botAuthData = await botAuthRes.json();
    if (!botAuthRes.ok || !botAuthData.idToken) {
      console.error("Bot auth failed:", botAuthData);
      return NextResponse.json({ error: "Internal auth error" }, { status: 500 });
    }
    const botToken = botAuthData.idToken;
    const BASE = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents`;
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${botToken}`,
    };

    // ── 4. Upsert community doc ─────────────────────────────────────────────
    // Read existing doc first so we can increment memberCount correctly
    const commDocRes = await fetch(`${BASE}/communities/${communityId}`, { headers });
    let currentMemberCount = 0;

    if (commDocRes.ok) {
      const commDoc = await commDocRes.json();
      currentMemberCount = commDoc.fields?.memberCount?.integerValue
        ? parseInt(commDoc.fields.memberCount.integerValue, 10)
        : 0;
    }

    // Read current user doc to see if they're changing communities
    const userDocRes = await fetch(`${BASE}/users/${uid}`, { headers });
    let previousCommunityId = null;
    if (userDocRes.ok) {
      const userDoc = await userDocRes.json();
      previousCommunityId = userDoc.fields?.communityId?.stringValue || null;
    }

    // If switching, we need to decrement old community's count
    if (previousCommunityId && previousCommunityId !== communityId) {
      const oldCommRes = await fetch(`${BASE}/communities/${previousCommunityId}`, { headers });
      if (oldCommRes.ok) {
        const oldComm = await oldCommRes.json();
        const oldCount = oldComm.fields?.memberCount?.integerValue
          ? parseInt(oldComm.fields.memberCount.integerValue, 10)
          : 1;
        await fetch(`${BASE}/communities/${previousCommunityId}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            fields: {
              memberCount: { integerValue: Math.max(0, oldCount - 1) },
            },
          }),
        });
      }
    }

    const isNewMember = previousCommunityId !== communityId;
    const newMemberCount = isNewMember ? currentMemberCount + 1 : currentMemberCount;

    // Upsert community doc
    await fetch(`${BASE}/communities/${communityId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fields: {
          name:        { stringValue: communityId },
          nameLower:   { stringValue: communityNameLower },
          memberCount: { integerValue: newMemberCount },
          createdAt:   { timestampValue: new Date().toISOString() },
        },
      }),
    });

    // ── 5. Update user doc ─────────────────────────────────────────────────
    await fetch(`${BASE}/users/${uid}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fields: {
          communityId: { stringValue: communityId },
        },
      }),
    });

    // ── 6. Count active users in community (presence in last 2 min) ────────
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const presenceRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "presence" }],
            where: {
              compositeFilter: {
                op: "AND",
                filters: [
                  {
                    fieldFilter: {
                      field: { fieldPath: "lastSeen" },
                      op: "GREATER_THAN",
                      value: { timestampValue: cutoff },
                    },
                  },
                  {
                    fieldFilter: {
                      field: { fieldPath: "communityId" },
                      op: "EQUAL",
                      value: { stringValue: communityId },
                    },
                  },
                ],
              },
            },
            limit: 500,
          },
        }),
      },
    );
    const presenceData = await presenceRes.json();
    const activeCount = Array.isArray(presenceData)
      ? presenceData.filter((r) => r.document).length
      : 0;

    return NextResponse.json({
      communityId,
      memberCount: newMemberCount,
      activeCount,
    });
  } catch (err) {
    console.error("Community join error:", err);
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
