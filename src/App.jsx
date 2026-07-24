import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
import AuthProvider, { useAuth } from "./context/AuthProvider";
import ComposeScreen from "./screens/ComposeScreen";
import LiveDropScreen from "./screens/LiveDropScreen";
import VerdictScreen from "./screens/VerdictScreen";

function NavBar() {
  const location = useLocation();

  const navItems = [
    { path: "/", icon: "✍️", label: "Compose" },
    { path: "/live", icon: "📡", label: "Live Drop" },
    { path: "/verdict", icon: "⚖️", label: "Verdict" },
  ];

  return (
    <nav className="bottom-nav" id="main-nav">
      {navItems.map(({ path, icon, label }) => (
        <NavLink
          key={path}
          to={path}
          className={`nav-item ${location.pathname === path ? "active" : ""}`}
          id={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <span className="nav-icon">{icon}</span>
          <span>{label}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function AppShell() {
  const { loading } = useAuth();

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <span className="loading-text">Signing in anonymously…</span>
      </div>
    );
  }

  return (
    <>
      <Routes>
        <Route path="/" element={<ComposeScreen />} />
        <Route path="/live" element={<LiveDropScreen />} />
        <Route path="/verdict" element={<VerdictScreen />} />
      </Routes>
      <NavBar />
    </>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </BrowserRouter>
  );
}
