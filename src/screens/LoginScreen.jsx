import { useState } from "react";
import { useAuth } from "../context/AuthProvider";
import CommunityPicker from "../components/CommunityPicker";

export default function LoginScreen() {
  const { user, login, updateCommunity } = useAuth();
  const [authError, setAuthError] = useState(null);
  const [saving, setSaving] = useState(false);

  const handleLogin = async () => {
    setAuthError(null);
    try {
      await login();
    } catch (err) {
      console.error("Google sign-in failed:", err);
      if (err.code === "auth/popup-closed-by-user") {
        setAuthError("Sign-in popup was closed. Please try again.");
      } else if (err.code === "auth/popup-blocked") {
        setAuthError("Pop-up blocked by your browser. Please allow pop-ups for this site.");
      } else {
        setAuthError(err.message || "Sign-in failed. Please try again.");
      }
    }
  };

  const handleCommunitySelect = async (communityName) => {
    setSaving(true);
    try {
      await updateCommunity(communityName);
      // AuthProvider will re-render with communityId set → App.jsx will show main app
    } catch (err) {
      console.error("Failed to join community:", err);
      setSaving(false);
    }
  };

  return (
    <div className="screen" id="login-screen" style={{ justifyContent: "center", padding: "24px" }}>
      <div className="glass-card login-card">

        {/* ── Branding ── */}
        <div className="login-header">
          <h1 className="login-title">Confi<span className="brand-dot" aria-hidden="true" /></h1>
          <p className="login-subtitle">
            Hyper-local anonymous drops.
          </p>
        </div>

        {!user ? (
          /* ── Step 1: Google Sign-In ── */
          <div className="login-step">
            <p className="login-desc">
              Sign in to join a community. Your confessions and reactions will always remain <strong>100% anonymous</strong>.
            </p>
            <button className="google-sign-in-btn" onClick={handleLogin}>
              <svg viewBox="0 0 24 24" width="20" height="20" style={{ flexShrink: 0 }}>
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/>
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05"/>
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
              </svg>
              Sign in with Google
            </button>
            {authError && (
              <p className="login-error">{authError}</p>
            )}
          </div>
        ) : (
          /* ── Step 2: Community Selection ── */
          <div className="login-step">
            <div className="login-welcome">
              {user.photoURL && (
                <img src={user.photoURL} alt="" className="login-avatar" />
              )}
              <span className="login-welcome-name">Hey, {user.displayName?.split(" ")[0] || "there"}!</span>
            </div>
            <p className="login-desc">
              Where are you dropping? Pick your campus, office, or locality. You can always change this later in Settings.
            </p>
            {saving ? (
              <div style={{ textAlign: "center", padding: "20px" }}>
                <div className="loading-spinner" />
                <span className="loading-text" style={{ marginTop: "8px" }}>Joining…</span>
              </div>
            ) : (
              <CommunityPicker onSelect={handleCommunitySelect} showSkip={true} />
            )}
          </div>
        )}

      </div>
    </div>
  );
}
