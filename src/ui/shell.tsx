"use client";

import styles from "./shell.module.css";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Alert, Button, Label, Select, SideNav } from "@trussworks/react-uswds";
import type { Metadata } from "../server/metadata";
import { ApiError, errorText } from "./api";
import { DemoGate } from "./gate";
import { useData } from "./use-data";

interface AppContextValue {
  metadata: Metadata;
  announce: (message: string) => void;
}
const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const value = useContext(AppContext);
  if (!value) throw new Error("Application context is required");
  return value;
}

function viewFor(path: string) {
  if (
    [
      "/dashboard",
      "/catalog",
      "/reports",
      "/sources",
      "/conflicts",
      "/observations",
      "/work-items",
      "/admin",
    ].some((prefix) => path.startsWith(prefix))
  )
    return "administrator";
  return path.startsWith("/review") ? "contributor" : "requester";
}
const navigation = {
  requester: [
    ["/my", "My requests"],
    ["/new", "New request"],
  ],
  contributor: [["/review", "Review queue"]],
  administrator: [
    ["/dashboard", "Dashboard"],
    ["/admin/requests", "All requests"],
    ["/catalog", "Catalog"],
    ["/reports", "Reports"],
  ],
};

function AppHeader({
  view,
  changeView,
  actorName,
}: {
  view?: string;
  changeView?: (view: string) => void;
  actorName?: string;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <Link className={styles.brand + " app-header__brand"} href="/">
          One Door
        </Link>
        <span>Software and infrastructure requests</span>
        {actorName && (
          <span className={styles.sessionIdentity}>
            Signed in as <strong>{actorName}</strong>
          </span>
        )}
        {view && changeView && (
          <div className={styles.viewControl}>
            <Label htmlFor="demo-view">Choose view</Label>
            <Select
              id="demo-view"
              name="demo-view"
              value={view}
              onChange={(event) => changeView(event.target.value)}
            >
              <option value="requester">Requester</option>
              <option value="contributor">Reviewer</option>
              <option value="administrator">Administrator</option>
            </Select>
          </div>
        )}
      </div>
    </header>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const session = useData<Metadata>("/api/metadata");
  const path = usePathname() || "/my";
  const router = useRouter();
  const [notice, updateNotice] = useState({ message: "", version: 0 });
  function setNotice(message: string) {
    updateNotice((previous) => ({ message, version: previous.version + 1 }));
  }
  const [notes, setNotes] = useState(true);
  const [expired, setExpired] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null);
  const view = viewFor(path);
  useEffect(() => {
    if (notice.message)
      confirmation.current?.scrollIntoView({ block: "start" });
  }, [notice]);
  useEffect(() => {
    const listener = () => setExpired(true);
    window.addEventListener("one-door-session-expired", listener);
    return () =>
      window.removeEventListener("one-door-session-expired", listener);
  }, []);
  function entered() {
    setExpired(false);
    session.refresh();
  }
  function changeView(next: string) {
    setNotice("");
    const destinations: Record<string, string> = {
      requester: "/my",
      contributor: "/review",
      administrator: "/dashboard",
    };
    router.push(destinations[next] ?? "/my");
  }
  const denied =
    expired ||
    (session.error instanceof ApiError && session.error.status === 401);
  if (path === "/")
    return (
      <div className="one-door">
        <AppHeader />
        <main id="main-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    );
  if (denied)
    return (
      <>
        <AppHeader />
        <DemoGate entered={entered} />
      </>
    );
  if (!session.data) return <OpeningSession session={session} />;
  return (
    <AppFrame
      metadata={session.data}
      children={children}
      view={view}
      path={path}
      notice={notice}
      notes={notes}
      setNotice={setNotice}
      setNotes={setNotes}
      changeView={changeView}
      confirmation={confirmation}
    />
  );
}

function AppFrame({
  metadata,
  children,
  view,
  path,
  notice,
  notes,
  setNotice,
  setNotes,
  changeView,
  confirmation,
}: {
  metadata: Metadata;
  children: ReactNode;
  view: ReturnType<typeof viewFor>;
  path: string;
  notice: { message: string; version: number };
  notes: boolean;
  setNotice: (message: string) => void;
  setNotes: (visible: boolean) => void;
  changeView: (view: string) => void;
  confirmation: React.RefObject<HTMLDivElement | null>;
}) {
  return (
    <AppContext.Provider value={{ metadata: metadata, announce: setNotice }}>
      <div className={notes ? "one-door" : "one-door hide-design-notes"}>
        <aside className={styles.demoBanner} aria-label="Demonstration only">
          Demonstration only: inventory, policies and external activity are
          fictional. Use fictional information; submitted requests are shared
          with reviewers.
        </aside>
        <AppHeader
          view={view}
          changeView={changeView}
          actorName={
            metadata.actors.find(
              (actor) => actor.id === metadata.visitor.actorId,
            )?.displayName
          }
        />
        <div className={styles.frame + " app-layout"}>
          <AppNavigation
            view={view}
            path={path}
            notes={notes}
            setNotice={setNotice}
            setNotes={setNotes}
          />
          <main id="main-content" tabIndex={-1}>
            <div
              ref={confirmation}
              id="confirmation"
              className={styles.confirmation}
              role="status"
              aria-live="polite"
            >
              {notice.message && (
                <Alert key={notice.version} type="success" slim>
                  <strong>{notice.message}</strong>
                </Alert>
              )}
            </div>
            {children}
          </main>
        </div>
      </div>
    </AppContext.Provider>
  );
}

function AppNavigation({
  view,
  path,
  notes,
  setNotice,
  setNotes,
}: {
  view: ReturnType<typeof viewFor>;
  path: string;
  notes: boolean;
  setNotice: (message: string) => void;
  setNotes: (visible: boolean) => void;
}) {
  return (
    <aside className={styles.sidebar} aria-label="Main navigation">
      <nav aria-label="Main navigation">
        <SideNav
          items={navigation[view].map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={
                path === href || path.startsWith(href + "/")
                  ? "usa-current"
                  : ""
              }
              onClick={() => setNotice("")}
              aria-current={
                path === href || path.startsWith(href + "/")
                  ? "page"
                  : undefined
              }
            >
              {label}
            </Link>
          ))}
        />
      </nav>
      <p className="muted">
        Your identity stays the same in every view. Your actions are recorded in
        your name.
      </p>
      <Button
        type="button"
        outline
        className="design-notes-toggle"
        aria-pressed={notes}
        onClick={() => setNotes(!notes)}
      >
        {notes ? "Hide design notes" : "Show design notes"}
      </Button>
      {view === "administrator" && (
        <p>
          <Link
            href="/admin/demo"
            aria-current={path === "/admin/demo" ? "page" : undefined}
          >
            Demo controls
          </Link>
        </p>
      )}
    </aside>
  );
}

function OpeningSession({
  session,
}: {
  session: ReturnType<typeof useData<Metadata>>;
}) {
  return (
    <>
      <AppHeader />
      <main id="main-content" className="grid-container padding-y-5">
        <h1>One Door</h1>
        {session.error ? (
          <Alert type="error">
            {errorText(session.error)}
            <Button type="button" onClick={session.refresh}>
              Retry loading
            </Button>
          </Alert>
        ) : (
          <p role="status">Opening demo…</p>
        )}
      </main>
    </>
  );
}
