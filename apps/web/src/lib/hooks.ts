import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "./api";

export interface Resource<T> {
  data: T | undefined;
  error: ApiError | undefined;
  /** True only before the first response; refetches keep showing what is already on screen. */
  loading: boolean;
  refetch: () => Promise<T | undefined>;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

export function useResource<T>(url: string | undefined): Resource<T> {
  const [data, setDataState] = useState<T>();
  const [error, setError] = useState<ApiError>();
  const [loading, setLoading] = useState(Boolean(url));
  const current = useRef(url);
  current.current = url;

  const refetch = useCallback(async () => {
    if (!url) return undefined;
    try {
      const d = await api.get<T>(url);
      if (current.current === url) {
        setDataState(d);
        setError(undefined);
      }
      return d;
    } catch (e) {
      if (current.current === url) setError(e instanceof ApiError ? e : new ApiError(0, String(e), "error"));
      return undefined;
    } finally {
      if (current.current === url) setLoading(false);
    }
  }, [url]);

  useEffect(() => {
    setLoading(Boolean(url));
    setDataState(undefined);
    setError(undefined);
    void refetch();
  }, [refetch, url]);

  return { data, error, loading, refetch, setData: (fn) => setDataState((d) => fn(d)) };
}

/** Run an async action once at a time and keep its error sentence. */
export function useAction() {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const run = useCallback(async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key);
    setError(undefined);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return undefined;
    } finally {
      setBusy(undefined);
    }
  }, []);
  return { busy, error, setError, run };
}

export function useMediaQuery(q: string): boolean {
  const [m, setM] = useState(() => (typeof window !== "undefined" ? window.matchMedia(q).matches : false));
  useEffect(() => {
    const mq = window.matchMedia(q);
    const on = () => setM(mq.matches);
    mq.addEventListener("change", on);
    on();
    return () => mq.removeEventListener("change", on);
  }, [q]);
  return m;
}

export function useDocumentTitle(title: string | undefined) {
  useEffect(() => {
    if (title) document.title = `${title} · FundingEnvoy`;
  }, [title]);
}
