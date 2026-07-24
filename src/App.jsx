import { BrowserRouter, Routes, Route, NavLink, useLocation } from "react-router-dom";
import AuthProvider, { useAuth } from "./context/AuthProvider";
import ComposeScreen from "./screens/ComposeScreen";
import LiveDropScreen from "./screens/LiveDropScreen";
import VerdictScreen from "./screens/VerdictScreen";

function NavBar() {
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Compose" },
    { path: "/live", label: "Live" },
    { path: "/verdict", label: "Verdict" },
  ];

  const isActive = (path) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="bottom-nav" id="main-nav">
      {navItems.map(({ path, icon, label }) => (
        <NavLink
          key={path}
          to={path}
          className={`nav-item ${isActive(path) ? "active" : ""}`}
          id={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <span className="nav-label">{label}</span>
          <span className="nav-dot" aria-hidden="true" />
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
        <Route path="/verdict/:dropId" element={<VerdictScreen />} />
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
