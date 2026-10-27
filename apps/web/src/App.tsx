import { useCallback, useEffect, useState } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { api, ApiError, onSessionError } from "./lib/api";
import { MeContext, ToastProvider, hasRole, useMe } from "./lib/app";
import { applyBrand } from "./lib/brand";
import type { Me } from "./lib/types";
import { SignIn } from "./pages/SignIn";
import { Home } from "./pages/Home";
import { NewRequest } from "./pages/NewRequest";
import { RequestPage } from "./pages/RequestPage";
import { Review } from "./pages/Review";
import { Policy } from "./pages/Policy";
import { DeskPage } from "./pages/Desk";
import { TrailPage } from "./pages/Trail";
import { AuditIndex } from "./pages/AuditIndex";
import { Committee } from "./pages/Committee";
import { Agreements } from "./pages/Agreements";
import { AgreementPage } from "./pages/AgreementPage";
import { Disclosure } from "./pages/Disclosure";
import { Studio } from "./pages/Studio";
import { Ask } from "./pages/Ask";
import { Operations } from "./pages/Operations";
import { People, Identity } from "./pages/Access";
import { Refusal } from "./pages/Refusal";

export function App() {
  const [me, setMe] = useState<Me | null | undefined>(undefined); // undefined = loading, null = signed out
  const [refused, setRefused] = useState<string>();
  const navigate = useNavigate();
  const location = useLocation();

  const refresh = useCallback(async () => {
    try {
      const m = await api.get<Me>("/api/me", { quiet401: true });
      setMe(m);
      applyBrand(m.tenant?.brand?.color);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setMe(null);
      else setMe(null);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => onSessionError((e) => {
    if (e.status === 401) {
      setMe(null);
      navigate(`/sign-in?next=${encodeURIComponent(location.pathname)}`, { replace: true });
    } else if (e.code === "G2") setRefused(e.message);
  }), [navigate, location.pathname]);

  const signOut = useCallback(async () => {
    try { await api.post("/api/auth/logout"); } catch { /* signed out either way */ }
    setMe(null);
    setRefused(undefined);
    applyBrand(undefined);
    navigate("/sign-in", { replace: true });
  }, [navigate]);

  if (me === undefined) return <div className="shell" aria-busy="true" />;

  if (me === null) {
    return (
      <ToastProvider>
        <Routes>
          <Route path="*" element={<SignIn onSignedIn={async () => { await refresh(); const next = new URLSearchParams(location.search).get("next"); navigate(next && next.startsWith("/") ? next : "/", { replace: true }); }} />} />
        </Routes>
      </ToastProvider>
    );
  }

  return (
    <MeContext.Provider value={{ me, refresh, signOut }}>
      <ToastProvider>
        <Shell refused={Boolean(refused)}>
          {refused ? <Refusal message={refused} /> : (
            <Routes>
              <Route path="/" element={<Navigate to={homeFor(me)} replace />} />
              <Route path="/sign-in" element={<Navigate to={homeFor(me)} replace />} />
              {/* Requestor */}
              <Route path="/requests" element={<Home />} />
              <Route path="/requests/new" element={<NewRequest />} />
              <Route path="/requests/:id" element={<RequestPage />} />
              <Route path="/requests/:id/review" element={<Review />} />
              <Route path="/requests/:id/trail" element={<TrailPage />} />
              <Route path="/requests/:id/agreement" element={<AgreementPage />} />
              <Route path="/policy" element={<Policy />} />
              {/* Funder staff */}
              <Route path="/desk" element={<DeskPage />} />
              <Route path="/desk/:id" element={<DeskPage />} />
              <Route path="/committee" element={<Committee />} />
              <Route path="/committee/:id" element={<Committee />} />
              <Route path="/agreements" element={<Agreements />} />
              <Route path="/agreements/:id" element={<Agreements />} />
              <Route path="/disclosure" element={<Disclosure />} />
              <Route path="/ask" element={<Ask />} />
              <Route path="/studio" element={<Studio />} />
              <Route path="/studio/:kind" element={<Studio />} />
              <Route path="/ops" element={<Operations />} />
              <Route path="/people" element={<People />} />
              <Route path="/identity" element={<Identity />} />
              <Route path="/audit" element={<AuditIndex />} />
              <Route path="/audit/:id" element={<TrailPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          )}
        </Shell>
      </ToastProvider>
    </MeContext.Provider>
  );
}

export function homeFor(me: Me): string {
  if (me.user.kind === "requestor") return "/requests";
  if (me.user.kind === "operator") return "/ops";
  const r = me.user.roles;
  if (r.length === 1 && r[0] === "access-admin") return "/people";
  if (r.includes("process-owner")) return "/studio";
  if (r.includes("finance") || r.includes("tax")) return "/agreements";
  if (r.includes("legal")) return "/agreements";
  if (r.includes("committee-chair") || (r.includes("committee-member") && !r.includes("coordinator"))) return "/committee";
  if (r.includes("compliance-auditor")) return "/audit";
  return "/desk";
}

function NotFound() {
  return (
    <div className="page narrow">
      <h1>This page doesn't exist</h1>
      <p className="lede">The link may be old, or the request isn't shared with you. <NavLink to="/">Go to your start page</NavLink>.</p>
    </div>
  );
}

function Shell({ children, refused }: { children: React.ReactNode; refused?: boolean }) {
  const { me, signOut } = useMe();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const requestor = me.user.kind === "requestor";
  const accessOnly = me.user.roles.length > 0 && me.user.roles.every((r) => r === "access-admin");
  const seat = requestor ? "Funding" : me.user.kind === "operator" ? "Operations" : accessOnly ? "Access" : hasRole(me, "compliance-auditor") && !hasRole(me, "coordinator") ? "Compliance" : "Grants desk";
  const word = (me.tenant?.words?.request ?? "Request").toLowerCase();
  const funding = [
    { to: "/desk", label: "Desk" }, { to: "/committee", label: "Committee" }, { to: "/agreements", label: "Agreements & payments" },
    { to: "/disclosure", label: "Disclosure" }, { to: "/ask", label: "Ask" }, { to: "/studio", label: "Studio" }, { to: "/audit", label: "Audit" },
  ];
  const nav: { to: string; label: string; end?: boolean }[] = refused ? [] : requestor
    ? [{ to: "/requests", label: `My ${word}s`, end: true }, { to: "/requests/new", label: `New ${word}` }, { to: "/policy", label: "Policy" }]
    : accessOnly ? [{ to: "/people", label: "People" }, { to: "/identity", label: "Single sign-on" }]
    : me.user.kind === "operator" ? [{ to: "/ops", label: "Operations" }, ...(me.tenant ? funding : [])]
    : [...funding, ...(me.user.roles.includes("access-admin") ? [{ to: "/people", label: "People" }] : [])];
  const who = requestor ? [me.user.name, me.organization?.name].filter(Boolean).join(" · ") : me.user.name;
  return (
    <div className="shell">
      <a className="skip" href="#main">Skip to content</a>
      <header className={`topbar ${open ? "open" : ""}`}>
        <div className="topbar-left">
          <NavLink to="/" className="brand">{me.user.kind === "operator" && !me.tenant ? "FundingEnvoy" : me.tenant?.brand?.logoText ?? me.tenant?.name ?? "FundingEnvoy"} <span className="seat">· {seat}</span></NavLink>
          <nav className="nav" aria-label="Main" id="main-nav">
            {nav.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end ?? false}>{n.label}</NavLink>
            ))}
            <button type="button" className="linkbtn nav-signout" onClick={() => void signOut()}>Sign out · {me.user.name}</button>
          </nav>
        </div>
        <div className="topbar-right">
          {me.tenant?.demo ? <span className="demo-flag" title="Fictional people and data">Demo</span> : null}
          <span className="who" title={[me.user.name, me.user.title].filter(Boolean).join(" · ")}>{who}</span>
          <button type="button" className="btn small quiet bar-signout" onClick={() => void signOut()}>Sign out</button>
          <button type="button" className="btn small quiet menu-btn" aria-expanded={open} aria-controls="main-nav" onClick={() => setOpen((o) => !o)}>Menu</button>
        </div>
      </header>
      <main id="main" className="main" tabIndex={-1}>{children}</main>
    </div>
  );
}
