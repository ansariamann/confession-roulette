if (typeof navigator === "undefined") {
  globalThis.navigator = { userAgent: "Cloudflare-Workers" };
}
import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";
import { initializeApp, getApps } from "firebase/app";
import { getAuth, signInWithEmailAndPassword, inMemoryPersistence, setPersistence } from "firebase/auth";
import { getFirestore, doc, setDoc, deleteDoc, collection, getDocs } from "firebase/firestore";

export const runtime = "edge";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL || "",
  token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
});

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

export async function POST(req) {
  try {
    const { dropId, authorUid, text } = await req.json();
    if (!dropId) return NextResponse.json({ error: "Missing dropId" }, { status: 400 });

    // 1. Authenticate as Bot User
    if (!auth.currentUser || auth.currentUser.uid !== "admin_bot_uid") {
      await setPersistence(auth, inMemoryPersistence);
      await signInWithEmailAndPassword(auth, "bot@confessionroulette.com", "super_secret_bot_password");
    }

    // 2. Fetch final reactions from Upstash Redis
    const reactions = await redis.hgetall(`reactions:${dropId}`) || {};
    const reactionTotals = {};
    for (const [k, v] of Object.entries(reactions)) {
      reactionTotals[k] = parseInt(v, 10);
    }
    const totalReactions = Object.values(reactionTotals).reduce((a, b) => a + b, 0);

    // 3. Fetch comments from Firestore before deleting
    const commentsSnap = await getDocs(collection(db, "drops", dropId, "comments"));
    const comments = [];
    commentsSnap.forEach((d) => {
      comments.push({ id: d.id, ...d.data() });
    });

    // 4. Write Verdict
    await setDoc(doc(db, "verdicts", dropId), {
      dropId,
      authorUid,
      text, // Store text so the author can see it in their verdict history
      reactions: reactionTotals,
      totalReactions,
      comments,
      expiredAt: new Date()
    });

    // 5. Hard Delete Drop
    await deleteDoc(doc(db, "drops", dropId));

    // 6. Cleanup Redis (optional since we set a TTL, but good practice)
    await redis.del(`reactions:${dropId}`, `voters:${dropId}`);

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Expiry Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
