import { NextResponse } from "next/server";
import { Redis } from "@upstash/redis";

let redis;

function initServices() {
  if (redis) return;
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.UPSTASH_REDIS_REST_TOKEN || "",
  });
}

export async function GET(req) {
  initServices();
  const { searchParams } = new URL(req.url);
  const dropId = searchParams.get("dropId");
  if (!dropId) return NextResponse.json({ error: "Missing dropId" }, { status: 400 });

  try {
    const reactions = await redis.hgetall(`reactions:${dropId}`);
    return NextResponse.json({ reactions: reactions || {} });
  } catch (error) {
    console.error("Redis Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    initServices();
    const body = await req.json();
    const { dropId, emoji, uid } = body;

    if (!dropId || !emoji) {
      return NextResponse.json({ error: "Missing fields" }, { status: 400 });
    }

    // Rate limiting / deduplication using a Redis Set
    const hasReacted = await redis.sismember(`voters:${dropId}`, uid || "anon");
    if (hasReacted) {
      return NextResponse.json({ error: "Already reacted" }, { status: 429 });
    }

    // Add to voters set and increment emoji counter atomically
    const pipeline = redis.pipeline();
    pipeline.sadd(`voters:${dropId}`, uid || "anon");
    pipeline.hincrby(`reactions:${dropId}`, emoji, 1);
    // Set expiry so we don't leak memory (1 hour max)
    pipeline.expire(`voters:${dropId}`, 3600);
    pipeline.expire(`reactions:${dropId}`, 3600);
    await pipeline.exec();

    return NextResponse.json({ success: true });
  } catch (error) {
    console.error("Redis Error:", error);
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 });
  }
}
