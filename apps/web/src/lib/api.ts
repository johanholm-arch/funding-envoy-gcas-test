// A small fetch wrapper. Errors carry the API's sentence and code so screens can show them as written.

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code: string,
    public readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
  }
}

type Listener = (e: ApiError) => void;
const listeners = new Set<Listener>();
/** Screens subscribe to session-level failures: 401 (sign in again) and 403 G2 (commercial role refused). */
export function onSessionError(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request<T>(method: string, url: string, body?: unknown, opts: { quiet401?: boolean } = {}): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin", headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  } else if (method === "POST") {
    init.body = "{}";
    (init.headers as Record<string, string>)["content-type"] = "application/json";
  }
  let res: Response;
  try {
    res = await fetch(url, init);
  } catch {
    throw new ApiError(0, "Can't reach FundingEnvoy. Check your connection and try again.", "network");
  }
  const data = await parse(res);
  if (!res.ok) {
    const d = (data ?? {}) as { error?: string; code?: string; issues?: { path: string; message: string }[] };
    const err = new ApiError(res.status, d.error ?? defaultMessage(res.status), d.code ?? String(res.status), d.issues ?? []);
    if ((res.status === 401 && !opts.quiet401) || (res.status === 403 && err.code === "G2")) listeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

function defaultMessage(status: number): string {
  if (status === 401) return "Please sign in.";
  if (status === 403) return "You don't have access to this.";
  if (status === 404) return "This doesn't exist, or it isn't shared with you.";
  if (status >= 500) return "Something went wrong on our side. It has been logged; try again in a moment.";
  return "That didn't work. Try again.";
}

export const api = {
  get: <T>(url: string, opts?: { quiet401?: boolean }) => request<T>("GET", url, undefined, opts),
  post: <T = { ok: boolean }>(url: string, body?: unknown) => request<T>("POST", url, body),
  upload: <T = { ok: boolean; files: number }>(url: string, files: File[], type?: string) => {
    const fd = new FormData();
    if (type) fd.append("type", type); // the API reads the type field before the file parts
    for (const f of files) fd.append("file", f, f.name);
    return request<T>("POST", url, fd);
  },
};

/** Human sentence for an error, including field issues from validation. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.issues.length) return `${e.message} ${e.issues.map((i) => `${i.path || "value"}: ${i.message}`).join("; ")}`;
    return e.message;
  }
  return e instanceof Error ? e.message : "That didn't work. Try again.";
}
