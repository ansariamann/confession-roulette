import { NextResponse } from "next/server";
import { getAdminToken, firestoreBase } from "../_lib/adminToken";

export async function GET(req) {
  try {
    const adminToken = await getAdminToken();
    const BASE = firestoreBase();
    
    // Fetch up to 10 users to see if they have fcmTokens
    const res = await fetch(`${BASE}/users`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    
    if (!res.ok) {
      return NextResponse.json({ error: await res.text() }, { status: 500 });
    }
    
    const data = await res.json();
    const usersWithTokens = (data.documents || [])
      .map(doc => ({
        uid: doc.name.split("/").pop(),
        tokens: doc.fields?.fcmTokens?.arrayValue?.values?.map(v => v.stringValue) || []
      }))
      .filter(u => u.tokens.length > 0);
      
    return NextResponse.json({ usersWithTokens });
  } catch (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
