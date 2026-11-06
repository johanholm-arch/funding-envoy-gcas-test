// Talking to a real Salesforce org, read-only: sign in with the OAuth 2.0 client credentials flow of an External
// Client App, then read who we are, the org, its API budget, and how its objects are built. Nothing is written.
// Only addresses on Salesforce's own domains are ever called, so a typed address can't point the server elsewhere.
// FE_SALESFORCE_TEST_BASE (never in production) sends every call to a stand-in server for the tests.

export const API_VERSION = "66.0";
const MY_DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9-]+)*\.my\.salesforce\.com$/;

export class SfLiveError extends Error {
  constructor(public readonly code: string, message: string, public readonly status?: number) { super(message); }
}

export function normalizeDomain(input: string): string {
  const d = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!MY_DOMAIN.test(d)) throw new SfLiveError("bad-domain", "That isn't a Salesforce My Domain address. It ends in .my.salesforce.com, for example yourcompany--test.sandbox.my.salesforce.com or orgfarm-1234-dev-ed.develop.my.salesforce.com. You'll find it in Setup under My Domain.");
  return d;
}

function base(host: string): string {
  const test = process.env.NODE_ENV !== "production" ? process.env.FE_SALESFORCE_TEST_BASE : undefined;
  return test ? test.replace(/\/$/, "") : `https://${host}`;
}

async function call(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    const msg = (e as Error).name === "TimeoutError" ? "Salesforce didn't answer within 20 seconds." : "FundingEnvoy couldn't reach that address. Check the My Domain address, and that this server may connect to Salesforce.";
    throw new SfLiveError("unreachable", msg);
  }
}

// What Salesforce's sign-in errors mean, in plain words.
const TOKEN_ERRORS: [RegExp, string][] = [
  [/invalid_client_id|client identifier invalid/i, "Salesforce doesn't recognise that consumer key. Copy it again from the External Client App (Settings, OAuth settings, Consumer key and secret)."],
  [/invalid client credentials|invalid_client\b/i, "The consumer key and secret don't match. Copy the secret again; it is case-sensitive and has no spaces."],
  [/no client credentials user enabled/i, "The External Client App has no \"Run As\" user for the client credentials flow. In its Policies, enable the client credentials flow and choose the user it runs as."],
  [/client credentials flow.*(not enabled|disabled)|grant type not supported|unsupported_grant_type/i, "The client credentials flow isn't switched on for this External Client App. Turn it on under its OAuth settings and its Policies."],
  [/request not supported on this domain/i, "Use the org's own My Domain address, not login.salesforce.com or test.salesforce.com."],
  [/user hasn.t approved|not approved|app_not_approved/i, "The Run As user isn't allowed to use this app. In the app's Policies, permit that user (or their profile or permission set)."],
  [/ip restricted|restricted ip/i, "Salesforce refused the sign-in because of IP restrictions. Relax IP restrictions in the app's Policies, or add this server's address."],
  [/inactive|frozen/i, "The Run As user is inactive or frozen."],
];

export interface Session { accessToken: string; instanceUrl: string; host: string; issuedAt: string }

export async function signIn(myDomain: string, clientId: string, clientSecret: string): Promise<Session> {
  const host = normalizeDomain(myDomain);
  const body = new URLSearchParams({ grant_type: "client_credentials", client_id: clientId.trim(), client_secret: clientSecret.trim() });
  const r = await call(`${base(host)}/services/oauth2/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body });
  const text = await r.text();
  let j: Record<string, string> = {};
  try { j = JSON.parse(text); } catch { /* not JSON */ }
  if (!r.ok || !j.access_token) {
    const said = `${j.error ?? ""} ${j.error_description ?? text.slice(0, 200)}`.trim();
    const plain = TOKEN_ERRORS.find(([re]) => re.test(said))?.[1] ?? `Salesforce refused the sign-in: ${said || `HTTP ${r.status}`}.`;
    throw new SfLiveError(j.error ?? `http-${r.status}`, plain, r.status);
  }
  // The instance address must be on Salesforce's domains too.
  const inst = (j.instance_url ?? `https://${host}`).replace(/\/$/, "");
  const instHost = inst.replace(/^https:\/\//, "");
  if (!process.env.FE_SALESFORCE_TEST_BASE && !MY_DOMAIN.test(instHost)) throw new SfLiveError("bad-instance", `Salesforce answered with an unexpected address (${inst}); FundingEnvoy won't call it.`);
  return { accessToken: j.access_token, instanceUrl: inst, host: instHost, issuedAt: j.issued_at ?? String(Date.now()) };
}

export class Client {
  calls = 0;
  constructor(private s: Session) {}
  private url(path: string) {
    return `${process.env.NODE_ENV !== "production" && process.env.FE_SALESFORCE_TEST_BASE ? base(this.s.host) : this.s.instanceUrl}${path}`;
  }
  async get<T>(path: string): Promise<T> {
    this.calls++;
    const r = await call(this.url(path), { headers: { authorization: `Bearer ${this.s.accessToken}`, accept: "application/json", "sforce-call-options": "client=FundingEnvoy" } });
    const text = await r.text();
    if (!r.ok) {
      let j: { errorCode?: string; message?: string }[] | undefined;
      try { j = JSON.parse(text); } catch { /* not JSON */ }
      const e = Array.isArray(j) ? j[0] : undefined;
      if (r.status === 401) throw new SfLiveError("INVALID_SESSION_ID", "Salesforce ended the session. Test the connection again.", 401);
      if (r.status === 403 && /API_DISABLED_FOR_ORG/.test(e?.errorCode ?? "")) throw new SfLiveError("API_DISABLED_FOR_ORG", "This Salesforce edition or user doesn't have API access. Use a Developer, Enterprise or Unlimited edition org, and a Run As user with \"API Enabled\".", 403);
      if (r.status === 403 && /REQUEST_LIMIT_EXCEEDED/.test(e?.errorCode ?? "")) throw new SfLiveError("REQUEST_LIMIT_EXCEEDED", "The org has used up its daily API calls. Try again tomorrow.", 403);
      throw new SfLiveError(e?.errorCode ?? `http-${r.status}`, e?.message ?? `Salesforce answered HTTP ${r.status}.`, r.status);
    }
    return JSON.parse(text) as T;
  }
  query<T>(soql: string, tooling = false) {
    return this.get<{ totalSize: number; records: T[] }>(`/services/data/v${API_VERSION}/${tooling ? "tooling/" : ""}query?q=${encodeURIComponent(soql)}`);
  }
}

/** The test: who FundingEnvoy signs in as, which org, which edition, and the API budget left today. */
export async function testOrg(c: Client) {
  const user = await c.get<{ preferred_username?: string; name?: string; organization_id?: string; user_id?: string }>("/services/oauth2/userinfo");
  const org = (await c.query<{ Id: string; Name: string; OrganizationType: string; IsSandbox: boolean; InstanceName: string }>("SELECT Id, Name, OrganizationType, IsSandbox, InstanceName FROM Organization")).records[0];
  const limits = await c.get<{ DailyApiRequests?: { Max: number; Remaining: number } }>(`/services/data/v${API_VERSION}/limits`);
  return {
    org: { id: org?.Id ?? user.organization_id, name: org?.Name ?? "Unknown", edition: org?.OrganizationType ?? "Unknown", sandbox: Boolean(org?.IsSandbox), instance: org?.InstanceName, apiVersion: API_VERSION },
    user: { username: user.preferred_username, name: user.name },
    limits: { DailyApiRequests: limits.DailyApiRequests ?? { Max: 0, Remaining: 0 } },
  };
}

interface DescribeField { name: string; label: string; type: string; length?: number; nillable: boolean; createable: boolean; defaultedOnCreate: boolean; externalId: boolean; referenceTo?: string[]; picklistValues?: { value: string; active: boolean }[]; calculated?: boolean }
interface GlobalObject { name: string; label: string; custom: boolean; queryable: boolean; createable: boolean }

// Objects worth reading: the standard ones a grants app builds on, Salesforce's own Grants Management objects, and
// custom objects whose names suggest grants. A packaged app's objects carry its namespace, e.g. gx__Request__c.
const STANDARD = ["Account", "Contact", "ContentVersion", "IndividualApplication", "FundingAward", "FundingOpportunity", "ApplicationReview", "ApplicationDecision", "Budget"];
const GRANTISH = /grant|request|application|funding|award|payee|disburse|reconcil|donation|sponsor|comment|review/i;

const TYPE_MAP: Record<string, string> = { id: "id", string: "string", textarea: "textarea", currency: "currency", double: "double", percent: "double", int: "int", boolean: "boolean", date: "date", datetime: "datetime", picklist: "picklist", multipicklist: "string", reference: "reference", email: "string", phone: "string", url: "string", combobox: "picklist" };

/** Reads the org's grants-related objects and its active validation rules, in the same shape as the simulated org. */
export async function readOrg(c: Client, myDomain: string) {
  const t = await testOrg(c);
  const global = await c.get<{ sobjects: GlobalObject[] }>(`/services/data/v${API_VERSION}/sobjects`);
  const names = new Set(global.sobjects.map((o) => o.name));
  const custom = global.sobjects.filter((o) => o.custom && o.queryable && o.name.endsWith("__c"));
  const picked = [
    ...STANDARD.filter((n) => names.has(n)),
    ...custom.filter((o) => GRANTISH.test(`${o.name} ${o.label}`)).map((o) => o.name),
  ].slice(0, 25);
  const objects = [];
  for (const name of picked) {
    const d = await c.get<{ name: string; label: string; fields: DescribeField[] }>(`/services/data/v${API_VERSION}/sobjects/${encodeURIComponent(name)}/describe`);
    const g = global.sobjects.find((o) => o.name === name);
    objects.push({
      name, label: g?.label ?? d.label ?? name,
      fields: d.fields.filter((f) => !f.calculated).map((f) => ({
        name: f.name, label: f.label, type: TYPE_MAP[f.type] ?? "string", length: f.length || undefined,
        required: !f.nillable && f.createable && !f.defaultedOnCreate, externalId: f.externalId || undefined,
        picklist: f.picklistValues?.length ? f.picklistValues.filter((p) => p.active).map((p) => p.value) : undefined,
        referenceTo: f.referenceTo?.[0], readOnly: !f.createable || undefined,
      })),
    });
  }
  // Validation rules need the Tooling API and "View Setup and Configuration"; without it the reading still works.
  let validationRules: { object: string; name: string; description: string; errorMessage: string; errorField?: string }[] = [];
  let note: string | undefined;
  try {
    const vr = await c.query<{ ValidationName: string; Description: string | null; ErrorMessage: string | null; ErrorDisplayField: string | null; EntityDefinition?: { QualifiedApiName: string } }>(
      "SELECT ValidationName, Description, ErrorMessage, ErrorDisplayField, EntityDefinition.QualifiedApiName FROM ValidationRule WHERE Active = true", true);
    validationRules = vr.records.filter((r) => picked.includes(r.EntityDefinition?.QualifiedApiName ?? "")).map((r) => ({
      object: r.EntityDefinition?.QualifiedApiName ?? "", name: r.ValidationName, description: r.Description ?? "", errorMessage: r.ErrorMessage ?? "", errorField: r.ErrorDisplayField ?? undefined,
    }));
  } catch (e) {
    note = `Validation rules couldn't be read (${(e as Error).message}). The Run As user needs "View Setup and Configuration" for that.`;
  }
  return {
    org: { name: t.org.name, edition: t.org.edition, apiVersion: API_VERSION, namespace: "", myDomain: normalizeDomain(myDomain), licences: 0, sandbox: t.org.sandbox },
    objects, validationRules, duplicateRules: [] as { object: string; name: string; description: string }[], flows: [] as { name: string; description: string }[],
    found: { totalObjects: global.sobjects.length, customObjects: custom.length, read: picked },
    note,
  };
}
