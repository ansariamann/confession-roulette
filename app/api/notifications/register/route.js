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

    const { token } = await req.json();
    if (!token || typeof token !== "string") {
      return NextResponse.json({ error: "Missing or invalid FCM token" }, { status: 400 });
    }

    const adminToken = await getAdminToken();
    const BASE = firestoreBase();
    
    // We use a FieldTransform to safely append the token to the array without overwriting
    const res = await fetch(`${BASE}:commit`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${adminToken}`,
        },
        body: JSON.stringify({
            writes: [
                {
                    transform: {
                        document: `projects/${process.env.VITE_FIREBASE_PROJECT_ID}/databases/(default)/documents/users/${uid}`,
                        fieldTransforms: [
                            {
                                fieldPath: "fcmTokens",
                                appendMissingElements: {
                                    values: [{ stringValue: token }]
                                }
                            }
                        ]
                    }
                }
            ]
        })
    });
    
    if (!res.ok) {
        const errorText = await res.text();
        console.error("Firestore commit failed:", errorText);
        return NextResponse.json({ error: "Database error" }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Error in /api/notifications/register:", error);
    return NextResponse.json(
      { error: "Internal Server Error" },
      { status: 500 }
    );
  }
}
