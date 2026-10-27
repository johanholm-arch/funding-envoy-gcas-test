import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, errorText } from "../lib/api";
import { roleWords } from "../lib/format";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { Persona } from "../lib/types";

interface PersonaList { tenants: { id: string; slug: string; name: string }[]; people: Persona[] }

const DEFAULT_TENANT = "halden";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }) {
  useDocumentTitle("Sign in");
  const [params] = useSearchParams();
  const list = useResource<PersonaList>("/api/demo/personas");
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ demoLink?: string } | undefined>();

  const [funderSlug, setFunderSlug] = useState(DEFAULT_TENANT);
  const [companyEmail, setCompanyEmail] = useState("");
  // Demo tenants only: test fixtures have generated slugs and people without titles.
  const funders = (list.data?.tenants ?? []).filter((t) => (list.data?.people ?? []).some((p) => p.kind === "internal" && p.tenant_id === t.id && p.title));
  const tenant = funders.find((t) => t.slug === funderSlug) ?? funders[0];
  const groups = useMemo(() => {
    const people = list.data?.people ?? [];
    const requestors = people.filter((p) => p.kind === "requestor" && p.title);
    const staff = funders.map((t) => ({ tenant: t, people: people.filter((p) => p.kind === "internal" && p.tenant_id === t.id && p.title) }));
    const operators = people.filter((p) => p.kind === "operator");
    return { requestors, staff, operators };
  }, [list.data]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (params.get("signin") === "expired") setError("That sign-in link has expired or was already used. Ask for a new one below.");
    if (params.get("signin") === "cancelled") setError("Sign-in with your company account was cancelled. Try again, or ask your IT team if it keeps happening.");
  }, [params]);

  async function asPersona(p: Persona) {
    setBusy(p.id);
    setError(undefined);
    try {
      await api.post("/api/auth/demo-login", { userId: p.id, tenantSlug: p.kind === "requestor" ? tenant?.slug : undefined });
      onSignedIn();
    } catch (e) {
      setError(e instanceof ApiError && e.code === "sso-required" ? `${p.name}'s company signs its people in through its own identity provider. Use "Sign in with your company account" with their work email.` : errorText(e));
      setBusy(undefined);
    }
  }

  async function companySignIn(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!/^\S+@\S+\.\S+$/.test(companyEmail)) { setError("Enter your work email address, for example k.osei@halden.example."); return; }
    setBusy("sso");
    const url = `/api/auth/sso/start?email=${encodeURIComponent(companyEmail.trim())}&returnTo=${encodeURIComponent(params.get("next") ?? "/")}`;
    try {
      // Check first, so an unknown domain gets a sentence instead of an error page.
      const r = await fetch(url, { redirect: "manual", credentials: "same-origin" });
      if (r.type === "opaqueredirect" || (r.status >= 300 && r.status < 400)) { window.location.assign(url); return; }
      const d = (await r.json().catch(() => ({}))) as { error?: string; code?: string };
      setError(d.code === "no-idp" ? "Single sign-on isn't set up for that address. Requestors sign in with an email link above; funder staff, check the address with your IT team." : d.error ?? "That didn't work. Try again.");
    } catch {
      setError("Can't reach FundingEnvoy. Check your connection and try again.");
    }
    setBusy(undefined);
  }

  async function sendLink(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError("Enter the email address your organization registered with, for example name@society.org.");
      return;
    }
    setBusy("link");
    try {
      setSent(await api.post<{ sent: boolean; demoLink?: string }>("/api/auth/magic-link", { email, tenantSlug: tenant?.slug ?? DEFAULT_TENANT }));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(undefined);
    }
  }

  return (
    <div className="shell">
      <header className="topbar">
        <div className="topbar-left">
          <span className="brand">FundingEnvoy</span>
        </div>
        <div className="topbar-right"><span className="demo-flag">Demo environment · fictional people and data</span></div>
      </header>
      <main id="main" className="signin">
        <section className="signin-side" aria-labelledby="h-signin">
          <div className="stack" style={{ gap: 10 }}>
            <h1 id="h-signin">Sign in</h1>
            <p className="lede">Requestors sign in with a link sent to their email. Funder staff use their company's single sign-on; in this demo, pick a person instead.</p>
          </div>
          <form className="stack" style={{ gap: 10 }} onSubmit={sendLink} noValidate>
            <label className="label" htmlFor="email">Your email address</label>
            <input id="email" className="input" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.marsh@necs.example.org" aria-describedby="email-help" />
            <p id="email-help" className="help">We'll send a sign-in link that works for 15 minutes.</p>
            <div><button className="btn" type="submit" disabled={busy === "link"}>Email me a sign-in link</button></div>
          </form>
          <form className="stack" style={{ gap: 10, borderTop: "1px solid var(--rule)", paddingTop: 20 }} onSubmit={companySignIn} noValidate>
            <label className="label" htmlFor="company-email">Funder staff: your work email</label>
            <input id="company-email" className="input" type="email" autoComplete="email" value={companyEmail} onChange={(e) => setCompanyEmail(e.target.value)} placeholder="k.osei@halden.example" />
            <div><button className="btn quiet" type="submit" disabled={busy === "sso"}>Sign in with your company account</button></div>
          </form>
          <div aria-live="polite">
            {sent ? (
              sent.demoLink ? (
                <div className="panel calm">
                  <p>Link sent. This is a demo, so it is shown here instead of emailed:</p>
                  <p><a href={sent.demoLink}>Open your sign-in link</a></p>
                </div>
              ) : (
                <p className="small">If that address is registered, a link is on its way. Check your inbox.</p>
              )
            ) : null}
          </div>
          {error ? <p className="error-text" role="alert">{error}</p> : null}
        </section>

        <section className="stack" style={{ gap: 32 }} aria-labelledby="h-personas">
          <div className="stack" style={{ gap: 6 }}>
            <span className="eyebrow">Demo environment</span>
            <h2 id="h-personas">Sign in as someone</h2>
            <p className="muted small">Each person sees the product from their own seat. Everything they do is recorded in the trail.</p>
          </div>
          {list.error ? <p className="error-text">{list.error.message}</p> : null}
          {list.loading ? <p className="muted small">Loading people…</p> : null}
          {funders.length > 1 ? (
            <div className="row">
              <label className="small" htmlFor="funder">Requestors ask</label>
              <select id="funder" className="select small" style={{ width: "auto" }} value={tenant?.slug} onChange={(e) => setFunderSlug(e.target.value)}>
                {funders.map((t) => <option key={t.slug} value={t.slug}>{t.name}</option>)}
              </select>
            </div>
          ) : null}
          <PersonaGroup title="Requestors" note={`External organizations asking ${tenant?.name ?? "for funding"}`} people={groups.requestors} busy={busy} onPick={asPersona}
            meta={(p) => [p.title, p.org_name].filter(Boolean).join(" · ")} />
          {groups.staff.map((g) => (
            <PersonaGroup key={g.tenant.id} title="Funder staff" note={g.tenant.name} people={g.people} busy={busy} onPick={asPersona}
              meta={(p) => [p.title, p.roles.map(roleWords).join(", ")].filter(Boolean).join(" · ")} />
          ))}
          <PersonaGroup title="Operator" note="Managed service" people={groups.operators} busy={busy} onPick={asPersona}
            meta={(p) => p.title ?? "Operator"} />
        </section>
      </main>
    </div>
  );
}

function PersonaGroup(props: { title: string; note?: string; people: Persona[]; busy?: string; onPick: (p: Persona) => void; meta: (p: Persona) => string }) {
  if (!props.people.length) return null;
  return (
    <div className="persona-group">
      <h2>{props.title} {props.note ? <span className="small muted" style={{ fontFamily: "var(--sans)" }}>{props.note}</span> : null}</h2>
      {props.people.map((p) => (
        <button key={p.id} type="button" className="persona" onClick={() => props.onPick(p)} disabled={Boolean(props.busy)} aria-busy={props.busy === p.id || undefined}>
          <span className="pname">{p.name}</span>
          <span className="pmeta">{props.meta(p)}</span>
          <span className="go" aria-hidden="true">{props.busy === p.id ? "Signing in…" : "Sign in"}</span>
        </button>
      ))}
    </div>
  );
}
