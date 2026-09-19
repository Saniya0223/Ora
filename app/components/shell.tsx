"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useState } from "react";
import type { Profile, Sources } from "../lib/types";
import { useResource } from "../lib/data";
import { useClassroomSync } from "./classroom-sync";
import { syncSummary, timeAgo } from "../lib/source-presentation";
import { Icon } from "./ui";
import { FocusProvider } from "./focus";
import { ProfileForm } from "./planning-settings";
import {
  CalendarDays,
  LayoutDashboard,
  Settings,
  CheckSquare,
  GraduationCap,
  RefreshCw,
  X
} from "lucide-react";

const StudentContext = createContext<{
  profile: Profile | null;
  timezone: string;
}>({ profile: null, timezone: "Asia/Kolkata" });

export const useStudent = () => useContext(StudentContext);

export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [profileOpen, setProfileOpen] = useState(false);
  const profile = useResource<{ profile: Profile | null }>("/profile");
  const sources = useResource<Sources>("/sources");
  const p = profile.data?.profile ?? null;
  const source = sources.data?.classroom;

  const navItems = [
    { href: "/", label: "Dashboard", icon: LayoutDashboard },
    { href: "/tasks", label: "Tasks", icon: CheckSquare },
    { href: "/planner", label: "Planner", icon: CalendarDays },
    { href: "/setup", label: "Add & Setup", icon: Settings },
  ];

  return (
    <StudentContext.Provider
      value={{ profile: p, timezone: p?.timezone ?? "Asia/Kolkata" }}
    >
      <FocusProvider>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app-layout">
          <aside className="app-sidebar">
            <Link className="sidebar-brand" href="/" aria-label="CampusFlow dashboard">
              <div className="brand-icon-new">
                <GraduationCap size={22} strokeWidth={2.5} />
              </div>
              <div className="brand-text">
                <strong>CampusFlow</strong>
              </div>
            </Link>

            <nav className="sidebar-nav" aria-label="Main navigation">
              {navItems.map((item) => {
                const isActive = pathname === item.href || (item.href !== "/" && pathname.startsWith(item.href));
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`sidebar-nav-item ${isActive ? "active" : ""}`}
                    aria-current={isActive ? "page" : undefined}
                  >
                    <item.icon size={18} strokeWidth={isActive ? 2.5 : 2} className="sidebar-nav-icon" />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </nav>

            <div className="sidebar-spacer" style={{ flex: 1 }}></div>

            <div className="sidebar-footer">
              <SidebarSync source={source} unavailable={!!sources.error} />
              <button
                onClick={() => setProfileOpen(true)}
                className="sidebar-user"
                title="Manage student profile"
                style={{ width: '100%', textAlign: 'left', border: 'none', background: 'transparent' }}
              >
                <div className="avatar">
                  {p?.name?.trim().slice(0, 1).toUpperCase() || (
                    <GraduationCap size={16} />
                  )}
                </div>
                <div className="user-info">
                  <span className="user-name">{p?.name || "Your profile"}</span>
                  <span className="user-email">{source?.account?.email || "Student"}</span>
                </div>
              </button>
            </div>
          </aside>
          
          <div className="main-area">
            <main id="main" className={`main-content ${pathname.startsWith('/planner') ? 'wide' : ''}`}>
              {children}
            </main>
          </div>
        </div>
        {profileOpen && (
          <div className="modal-overlay" onClick={() => setProfileOpen(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
            <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: 'var(--paper)', borderRadius: '20px', padding: '24px', maxWidth: '600px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '24px' }}>
                <h2 style={{ fontSize: '20px', margin: 0 }}>Student Profile</h2>
                <button onClick={() => setProfileOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}>
                  <X size={20} />
                </button>
              </div>
              <ProfileForm />
            </div>
          </div>
        )}
      </FocusProvider>
    </StudentContext.Provider>
  );
}

// Syncing Classroom is the core action, so it is one click from every page.
// The wording comes from the same summary as the Connected Sources card.
function SidebarSync({ source, unavailable }: {
  source: Sources["classroom"] | undefined;
  unavailable: boolean;
}) {
  const { syncing: busy, error, sync } = useClassroomSync();
  if (source?.connection !== "CONNECTED")
    return (
      <Link href="/setup#sources" className="sidebar-sync-badge">
        <span className="status-dot" />
        {source ? "Connect Google Classroom" : unavailable ? "Classroom status unavailable" : "Checking Classroom…"}
      </Link>
    );
  const summary = busy
    ? { tone: "busy", title: "Syncing Classroom…", detail: null, changes: [] as string[] }
    : syncSummary(source);
  const last = source.sync.lastSuccessfulSyncAt;
  return (
    <div className={`sidebar-sync ${summary.tone}`}>
      <div className="sidebar-sync-status">
        <span className="status-dot" />
        <span>
          {summary.title}
          {summary.changes.length > 0
            ? <small>{summary.changes.join(" · ")}</small>
            : !busy && last && summary.tone === "ok" && <small>Last synced {timeAgo(last)}</small>}
        </span>
      </div>
      {source.health !== "REAUTH_REQUIRED" ? (
        <button className="button primary small wide" disabled={busy} onClick={() => void sync()}>
          <RefreshCw size={13} className={busy ? "spin" : ""} /> {busy ? "Syncing…" : "Sync now"}
        </button>
      ) : (
        <Link className="button primary small wide" href="/setup#sources">Reconnect</Link>
      )}
      {error && <small className="sidebar-sync-message" role="alert">{error}</small>}
    </div>
  );
}
