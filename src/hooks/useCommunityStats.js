import { useState, useEffect } from "react";
import { auth, API_URL } from "../firebase";

/**
 * Fetch live member + online counts for a community from the server.
 */
export function useCommunityStats(communityId) {
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!communityId || !auth.currentUser) {
      setStats(null);
      return;
    }

    let cancelled = false;

    async function fetchStats() {
      setLoading(true);
      try {
        const token = await auth.currentUser.getIdToken();
        const params = new URLSearchParams({ communityName: communityId });
        const res = await fetch(`${API_URL}/community/stats?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error("Failed to fetch community stats");
        const data = await res.json();
        if (!cancelled) setStats(data);
      } catch (err) {
        console.warn("Community stats fetch failed:", err.message);
        if (!cancelled) setStats(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    fetchStats();
    const interval = setInterval(fetchStats, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [communityId]);

  return { stats, loading };
}
