import { useState } from "react";
import { useAuth } from "../context/AuthProvider";
import { useNavigate } from "react-router-dom";
import CommunityPicker from "../components/CommunityPicker";

const PREFERENCE_TOGGLES = [
  { key: "darkMode", label: "Dark Mode", desc: "Toggle dark appearance" },
  { key: "soundEffects", label: "Sound Effects", desc: "Tap and reaction audio feedback" },
  { key: "vibration", label: "Vibration", desc: "Haptic feedback on reactions" },
  { key: "autoScrollComments", label: "Auto-Scroll Comments", desc: "Scroll to latest comment automatically" },
];

export default function SettingsScreen() {
  const { user, logout, updateCommunity } = useAuth();
  const navigate = useNavigate();
  const [changingCommunity, setChangingCommunity] = useState(false);
  const [saving, setSaving] = useState(false);

  // ── App preferences (persisted to localStorage) ─────────────────────────
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem("verdict-settings");
      return saved
        ? { darkMode: false, ...JSON.parse(saved) }
        : { darkMode: false, soundEffects: true, vibration: true, autoScrollComments: true };
    } catch {
      return { darkMode: false, soundEffects: true, vibration: true, autoScrollComments: true };
    }
  });

  function toggleSetting(key) {
    setSettings((prev) => {
      const updated = { ...prev, [key]: !prev[key] };
      localStorage.setItem("verdict-settings", JSON.stringify(updated));
      if (key === "darkMode") {
        document.documentElement.dataset.theme = updated.darkMode ? "dark" : "light";
      }
      return updated;
    });
  }

  const handleCommunitySelect = async (communityName) => {
    setSaving(true);
    try {
      await updateCommunity(communityName);
      setChangingCommunity(false);
    } catch (err) {
      console.error("Failed to update community:", err);
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    navigate("/");
  };

  return (
    <div className="screen" id="settings-screen">
      <div className="screen-icon">⚙️</div>
      <h1 className="screen-title">Settings</h1>

      <div className="glass-card" style={{ padding: "24px", display: "flex", flexDirection: "column", gap: "24px", marginTop: "24px" }}>

        {/* ── Community Section ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ fontSize: "14px", fontWeight: "bold", color: "var(--ink)" }}>Active Community</label>

          {!changingCommunity ? (
            <div>
              <div className="settings-community-badge">
                <span className="settings-community-name">{user?.communityId || "Global"}</span>
              </div>
              <p style={{ fontSize: "13px", color: "var(--muted)", margin: "8px 0 0 0" }}>
                Your drops are only visible to users in this community.
              </p>
              <button
                className="compose-btn secondary"
                onClick={() => setChangingCommunity(true)}
                style={{ marginTop: "12px" }}
              >
                Change Community
              </button>
            </div>
          ) : saving ? (
            <div style={{ textAlign: "center", padding: "16px" }}>
              <div className="loading-spinner" />
              <span className="loading-text">Switching…</span>
            </div>
          ) : (
            <div>
              <CommunityPicker
                onSelect={handleCommunitySelect}
                showSkip={true}
                initialValue=""
              />
              <button
                className="compose-btn secondary"
                onClick={() => setChangingCommunity(false)}
                style={{ marginTop: "8px" }}
              >
                Cancel
              </button>
            </div>
          )}
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--hairline-strong)" }} />

        {/* ── Preferences Section ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ fontSize: "14px", fontWeight: "bold", color: "var(--ink)" }}>Preferences</label>
          {PREFERENCE_TOGGLES.map(({ key, label, desc }) => (
            <div className="setting-row" key={key}>
              <div className="setting-info">
                <span className="setting-label">{label}</span>
                <span className="setting-desc">{desc}</span>
              </div>
              <button
                className={`setting-switch ${settings[key] ? "on" : "off"}`}
                onClick={() => toggleSetting(key)}
                aria-label={`Toggle ${label}`}
                id={`setting-${key}`}
              >
                <span className="switch-knob" />
              </button>
            </div>
          ))}
        </div>

        <hr style={{ border: "none", borderTop: "1px solid var(--hairline-strong)" }} />

        {/* ── Account Section ── */}
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          <label style={{ fontSize: "14px", fontWeight: "bold", color: "var(--ink)" }}>Account</label>
          <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
            {user?.photoURL && (
              <img src={user.photoURL} alt="Profile" style={{ width: "40px", height: "40px", borderRadius: "50%", border: "2px solid var(--hairline-strong)" }} />
            )}
            <div>
              <div style={{ fontWeight: "bold", fontSize: "14px" }}>{user?.displayName || "Anonymous"}</div>
              <div style={{ fontSize: "12px", opacity: 0.6 }}>{user?.email}</div>
            </div>
          </div>
          <button className="compose-btn secondary" onClick={handleLogout} style={{ marginTop: "8px" }}>
            Sign Out
          </button>
        </div>

      </div>
    </div>
  );
}
