import { useState, useEffect, useRef } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  limit,
  getDocs,
} from "firebase/firestore";
import { auth, db, API_URL } from "../firebase";

/**
 * CommunityPicker — Autocomplete dropdown for selecting or creating communities.
 *
 * Member counts are maintained server-side when users join via POST /community/join.
 * Active (online) counts are fetched from GET /community/stats.
 */
export default function CommunityPicker({
  onSelect,
  showSkip = false,
  initialValue = "",
}) {
  const [input, setInput] = useState(initialValue);
  const [suggestions, setSuggestions] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [joining, setJoining] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  async function enrichWithStats(communities) {
    if (!auth.currentUser || communities.length === 0) return communities;

    try {
      const token = await auth.currentUser.getIdToken();
      const enriched = await Promise.all(
        communities.map(async (c) => {
          try {
            const params = new URLSearchParams({ communityName: c.name });
            const res = await fetch(`${API_URL}/community/stats?${params}`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (!res.ok) return c;
            const stats = await res.json();
            return {
              ...c,
              memberCount: stats.memberCount,
              activeCount: stats.activeCount,
            };
          } catch {
            return c;
          }
        }),
      );
      return enriched;
    } catch {
      return communities;
    }
  }

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = input.trim();
    if (trimmed.length < 2) {
      setSuggestions([]);
      setShowDropdown(false);
      return;
    }

    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const lower = trimmed.toLowerCase();
        const end =
          lower.slice(0, -1) +
          String.fromCharCode(lower.charCodeAt(lower.length - 1) + 1);

        const q = query(
          collection(db, "communities"),
          where("nameLower", ">=", lower),
          where("nameLower", "<", end),
          orderBy("nameLower"),
          limit(8),
        );

        const snapshot = await getDocs(q);
        const results = snapshot.docs.map((docSnap) => ({
          id: docSnap.id,
          ...docSnap.data(),
        }));

        const withStats = await enrichWithStats(results);
        setSuggestions(withStats);
        setShowDropdown(true);
      } catch (err) {
        console.error("Community search failed:", err);
        setSuggestions([]);
      } finally {
        setLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [input]);

  const handleSelect = async (communityName) => {
    setInput(communityName);
    setShowDropdown(false);
    setJoining(true);
    try {
      await onSelect(communityName);
    } finally {
      setJoining(false);
    }
  };

  const handleCreateOrJoin = async () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length < 2) return;
    await handleSelect(trimmed);
  };

  const handleSkip = () => {
    handleSelect("Global");
  };

  const exactMatch = suggestions.some(
    (s) => s.nameLower === input.trim().toLowerCase(),
  );
  const trimmed = input.trim();

  function formatMeta(s) {
    const members = s.memberCount ?? 0;
    return `${members} ${members === 1 ? "member" : "members"}`;
  }

  return (
    <div className="community-picker" ref={wrapperRef}>
      <div className="community-input-wrapper">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => {
            if (suggestions.length > 0) setShowDropdown(true);
          }}
          placeholder="Search or create a community…"
          className="community-input"
          autoComplete="off"
          disabled={joining}
        />
        {(loading || joining) && <span className="community-spinner" />}
      </div>

      {showDropdown && suggestions.length > 0 && (
        <ul className="community-dropdown">
          {suggestions.map((s) => (
            <li
              key={s.id}
              className="community-option"
              onClick={() => handleSelect(s.name)}
            >
              <span className="community-option-name">{s.name}</span>
              <span className="community-option-meta">{formatMeta(s)}</span>
            </li>
          ))}
        </ul>
      )}

      {trimmed.length >= 2 && !exactMatch && (
        <button
          className="community-create-btn"
          onClick={handleCreateOrJoin}
          disabled={joining}
        >
          {joining ? "Joining…" : `Create "${trimmed}" as a new community`}
        </button>
      )}

      {trimmed.length >= 2 && exactMatch && (
        <button
          className="community-create-btn"
          onClick={() => {
            const match = suggestions.find(
              (s) => s.nameLower === trimmed.toLowerCase(),
            );
            if (match) handleSelect(match.name);
          }}
          disabled={joining}
        >
          {joining
            ? "Joining…"
            : `Join "${suggestions.find((s) => s.nameLower === trimmed.toLowerCase())?.name}"`}
        </button>
      )}

      {showSkip && (
        <button
          className="community-skip-btn"
          onClick={handleSkip}
          disabled={joining}
        >
          Skip → Join Global Community
        </button>
      )}
    </div>
  );
}
