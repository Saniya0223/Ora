"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext } from "react";
import type { Profile, Sources } from "../lib/types";
import { useResource } from "../lib/data";
import { syncLabel } from "../lib/presentation";
import { Icon } from "./ui";
import { FocusProvider } from "./focus";
const StudentContext = createContext<{
  profile: Profile | null;
  timezone: string;
}>({ profile: null, timezone: "Asia/Kolkata" });
export const useStudent = () => useContext(StudentContext);
export default function Shell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const profile = useResource<{ profile: Profile | null }>("/profile");
  const sources = useResource<Sources>("/sources");
  const p = profile.data?.profile ?? null;
  const source = sources.data?.classroom;
  return (
    <StudentContext.Provider
      value={{ profile: p, timezone: p?.timezone ?? "Asia/Kolkata" }}
    >
      <FocusProvider>
        <a className="skip-link" href="#main">
          Skip to content
        </a>
        <div className="app-frame">
          <header className="app-header">
            <Link className="brand" href="/" aria-label="CampusFlow dashboard">
              <span className="brand-icon">
                <Icon name="calendar" size={25} />
              </span>
              <span>
                <strong>CampusFlow</strong>
                <small>STUDENT PLANNER</small>
              </span>
            </Link>
            <nav aria-label="Main navigation">
              {[
                ["/", "Dashboard"],
                ["/tasks", "Tasks"],
                ["/planner", "Planner"],
                ["/setup", "Add & Setup"],
              ].map(([href, label]) => (
                <Link
                  key={href}
                  href={href}
                  className={pathname === href ? "active" : ""}
                  aria-current={pathname === href ? "page" : undefined}
                >
                  {label}
                </Link>
              ))}
            </nav>
            <div className="header-account">
              <Link
                href="/setup#sources"
                className={`sync-badge ${source?.health === "HEALTHY" && source.sync.status === "SUCCESS" ? "good" : ""}`}
              >
                <span className="status-dot" />
                {source
                  ? syncLabel(source.health, source.sync.status)
                  : sources.error
                    ? "Status unavailable"
                    : "Checking sync"}
              </Link>
              <Link
                href="/setup#profile"
                className="user-menu"
                title="Manage student profile"
              >
                <span className="avatar">
                  {p?.name?.trim().slice(0, 1).toUpperCase() || (
                    <Icon name="cap" size={17} />
                  )}
                </span>
                <span>{p?.name || "Your profile"}</span>
                <span aria-hidden="true">⌄</span>
              </Link>
            </div>
          </header>
          <main id="main" className="main-content">
            {children}
          </main>
          <footer className="app-footer">
            CampusFlow <span>Make room for what matters.</span>
          </footer>
        </div>
      </FocusProvider>
    </StudentContext.Provider>
  );
}
