import { NextResponse } from "next/server";

const PII_PATTERNS = [
  { name: "PII_PHONE", pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,5}\)?[-.\s]?\d{3,5}[-.\s]?\d{3,5}\b/ },
  { name: "PII_EMAIL", pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/ },
  { name: "PII_ADDRESS", pattern: /\b\d{1,5}\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St(?:reet)?|Ave(?:nue)?|Blvd|Boulevard|Dr(?:ive)?|Ln|Lane|Rd|Road|Way|Ct|Court|Pl(?:ace)?|Cir(?:cle)?|Terr(?:ace)?|Pike|Hwy|Highway)\b/i },
  { name: "PII_SOCIAL", pattern: /(?:^|\s)@[a-zA-Z_]\w{2,29}(?!\.\w)/m }
];

export async function POST(req) {
  try {
    const { text, communityId, uid } = await req.json();
    if (!text || !uid) return NextResponse.json({ error: "Missing fields" }, { status: 400 });

    // 1. PII Check
    for (const { name, pattern } of PII_PATTERNS) {
      if (pattern.test(text)) {
        return NextResponse.json({ error: "Safety Check Failed (PII)" }, { status: 403 });
      }
    }

    const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
    const apiKey = process.env.VITE_FIREBASE_API_KEY;
    if (!projectId || !apiKey) {
      return NextResponse.json({ error: "Server misconfiguration (Firebase)" }, { status: 500 });
    }

    // 2. Authenticate as Bot User (REST)
    console.log("Authenticating bot via REST...");
    const authRes = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "bot@confessionroulette.com", password: "super_secret_bot_password", returnSecureToken: true })
    });
    const authData = await authRes.json();
    if (!authRes.ok) {
      console.error("Bot Auth Failed:", authData);
      return NextResponse.json({ error: "Bot Auth Failed" }, { status: 500 });
    }
    const idToken = authData.idToken;

    // 3. Select 100 random active recipients (REST)
    const cutoffDate = new Date(Date.now() - 2 * 60_000);
    console.log("Fetching presence via REST...");
    const queryRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
      body: JSON.stringify({
        structuredQuery: {
          from: [{ collectionId: "presence" }],
          where: {
            compositeFilter: {
              op: "AND",
              filters: [{
                fieldFilter: {
                  field: { fieldPath: "lastSeen" },
                  op: "GREATER_THAN",
                  value: { timestampValue: cutoffDate.toISOString() }
                }
              }]
            }
          },
          limit: 1000
        }
      })
    });
    
    const queryData = await queryRes.json();
    let activeUids = [];
    
    // queryData is an array of objects. Document details are in 'document' field.
    if (Array.isArray(queryData)) {
      queryData.forEach((row) => {
        if (row.document) {
          const docId = row.document.name.split("/").pop();
          const dataFields = row.document.fields || {};
          const cId = dataFields.communityId?.stringValue || "global";
          
          if (cId === (communityId || "global") && docId !== uid) {
            activeUids.push(docId);
          }
        }
      });
    }

    // Fisher-Yates shuffle to pick up to 100
    for (let i = activeUids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activeUids[i], activeUids[j]] = [activeUids[j], activeUids[i]];
    }
    const recipients = activeUids.slice(0, 100);

    // 4. Create Drop (REST)
    console.log("Creating drop doc via REST...");
    const dropRes = await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents/drops`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
      body: JSON.stringify({
        fields: {
          authorUid: { stringValue: uid },
          text: { stringValue: text },
          recipientUids: { arrayValue: { values: recipients.map(r => ({ stringValue: r })) } },
          recipientCount: { integerValue: recipients.length },
          status: { stringValue: "broadcasting" },
          broadcastStartedAt: { timestampValue: new Date().toISOString() },
          edgeSecret: { stringValue: "cf_worker_secret_key" }
        }
      })
    });
    const dropData = await dropRes.json();
    if (!dropRes.ok) {
      console.error("Failed to create drop:", dropData);
      return NextResponse.json({ error: "Failed to create drop" }, { status: 500 });
    }
    const dropId = dropData.name.split("/").pop();
    console.log("Drop doc created.", dropId);

    // 5. Seed reactions (REST)
    console.log("Seeding reactions via REST...");
    const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
    const writes = EMOJIS.map(emoji => ({
      update: {
        name: `projects/${projectId}/databases/(default)/documents/drops/${dropId}/reactions/${emoji}`,
        fields: { count: { integerValue: 0 } }
      }
    }));
    await fetch(`https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${idToken}` },
      body: JSON.stringify({ writes })
    });
    console.log("Reactions seeded.");

    // 6. Schedule Expiry via QStash (REST)
    console.log("Scheduling QStash via REST...");
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://your-deployment-url.pages.dev";
    const qstashToken = process.env.QSTASH_TOKEN || "";
    
    if (qstashToken) {
      await fetch(`https://qstash.upstash.io/v2/publish/${baseUrl}/api/expire`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${qstashToken}`,
          "Content-Type": "application/json",
          "Upstash-Delay": "60s"
        },
        body: JSON.stringify({ dropId: dropId, authorUid: uid, text })
      });
      console.log("QStash scheduled.");
    } else {
      console.warn("QSTASH_TOKEN missing, skipping expiry scheduling");
    }

    return NextResponse.json({ success: true, dropId: dropId });
  } catch (error) {
    console.error("FATAL ERROR IN CONFESS ROUTE:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
