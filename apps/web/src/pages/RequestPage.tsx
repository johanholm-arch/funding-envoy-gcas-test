import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, errorText } from "../lib/api";
import { useMe, useToast } from "../lib/app";
import { plural } from "../lib/format";
import { useDocumentTitle, useMediaQuery, useResource } from "../lib/hooks";
import { isEditable, isStatementCheck, shortDocLabel, docLabel } from "../lib/request";
import type { ActionHint, CheckResult, RequestPayload } from "../lib/types";
import { RequestContext, useRequest, type RequestCtx } from "../components/requestCtx";
import { Conversation } from "../components/Conversation";
import { RequestDocument } from "../components/RequestDocument";
import { MarginNotes } from "../components/MarginNotes";
import { EvidencePane, type EvidenceTarget } from "../components/EvidencePane";

export function RequestPage() {
  const { id = "" } = useParams();
  const { me } = useMe();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const requestor = me.user.kind === "requestor";
  const req = useResource<RequestPayload>(`/api/requests/${id}`);
  const v = req.data;
  const editable = v ? isEditable(v, requestor) : false;
  const [busy, setBusy] = useState<string>();
  const [evidence, setEvidence] = useState<EvidenceTarget>();
  const [editKey, setEditKey] = useState<string>();
  const [addingLine, setAddingLine] = useState(false);
  const formView = params.get("view") === "form";
  const phone = useMediaQuery("(max-width: 899px)");
  const [tab, setTab] = useState<"conversation" | "document">(formView ? "document" : "conversation");
  useDocumentTitle(v ? (v.request.title ?? (v.request.fields.title?.value as string | undefined) ?? "Untitled request") : "Request");

  useEffect(() => {
    const err = (location.state as { uploadError?: string } | null)?.uploadError;
    if (err) toast(`The request was started, but the upload failed: ${err}`, "error");
  }, [location.state, toast]);

  const refetchAll = req.refetch;

  const act = useCallback<RequestCtx["act"]>(async (key, fn, okToast) => {
    setBusy(key);
    try {
      await fn();
      await refetchAll();
      if (okToast) toast(okToast);
      return true;
    } catch (e) {
      toast(errorText(e), "error");
      await refetchAll();
      return false;
    } finally {
      setBusy(undefined);
    }
  }, [refetchAll, toast]);

  const upload = useCallback(async (files: File[], type?: string) => {
    await act(`upload${type ? `:${type}` : ""}`, () => api.upload(`/api/requests/${id}/documents`, files, files.length === 1 ? type : undefined),
      files.length === 1 ? `Uploaded ${files[0]!.name}` : `Uploaded ${files.length} files`);
  }, [act, id]);

  const pick = useCallback((type?: string, accept?: string) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = !type;
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (files.length) void upload(files, type);
    };
    input.click();
  }, [upload]);

  const goTo = useCallback((anchor: string, edit?: string) => {
    if (phone) setTab("document");
    if (edit) setEditKey(edit);
    window.setTimeout(() => {
      const el = document.getElementById(anchor);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.remove("target");
      void el.offsetWidth;
      el.classList.add("target");
      const focusable = el.querySelector<HTMLElement>("input, textarea, select, button");
      focusable?.focus({ preventScroll: true });
    }, phone ? 60 : 0);
  }, [phone]);

  const runHint = useCallback((h: ActionHint, c?: CheckResult) => {
    if (!v) return;
    const [verb, arg] = h.id.split(":") as [string, string | undefined];
    if (verb === "attest") return goTo(arg ? `att-${arg}` : "statements");
    if (h.id === "answer:coi") return goTo("coi");
    if (verb === "answer") {
      const missing = v.progress.missing[0];
      if (missing) return goTo(`field-${missing.key}`, missing.key);
      return goTo("doc-top");
    }
    if (verb === "upload") {
      const type = arg && arg !== "missing" ? arg : undefined;
      const accept = type ? v.documentRequirements.find((d) => d.type === type)?.accept : undefined;
      return pick(type, accept ? [...accept.map((e) => `.${e}`), ".md", ".txt", ".csv"].join(",") : undefined);
    }
    if (h.id === "change:dates") return goTo("field-activity.startDate", "activity.startDate");
    if (h.id === "change:subtype") return goTo("type");
    if (h.id === "change:amount") {
      const total = v.request.budget.reduce((s, l) => s + l.amount, 0);
      void act("amount", () => api.post(`/api/requests/${id}/fields`, { changes: [{ key: "amount.requested", value: total, reason: "Match itemized budget" }] }), "Amount changed to the budget total");
      return;
    }
    if (verb === "reuse" && arg) {
      void act(`reuse:${arg}`, () => api.post(`/api/requests/${id}/documents/reuse`, { type: arg }), "Reused from your earlier request");
      return;
    }
    if (h.id === "add:budget-line") { setAddingLine(true); return goTo("budget"); }
    if (verb === "remove" && c) {
      const line = c.evidence.map((e) => /^Line (\d+)/.exec(e.label)?.[1]).find(Boolean);
      if (line) void act(`remove-${line}`, () => api.post(`/api/requests/${id}/budget`, { removeLine: Number(line) }), `Line ${line} removed`);
    }
  }, [v, goTo, pick, act, id]);

  const docTypes = useMemo(() => new Map((v?.documents ?? []).map((d) => [d.id, d.type])), [v?.documents]);

  if (req.error && !v) {
    return (
      <div className="page narrow">
        <h1>{req.error.status === 404 ? "This request doesn't exist" : "This request didn't open"}</h1>
        <p className="lede">{req.error.message} <Link to="/">Go to your start page</Link>.</p>
      </div>
    );
  }
  if (!v) return <div className="page" aria-busy="true"><p className="muted small">Opening the request…</p></div>;

  const ctx: RequestCtx = {
    id, view: v, editable, requestor, busy, act, upload, pick, openEvidence: setEvidence, goTo, runHint,
    refetch: req.refetch, addingLine, setAddingLine, editKey, setEditKey, docTypeOf: (d) => docTypes.get(d),
  };
  const s = v.summary;
  const toFix = s.mustFix.length;
  const unackedWarn = s.yourCall.filter((c) => !c.acknowledged).length;

  return (
    <RequestContext.Provider value={ctx}>
      <div className="reqview">
      <div className="tabs" role="tablist" aria-label="Request views">
        <button role="tab" type="button" aria-selected={tab === "conversation"} aria-controls="rail" onClick={() => setTab("conversation")}>Conversation</button>
        <button role="tab" type="button" aria-selected={tab === "document"} aria-controls="doc" onClick={() => setTab("document")}>
          Your request {editable && toFix ? <span className="chip block">{toFix} to fix</span> : null}
        </button>
      </div>
      <div className="ws" data-tab={tab}>
        <Conversation />
        <div className="doc-scroll" id="doc">
          <div className="doc-wrap">
            <RequestDocument formView={formView} />
            <MarginNotes />
          </div>
        </div>
      </div>
      {editable && (!phone || tab === "document") ? <Footer toFix={toFix} unacked={unackedWarn} onSave={() => { toast("Saved. Pick up where you left off from My requests."); navigate("/requests"); }} /> : null}
      </div>
      {evidence ? <EvidencePane target={evidence} onClose={() => setEvidence(undefined)} docked={false} /> : null}
    </RequestContext.Provider>
  );
}

function Footer({ toFix, unacked, onSave }: { toFix: number; unacked: number; onSave: () => void }) {
  const { view: v, id, goTo } = useRequest();
  const navigate = useNavigate();
  const info = v.request.infoRequests?.find((i) => i.status === "open");
  const next = upNext(v);
  // readiness comes with the request and has no side effects; the Review screen still calls /preview.
  // /submit also refuses unconfirmed proposed values and undecided "your call" flags, so count those too.
  const proposed = Object.values(v.request.fields).filter((f) => f.status === "proposed").length;
  const can = (v.readiness?.canSubmit ?? false) && !proposed && unacked === 0;
  const left = (v.readiness?.blockers.length ?? 0) + (proposed ? 1 : 0) + unacked;
  const reason = can ? "" : left ? `${plural(left, "thing")} to do before you can submit` : "";
  if (info && v.request.status === "info-requested") {
    return (
      <footer className="footbar">
        <div className="stack" style={{ gap: 2, minWidth: 0 }}>
          <div className="next">Up next: answer the grants team's {plural(info.questions.filter((q) => !q.answer).length, "open question")}</div>
          <div className="muted small why">Only their questions are open. Your answers go to the reviewer with a short note of what changed.</div>
        </div>
        <div className="actions"><button type="button" className="btn" onClick={() => goTo("info")}>Go to the questions</button></div>
      </footer>
    );
  }
  return (
    <footer className="footbar">
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <div className="next">{can ? "Everything is in. Review exactly what will be sent, then submit." : `Up next: ${next || "a few checks"}`}</div>
        <div className="muted small why">
          {can ? "Nothing is sent until you press Submit on the next screen." : `When everything is in, you'll see exactly what will be written to the funder's grants system, in your name, before you submit.${toFix || unacked ? ` ${toFix ? `${toFix} to fix` : ""}${toFix && unacked ? ", " : ""}${unacked ? `${unacked} to decide` : ""}.` : ""}`}
        </div>
      </div>
      <div className="actions">
        <button type="button" className="btn quiet save" onClick={onSave}>Save and come back</button>
        <button type="button" className="btn" disabled={!can} aria-describedby={!can ? "submit-why" : undefined} onClick={() => navigate(`/requests/${id}/review`)}>Review and submit</button>
        {!can && reason ? <span id="submit-why" className="sr-only">{reason}</span> : null}
      </div>
    </footer>
  );
}

/** "purpose · W-9 · 3 conflict questions · your statements" */
export function upNext(v: RequestPayload): string {
  const parts: string[] = [];
  const proposed = Object.values(v.request.fields).filter((f) => f.status === "proposed").length;
  if (proposed) parts.push(`confirm ${plural(proposed, "proposed value")}`);
  for (const f of v.progress.missing.slice(0, 3)) parts.push(f.label.toLowerCase());
  if (v.progress.missing.length > 3) parts.push(`${v.progress.missing.length - 3} more answers`);
  for (const t of v.progress.missingDocs.slice(0, 2)) parts.push(shortDocLabel(docLabel(t, v)));
  if (v.progress.missingDocs.length > 2) parts.push(`${v.progress.missingDocs.length - 2} more documents`);
  const coiLeft = (v.subtype?.coi ?? []).filter((q) => !v.request.coi[q]).length;
  if (coiLeft) parts.push(plural(coiLeft, "conflict question"));
  const decide = v.summary.yourCall.filter((c) => !c.acknowledged).length;
  if (decide) parts.push(plural(decide, "decision", "decisions") + " for you");
  if (v.summary.mustFix.some(isStatementCheck)) parts.push("your statements");
  return parts.length > 5 ? `${parts.slice(0, 5).join(" · ")} · and more` : parts.join(" · ");
}
