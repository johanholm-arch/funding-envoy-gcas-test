import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import type { Me, Role } from "./types";

// ─── Signed-in person ───
interface MeCtx {
  me: Me;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}
export const MeContext = createContext<MeCtx | undefined>(undefined);
export function useMe(): MeCtx {
  const c = useContext(MeContext);
  if (!c) throw new Error("useMe outside a signed-in screen");
  return c;
}
export function hasRole(me: Me, ...roles: Role[]): boolean {
  return me.user.kind === "operator" || me.user.roles.some((r) => roles.includes(r));
}
export function assistantName(me: Me | undefined): string {
  return me?.tenant?.words?.assistantName ?? "FundingEnvoy";
}

// ─── Toasts: short confirmations ("Submitted"), announced politely ───
interface Toast { id: number; text: string; kind: "ok" | "error" }
interface ToastCtx { toast: (text: string, kind?: "ok" | "error") => void }
const ToastContext = createContext<ToastCtx>({ toast: () => undefined });
export const useToast = () => useContext(ToastContext).toast;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const n = useRef(0);
  const toast = useCallback((text: string, kind: "ok" | "error" = "ok") => {
    const id = ++n.current;
    setItems((xs) => [...xs.filter((x) => x.text !== text).slice(-1), { id, text, kind }]);
    window.setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === "error" ? 7000 : 3200);
  }, []);
  const value = useMemo(() => ({ toast }), [toast]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>{t.text}</div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
