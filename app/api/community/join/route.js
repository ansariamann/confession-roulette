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
    let currentMemberCount = 0;
    let targetDocPath = `${BASE}/communities/${encodeURIComponent(communityId)}`;
    let targetCommunityName = rawName;
    let isExistingCommunity = false;

    // Find existing community by nameLower
    const queryRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          structuredQuery: {
            from: [{ collectionId: "communities" }],
            where: {
              fieldFilter: {
                field: { fieldPath: "nameLower" },
                op: "EQUAL",
                value: { stringValue: communityNameLower },
              },
            },
            limit: 1,
          },
        }),
      }
    );

    if (queryRes.ok) {
      const queryData = await queryRes.json();
      if (Array.isArray(queryData) && queryData[0]?.document) {
        const commDoc = queryData[0].document;
        isExistingCommunity = true;
        targetDocPath = `https://firestore.googleapis.com/v1/${commDoc.name}`;
        targetCommunityName = commDoc.fields?.name?.stringValue || rawName;
        currentMemberCount = commDoc.fields?.memberCount?.integerValue
          ? parseInt(commDoc.fields.memberCount.integerValue, 10)
          : 0;
      }
    }

    // Read current user doc to see if they're changing communities
    const userDocRes = await fetch(`${BASE}/users/${uid}`, { headers });
    let previousCommunityId = null;
    if (userDocRes.ok) {
      const userDoc = await userDocRes.json();
      previousCommunityId = userDoc.fields?.communityId?.stringValue || null;
    }

    // If switching, we need to decrement old community's count
    if (previousCommunityId && previousCommunityId.toLowerCase() !== communityNameLower) {
      const oldQueryRes = await fetch(
        `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            structuredQuery: {
              from: [{ collectionId: "communities" }],
              where: {
                fieldFilter: {
                  field: { fieldPath: "nameLower" },
                  op: "EQUAL",
                  value: { stringValue: previousCommunityId.toLowerCase() },
                },
              },
              limit: 1,
            },
          }),
        }
      );
      if (oldQueryRes.ok) {
        const oldQueryData = await oldQueryRes.json();
        if (Array.isArray(oldQueryData) && oldQueryData[0]?.document) {
          const oldDoc = oldQueryData[0].document;
          const oldDocPath = `https://firestore.googleapis.com/v1/${oldDoc.name}`;
          const oldCount = oldDoc.fields?.memberCount?.integerValue
            ? parseInt(oldDoc.fields.memberCount.integerValue, 10)
            : 1;
          
          await fetch(`${oldDocPath}?updateMask.fieldPaths=memberCount`, {
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
    }

    const isNewMember = !previousCommunityId || previousCommunityId.toLowerCase() !== communityNameLower;
    const newMemberCount = isNewMember ? currentMemberCount + 1 : currentMemberCount;

    // Upsert community doc
    if (isExistingCommunity) {
      await fetch(`${targetDocPath}?updateMask.fieldPaths=memberCount`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          fields: {
            memberCount: { integerValue: newMemberCount },
          },
        }),
      });
    } else {
      await fetch(targetDocPath, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          fields: {
            name:        { stringValue: targetCommunityName },
            nameLower:   { stringValue: communityNameLower },
            memberCount: { integerValue: newMemberCount },
            createdAt:   { timestampValue: new Date().toISOString() },
            type:        { stringValue: "general" },
          },
        }),
      });
    }

    // ── 5. Update user doc ─────────────────────────────────────────────────
    await fetch(`${BASE}/users/${uid}?updateMask.fieldPaths=communityId`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        fields: {
          communityId: { stringValue: targetCommunityName },
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
                      value: { stringValue: targetCommunityName },
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
      communityId: targetCommunityName,
      memberCount: newMemberCount,
      activeCount,
    });
  } catch (err) {
    console.error("Community join error:", err);
    return NextResponse.json({ error: err.message || "Internal Server Error" }, { status: 500 });
  }
}
