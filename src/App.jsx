import { useEffect } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  useLocation,
  useNavigate,
} from "react-router-dom";
import AuthProvider, { useAuth } from "./context/AuthProvider";
import DropProvider, { useDrop } from "./context/DropContext";
import ComposeScreen from "./screens/ComposeScreen";
import LiveDropScreen from "./screens/LiveDropScreen";
import VerdictScreen from "./screens/VerdictScreen";
import HallOfFameScreen from "./screens/HallOfFameScreen";
import AdminScreen from "./screens/AdminScreen";

function NavBar() {
  const location = useLocation();

  const navItems = [
    { path: "/", label: "Compose" },
    { path: "/live", label: "Live" },
    { path: "/verdict", label: "Verdict" },
    { path: "/fame", label: "Fame" },
  ];

  const isActive = (path) => {
    if (path === "/") return location.pathname === "/";
    return location.pathname.startsWith(path);
  };

  return (
    <nav className="bottom-nav" id="main-nav">
      {navItems.map(({ path, label }) => (
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

function Header() {
  return (
    <header className="app-top-header" id="app-header">
      <div className="brand-wordmark">
        <span className="brand-name">Confi</span>
        <span className="brand-dot" aria-hidden="true" />
      </div>
      <div className="header-status">
        <span className="status-live-dot" />
        <span className="status-live-text">LIVE</span>
      </div>
    </header>
  );
}

/**
 * Auto-navigates the user to /live when a new drop arrives and the user
 * is not actively composing a confession. This lets users be "pulled in"
 * from any screen — Compose (queued state), Verdict, or just idle.
 */
function DropAutoNav() {
  const { pendingDrop, pendingVerdict, consumeVerdict, isComposing } = useDrop();
  const navigate = useNavigate();
  const location = useLocation();

  // Pull recipients to /live when a drop arrives (if not actively typing)
  useEffect(() => {
    if (!pendingDrop) return;
    if (isComposing) return;
    if (location.pathname === "/live") return;

    navigate("/live", { replace: true });
  }, [pendingDrop, isComposing, location.pathname, navigate]);

  // Pull author to /verdict/:dropId when their confession verdict arrives
  useEffect(() => {
    if (!pendingVerdict) return;

    const verdictId = pendingVerdict.id;
    consumeVerdict();
    navigate(`/verdict/${verdictId}`, { replace: true });
  }, [pendingVerdict, consumeVerdict, navigate]);

  return null;
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
    <div className="app-canvas">
      <Header />
      <DropAutoNav />
      <Routes>
        <Route path="/" element={<ComposeScreen />} />
        <Route path="/live" element={<LiveDropScreen />} />
        <Route path="/verdict" element={<VerdictScreen />} />
        <Route path="/verdict/:dropId" element={<VerdictScreen />} />
        <Route path="/fame" element={<HallOfFameScreen />} />
        <Route path="/admin" element={<AdminScreen />} />
      </Routes>
      <NavBar />
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <DropProvider>
          <AppShell />
        </DropProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
