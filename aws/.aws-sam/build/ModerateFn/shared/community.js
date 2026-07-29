// ─── Community helpers (server-side) ────────────────────────────────────────
// Single source of truth for community names, member counts, and active users.
// ─────────────────────────────────────────────────────────────────────────────

const { db, FieldValue } = require("./firebase-admin");
const { ACTIVE_WINDOW_MS } = require("./constants");

/**
 * Normalize community name for storage and matching.
 * "global", " Global ", etc. → "Global"; other names are trimmed as-is.
 */
function normalizeCommunityId(name) {
  const trimmed = (name || "").trim();
  if (!trimmed || trimmed.toLowerCase() === "global") return "Global";
  return trimmed;
}

async function findCommunityByName(communityName) {
  const normalized = normalizeCommunityId(communityName);
  const snapshot = await db
    .collection("communities")
    .where("nameLower", "==", normalized.toLowerCase())
    .limit(1)
    .get();

  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, ref: doc.ref, ...doc.data() };
}

async function countActiveMembers(communityId) {
  const normalized = normalizeCommunityId(communityId);
  const cutoff = new Date(Date.now() - ACTIVE_WINDOW_MS);

  // Query by lastSeen only (same index as drop scheduler) and filter in memory
  const snapshot = await db
    .collection("presence")
    .where("lastSeen", ">", cutoff)
    .get();

  return snapshot.docs.filter(
    (doc) => normalizeCommunityId(doc.data().communityId) === normalized,
  ).length;
}

/**
 * Join (or switch to) a community. Updates users/{uid}, member counts, and presence.
 */
async function joinCommunity(uid, communityName) {
  const normalized = normalizeCommunityId(communityName);
  if (normalized.length < 2) {
    throw new Error("Community name must be at least 2 characters");
  }

  const userRef = db.collection("users").doc(uid);
  const userDoc = await userRef.get();
  const previousCommunity = userDoc.exists && userDoc.data().communityId
    ? normalizeCommunityId(userDoc.data().communityId)
    : null;

  if (previousCommunity === normalized) {
    await db.collection("presence").doc(uid).set(
      { lastSeen: FieldValue.serverTimestamp(), communityId: normalized },
      { merge: true },
    );
    const communityDoc = await findCommunityByName(normalized);
    const activeCount = await countActiveMembers(normalized);
    return {
      communityId: normalized,
      memberCount: communityDoc?.memberCount ?? 0,
      activeCount,
    };
  }

  let targetCommunity = await findCommunityByName(normalized);
  if (!targetCommunity) {
    const ref = db.collection("communities").doc();
    await ref.set({
      name: normalized,
      nameLower: normalized.toLowerCase(),
      type: "general",
      createdAt: FieldValue.serverTimestamp(),
      memberCount: 0,
    });
    targetCommunity = { id: ref.id, ref, memberCount: 0 };
  }

  let oldCommunityRef = null;
  if (previousCommunity) {
    const oldDoc = await findCommunityByName(previousCommunity);
    oldCommunityRef = oldDoc?.ref || null;
  }

  await db.runTransaction(async (tx) => {
    const userSnap = await tx.get(userRef);
    const currentCommunity = userSnap.exists && userSnap.data().communityId
      ? normalizeCommunityId(userSnap.data().communityId)
      : null;

    if (currentCommunity === normalized) return;

    tx.set(userRef, { communityId: normalized }, { merge: true });
    tx.update(targetCommunity.ref, { memberCount: FieldValue.increment(1) });

    if (oldCommunityRef && currentCommunity && currentCommunity !== normalized) {
      const oldSnap = await tx.get(oldCommunityRef);
      if (oldSnap.exists && (oldSnap.data().memberCount || 0) > 0) {
        tx.update(oldCommunityRef, { memberCount: FieldValue.increment(-1) });
      }
    }
  });

  await db.collection("presence").doc(uid).set(
    { lastSeen: FieldValue.serverTimestamp(), communityId: normalized },
    { merge: true },
  );

  const communityDoc = await findCommunityByName(normalized);
  const activeCount = await countActiveMembers(normalized);

  return {
    communityId: normalized,
    memberCount: communityDoc?.memberCount ?? 1,
    activeCount,
  };
}

async function getCommunityStats(communityName) {
  const normalized = normalizeCommunityId(communityName);
  const communityDoc = await findCommunityByName(normalized);
  const activeCount = await countActiveMembers(normalized);

  return {
    communityId: normalized,
    memberCount: communityDoc?.memberCount ?? 0,
    activeCount,
    exists: !!communityDoc,
  };
}

module.exports = {
  normalizeCommunityId,
  findCommunityByName,
  countActiveMembers,
  joinCommunity,
  getCommunityStats,
};
