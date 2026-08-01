if (typeof navigator === "undefined") {
  globalThis.navigator = { userAgent: "Cloudflare-Workers" };
}
import { NextResponse } from "next/server";
import { ComprehendClient, DetectToxicContentCommand } from "@aws-sdk/client-comprehend";
import { Client as QStashClient } from "@upstash/qstash";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, inMemoryPersistence, setPersistence } from "firebase/auth";
import { getFirestore, collection, addDoc, getDocs, query, where, serverTimestamp, writeBatch, doc } from "firebase/firestore";

export const runtime = "edge";

// Initialize Firebase client SDK for the Edge environment
const firebaseConfig = {
  apiKey: process.env.VITE_FIREBASE_API_KEY,
  authDomain: process.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: process.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.VITE_FIREBASE_APP_ID
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApps()[0];
const auth = getAuth(app);
const db = getFirestore(app);
const qstash = new QStashClient({ 
  token: process.env.QSTASH_TOKEN || "",
  ...(process.env.QSTASH_URL ? { baseUrl: process.env.QSTASH_URL } : {})
});
const comprehend = new ComprehendClient({
  region: process.env.AWS_REGION || "us-east-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID || "",
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || "",
  }
});

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

    // 2. AWS Comprehend Check
    if (!process.env.SKIP_COMPREHEND) {
      try {
        const cmd = new DetectToxicContentCommand({ LanguageCode: "en", TextSegments: [{ Text: text }] });
        const result = await comprehend.send(cmd);
        const tox = result.ResultList?.[0];
        if (tox && tox.Toxicity >= 0.5) {
          return NextResponse.json({ error: "Safety Check Failed (Toxicity)" }, { status: 403 });
        }
      } catch (e) {
        console.warn("Comprehend check failed or unsupported", e);
      }
    }

    // 3. Authenticate as Bot User
    console.log("Authenticating bot...");
    if (!auth.currentUser || auth.currentUser.uid !== "admin_bot_uid") {
      await setPersistence(auth, inMemoryPersistence);
      await signInWithEmailAndPassword(auth, "bot@confessionroulette.com", "super_secret_bot_password");
    }
    console.log("Authenticated bot. Current UID:", auth.currentUser.uid);

    // 4. Select 100 random active recipients
    const cutoffDate = new Date(Date.now() - 2 * 60_000);
    const presenceQ = query(collection(db, "presence"), where("lastSeen", ">", cutoffDate));
    console.log("Fetching presence...");
    const presenceSnap = await getDocs(presenceQ);
    console.log("Fetched presence.");
    
    let activeUids = [];
    presenceSnap.forEach((doc) => {
      const data = doc.data();
      if ((data.communityId || "global") === (communityId || "global") && doc.id !== uid) {
        activeUids.push(doc.id);
      }
    });

    // Fisher-Yates shuffle to pick up to 100
    for (let i = activeUids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activeUids[i], activeUids[j]] = [activeUids[j], activeUids[i]];
    }
    const recipients = activeUids.slice(0, 100);

    // 5. Create Drop with Edge Secret
    console.log("Creating drop doc...");
    const dropDoc = await addDoc(collection(db, "drops"), {
      authorUid: uid,
      text,
      recipientUids: recipients,
      recipientCount: recipients.length,
      status: "broadcasting",
      broadcastStartedAt: serverTimestamp(),
      edgeSecret: "cf_worker_secret_key"
    });
    console.log("Drop doc created.", dropDoc.id);

    // 6. Seed reactions
    console.log("Seeding reactions...");
    const batch = writeBatch(db);
    const EMOJIS = ["😂", "💀", "😬", "❤️", "😳"];
    for (const emoji of EMOJIS) {
      batch.set(doc(db, "drops", dropDoc.id, "reactions", emoji), { count: 0 });
    }
    await batch.commit();
    console.log("Reactions seeded.");

    // 7. Schedule Expiry via QStash
    console.log("Scheduling QStash...");
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://your-deployment-url.pages.dev";
    await qstash.publishJSON({
      url: `${baseUrl}/api/expire`,
      body: { dropId: dropDoc.id, authorUid: uid, text },
      delay: "10s",
    });
    console.log("QStash scheduled.");

    return NextResponse.json({ success: true, dropId: dropDoc.id });
  } catch (error) {
    console.error("FATAL ERROR IN CONFESS ROUTE:", error);
    return NextResponse.json({ error: error.message || "Internal Server Error" }, { status: 500 });
  }
}
