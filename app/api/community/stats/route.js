import { NextResponse } from "next/server";
import { getAdminToken, firestoreBase } from "../../_lib/adminToken";

/**
 * GET /api/community/stats?communityName=XYZ
 * Auth: Bearer token (Firebase ID token)
 *
 * Returns { memberCount, activeCount } for a community.
 */
export async function GET(req) {
  try {
    const authHeader = req.headers.get("authorization") || "";
    const idToken = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
    if (!idToken) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { searchParams } = new URL(req.url);
    const communityName = (searchParams.get("communityName") || "").trim();
    if (!communityName) {
      return NextResponse.json({ error: "Missing communityName" }, { status: 400 });
    }

    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const adminToken = await getAdminToken();
    const BASE = firestoreBase();
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    };
    const BASE_QUERY = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

    // Query community doc by nameLower
    let memberCount = 0;
    const queryRes = await fetch(BASE_QUERY, {
      method: "POST",
      headers,
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "communities" }],
          where: {
            fieldFilter: {
              field: { fieldPath: "nameLower" },
              op: "EQUAL",
              value: { stringValue: communityName.toLowerCase() },
            },
          },
          limit: 1,
        },
      }),
    });

    if (queryRes.ok) {
      const queryData = await queryRes.json();
      if (Array.isArray(queryData) && queryData[0]?.document) {
        const commDoc = queryData[0].document;
        memberCount = commDoc.fields?.memberCount?.integerValue
          ? parseInt(commDoc.fields.memberCount.integerValue, 10)
          : 0;
      }
    }

    // Count active users (presence in last 2 min)
    const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();
    const presenceRes = await fetch(BASE_QUERY, {
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
                    value: { stringValue: communityName },
                  },
                },
              ],
            },
          },
          limit: 500,
        },
      }),
    });

    const presenceData = await presenceRes.json();
    const activeCount = Array.isArray(presenceData)
      ? presenceData.filter((r) => r.document).length
      : 0;

    return NextResponse.json({ communityId: communityName, memberCount, activeCount });
  } catch (err) {
    console.error("Community stats error:", err);
    return NextResponse.json(
      { error: err.message || "Internal Server Error" },
      { status: 500 }
    );
  }
}
