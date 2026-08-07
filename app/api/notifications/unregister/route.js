import { NextResponse } from "next/server";
import { getAdminToken, verifyIdToken, firestoreBase } from "../../_lib/adminToken";

export async function POST(req) {
  try {
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

    // In a full implementation we might take a specific token to remove. 
    // Here we'll clear the whole array to disable notifications entirely for the user.
    const adminToken = await getAdminToken();
    const BASE = firestoreBase();

    await fetch(`${BASE}/users/${uid}?updateMask.fieldPaths=fcmTokens`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${adminToken}`,
      },
      body: JSON.stringify({
        fields: {
          fcmTokens: { arrayValue: { values: [] } }
        }
      })
    });

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in /api/notifications/unregister:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
