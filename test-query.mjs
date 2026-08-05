import { getAdminToken, firestoreBase } from "./app/api/_lib/adminToken.js";

async function testQuery() {
  const adminToken = await getAdminToken();
  const projectId = process.env.VITE_FIREBASE_PROJECT_ID;
  const BASE_QUERY = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/documents:runQuery`;

  const pivot = Math.random();
  const cutoff = new Date(Date.now() - 2 * 60_000).toISOString();

  const query = {
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
                field: { fieldPath: "sortKey" },
                op: "GREATER_THAN_OR_EQUAL",
                value: { doubleValue: pivot },
              },
            },
          ],
        },
      },
      orderBy: [{ field: { fieldPath: "sortKey" }, direction: "ASCENDING" }],
      limit: 100,
    },
  };

  const res = await fetch(BASE_QUERY, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${adminToken}`,
    },
    body: JSON.stringify(query),
  });

  const data = await res.json();
  if (data.error || (Array.isArray(data) && data[0]?.error)) {
    console.error("Query failed:", JSON.stringify(data, null, 2));
  } else {
    console.log("Query succeeded! Found docs:", data.length);
  }
}

testQuery().catch(console.error);
