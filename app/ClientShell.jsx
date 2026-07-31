"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "../src/context/AuthProvider";
import { useDrop } from "../src/context/DropContext";
import LoginScreen from "../src/screens/LoginScreen";

function NavBar() {
  const pathname = usePathname();

  const isActive = (path) => {
    if (path === "/") return pathname === "/";
    return pathname.startsWith(path);
  };

  const navItems = [
    {
      path: "/",
      label: "Compose",
      icon: (active) => (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
        </svg>
      ),
    },
    {
      path: "/live",
      label: "Live",
      icon: (active) => (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M4.93 19.07A10 10 0 0 1 2 12C2 6.48 6.48 2 12 2s10 4.48 10 10a10 10 0 0 1-2.93 7.07" />
          <path d="M8.46 15.54A5 5 0 0 1 7 12a5 5 0 0 1 10 0 5 5 0 0 1-1.46 3.54" />
          <circle cx="12" cy="12" r="2" />
        </svg>
      ),
    },
    {
      path: "/verdict",
      label: "Verdict",
      icon: (active) => (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
          <line x1="9" y1="13" x2="15" y2="13" />
          <line x1="9" y1="17" x2="13" y2="17" />
        </svg>
      ),
    },
    {
      path: "/fame",
      label: "Fame",
      icon: (active) => (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6" />
          <path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18" />
          <path d="M4 22h16" />
          <path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20 7 22" />
          <path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20 17 22" />
          <path d="M18 2H6v7a6 6 0 0 0 12 0V2z" />
        </svg>
      ),
    },
    {
      path: "/settings",
      label: "Settings",
      icon: (active) => (
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={active ? 2.6 : 1.8} strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      ),
    },
  ];

  return (
    <nav className="bottom-nav" id="main-nav">
      {navItems.map(({ path, label, icon }) => {
        const active = isActive(path);
        return (
          <Link
            href={path}
            key={path}
            className={`nav-item ${active ? "active" : ""}`}
            id={`nav-${label.toLowerCase().replace(/\s+/g, "-")}`}
            aria-label={label}
          >
            <span className="nav-icon">{icon(active)}</span>
            <span className="nav-dot" aria-hidden="true" />
          </Link>
        );
      })}
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

function DropAutoNav() {
  const { pendingDrop, pendingVerdict, consumeVerdict, consumeDrop, isComposing } = useDrop();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!pendingDrop) return;
    if (isComposing) return;
    if (pathname.startsWith("/verdict")) return;
    if (pathname === "/live") {
      consumeDrop();
      return;
    }

    consumeDrop();
    router.replace("/live");
  }, [pendingDrop, isComposing, pathname, router, consumeDrop]);

  useEffect(() => {
    if (!pendingVerdict) return;

    const verdictId = pendingVerdict.id;
    consumeVerdict();
    router.replace(`/verdict/${verdictId}`);
  }, [pendingVerdict, consumeVerdict, router]);

  return null;
}

export default function ClientShell({ children }) {
  const { user, loading } = useAuth();

  useEffect(() => {
    try {
      const saved = localStorage.getItem("verdict-settings");
      if (saved) {
        const settings = JSON.parse(saved);
        document.documentElement.dataset.theme = settings.darkMode ? "dark" : "light";
      }
    } catch {}
  }, []);

  if (loading) {
    return (
      <div className="loading-screen">
        <div className="loading-spinner" />
        <span className="loading-text">Loading…</span>
      </div>
    );
  }

  if (!user || !user.communityId) {
    return <LoginScreen />;
  }

  return (
    <div className="app-canvas">
      <Header />
      <DropAutoNav />
      {children}
      <NavBar />
    </div>
  );
}
