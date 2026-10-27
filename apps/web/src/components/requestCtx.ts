import { createContext, useContext } from "react";
import type { ActionHint, CheckResult, Preview, RequestPayload } from "../lib/types";
import type { EvidenceTarget } from "./EvidencePane";

export interface RequestCtx {
  id: string;
  view: RequestPayload;
  preview?: Preview;
  editable: boolean;
  requestor: boolean;
  busy?: string;
  /** Run a write, then refetch so the screen reflects the ledger. Returns false on error (already toasted). */
  act: (key: string, fn: () => Promise<unknown>, okToast?: string) => Promise<boolean>;
  upload: (files: File[], type?: string) => Promise<void>;
  /** Open the file picker (from a click) and upload what is chosen, with an optional document type. */
  pick: (type?: string, accept?: string) => void;
  openEvidence: (t: EvidenceTarget) => void;
  goTo: (anchor: string, edit?: string) => void;
  runHint: (h: ActionHint, c?: CheckResult) => void;
  editKey?: string;
  setEditKey: (k: string | undefined) => void;
  docTypeOf: (documentId: string) => string | undefined;
}

export const RequestContext = createContext<RequestCtx | undefined>(undefined);
export function useRequest(): RequestCtx {
  const c = useContext(RequestContext);
  if (!c) throw new Error("useRequest outside RequestPage");
  return c;
}
