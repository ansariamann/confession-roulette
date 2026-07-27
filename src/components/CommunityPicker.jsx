import { useState, useEffect, useRef } from "react";
import { collection, query, where, orderBy, limit, getDocs, addDoc, serverTimestamp } from "firebase/firestore";
import { db } from "../firebase";

/**
 * CommunityPicker — Autocomplete dropdown for selecting or creating communities.
 * 
 * As the user types, it queries the `communities` collection in Firestore
 * using a prefix match on `nameLower`. If matching communities exist,
 * they appear in a dropdown. The user can pick one, or if their typed name
 * doesn't exist, they can create a new community. They can also skip
 * to join the "Global" community.
 * 
 * Props:
 *   onSelect(communityName: string) — called when the user picks or creates a community
 *   showSkip — whether to show "Skip → Join Global" button
 *   initialValue — pre-fill input (for Settings screen)
 */
export default function CommunityPicker({ onSelect, showSkip = false, initialValue = "" }) {
  const [input, setInput] = useState(initialValue);
  const [suggestions, setSuggestions] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const debounceRef = useRef(null);
  const wrapperRef = useRef(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Debounced Firestore search
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
        // Firestore prefix range query: nameLower >= "har" && nameLower < "has"
        const end = lower.slice(0, -1) + String.fromCharCode(lower.charCodeAt(lower.length - 1) + 1);
        
        const q = query(
          collection(db, "communities"),
          where("nameLower", ">=", lower),
          where("nameLower", "<", end),
          orderBy("nameLower"),
          limit(8)
        );

        const snapshot = await getDocs(q);
        const results = snapshot.docs.map(doc => ({
          id: doc.id,
          ...doc.data(),
        }));
        setSuggestions(results);
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

  const handleSelectExisting = (community) => {
    setInput(community.name);
    setShowDropdown(false);
    onSelect(community.name);
  };

  const handleCreateNew = async () => {
    const trimmed = input.trim();
    if (!trimmed || trimmed.length < 2) return;

    setCreating(true);
    try {
      // Create the community in the registry
      await addDoc(collection(db, "communities"), {
        name: trimmed,
        nameLower: trimmed.toLowerCase(),
        type: "general", // default type
        createdAt: serverTimestamp(),
        memberCount: 1,
      });
      setShowDropdown(false);
      onSelect(trimmed);
    } catch (err) {
      console.error("Failed to create community:", err);
    } finally {
      setCreating(false);
    }
  };

  const handleSkip = () => {
    onSelect("Global");
  };

  const exactMatch = suggestions.some(s => s.nameLower === input.trim().toLowerCase());
  const trimmed = input.trim();

  return (
    <div className="community-picker" ref={wrapperRef}>
      <div className="community-input-wrapper">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onFocus={() => { if (suggestions.length > 0) setShowDropdown(true); }}
          placeholder="Search or create a community…"
          className="community-input"
          autoComplete="off"
        />
        {loading && <span className="community-spinner" />}
      </div>

      {showDropdown && suggestions.length > 0 && (
        <ul className="community-dropdown">
          {suggestions.map((s) => (
            <li 
              key={s.id} 
              className="community-option"
              onClick={() => handleSelectExisting(s)}
            >
              <span className="community-option-name">{s.name}</span>
              <span className="community-option-meta">
                {s.memberCount || 1} {(s.memberCount || 1) === 1 ? "member" : "members"}
              </span>
            </li>
          ))}
        </ul>
      )}

      {/* Show "Create new" if typed text doesn't exactly match any existing community */}
      {trimmed.length >= 2 && !exactMatch && (
        <button
          className="community-create-btn"
          onClick={handleCreateNew}
          disabled={creating}
        >
          {creating ? "Creating…" : `Create "${trimmed}" as a new community`}
        </button>
      )}

      {/* Show "Join existing" if user typed and there's an exact match */}
      {trimmed.length >= 2 && exactMatch && (
        <button
          className="community-create-btn"
          onClick={() => {
            const match = suggestions.find(s => s.nameLower === trimmed.toLowerCase());
            if (match) handleSelectExisting(match);
          }}
        >
          Join "{suggestions.find(s => s.nameLower === trimmed.toLowerCase())?.name}"
        </button>
      )}

      {showSkip && (
        <button className="community-skip-btn" onClick={handleSkip}>
          Skip → Join Global Community
        </button>
      )}
    </div>
  );
}
