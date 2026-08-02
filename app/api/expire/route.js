import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

export async function POST(req) {
  try {
    const { dropId, authorUid, text } = await req.json();
    if (!dropId) return NextResponse.json({ error: "Missing dropId" }, { status: 400 });

    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const apiKey = process.env.VITE_FIREBASE_API_KEY;
    if (!projectId || !apiKey) {
      return NextResponse.json({ error: "Server misconfiguration (Firebase)" }, { status: 500 });
    }

    // 1. Authenticate as Bot User (REST)
    const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bot@confessionroulette.com", password: "super_secret_bot_password", returnSecureToken: true })
    });
    const authData = await authRes.json();
    if (!authRes.ok) throw new Error("Bot Auth Failed: " + JSON.stringify(authData));
    const idToken = authData.idToken;

    // 2. Fetch final reactions from Upstash Redis
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL || "",
      token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
    });
    
    const reactions = await redis.hgetall(`reactions:${dropId}`) || {};
    const reactionTotals = {};
    for (const [k, v] of Object.entries(reactions)) {
      reactionTotals[k] = parseInt(v, 10);
    }
    const totalReactions = Object.values(reactionTotals).reduce((a, b) => a + b, 0);

    // 3. Fetch comments from Firestore before deleting (REST)
    const commentsRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/drops/${dropId}/comments`, {
      method: "GET",
      headers: { "Authorization": `Bearer ${idToken}` }
    });
    const commentsData = await commentsRes.json();
    const comments = [];
    if (commentsData.documents) {
      commentsData.documents.forEach(doc => {
        const id = doc.name.split("/").pop();
        comments.push({ id, text: doc.fields?.text?.stringValue || "", createdAt: doc.fields?.createdAt?.timestampValue || "" });
      });
    }

    // 4. Write Verdict (REST)
    const verdictFields = {
      dropId: { stringValue: dropId },
      authorUid: { stringValue: authorUid },
      text: { stringValue: text },
      totalReactions: { integerValue: totalReactions },
      expiredAt: { timestampValue: new Date().toISOString() },
      reactions: {
        mapValue: {
          fields: Object.fromEntries(
            Object.entries(reactionTotals).map(([k, v]) => [k, { integerValue: v }])
          )
        }
      },
      comments: {
        arrayValue: {
          values: comments.map(c => ({
            mapValue: {
              fields: {
                id: { stringValue: c.id },
                text: { stringValue: c.text },
                createdAt: { timestampValue: c.createdAt }
              }
            }
          }))
        }
      }
    };

    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/verdicts?documentId=${dropId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
      body: JSON.stringify({ fields: verdictFields })
    });

    // 5. Hard Delete Drop (REST)
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/drops/${dropId}`, {
      method: "DELETE",
      headers: { "Authorization": `Bearer ${idToken}` }
    });

    // 6. Cleanup Redis
    await redis.del(`reactions:${dropId}`, `voters:${dropId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Expiry Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
