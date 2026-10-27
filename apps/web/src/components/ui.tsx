import { useId, useRef, type ReactNode } from "react";
import type { FieldDef } from "../lib/types";
import { humanize } from "../lib/format";

/** A real button that opens the file picker. */
export function FilePick(props: {
  label: ReactNode; onFiles: (files: File[]) => void; multiple?: boolean; accept?: string; className?: string;
  disabled?: boolean; ariaLabel?: string; title?: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  return (
    <>
      <button type="button" className={props.className ?? "btn small"} disabled={props.disabled} aria-label={props.ariaLabel} title={props.title} onClick={() => ref.current?.click()}>
        {props.label}
      </button>
      <input
        ref={ref} type="file" hidden multiple={props.multiple} accept={props.accept}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length) props.onFiles(files);
        }}
      />
    </>
  );
}

export function acceptFor(exts: string[] | undefined): string | undefined {
  // Markdown and plain text are accepted too: the demo documents are text renderings of the originals.
  if (!exts?.length) return undefined;
  return [...exts.map((e) => `.${e}`), ".md", ".txt", ".csv"].join(",");
}

/** The input for one catalogue field, by kind. Value in, value out (already typed). */
export function FieldInput(props: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; id?: string; autoFocus?: boolean; invalid?: boolean }) {
  const { field: f, value, onChange } = props;
  const autoId = useId();
  const id = props.id ?? autoId;
  const common = { id, autoFocus: props.autoFocus, "aria-invalid": props.invalid || undefined } as const;
  switch (f.kind) {
    case "longtext":
      return <textarea {...common} className="textarea" rows={4} value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
    case "number":
    case "money":
      return (
        <input {...common} className="input mono" inputMode="decimal" value={value === undefined || value === null ? "" : String(value)}
          onChange={(e) => {
            const raw = e.target.value.replace(/[^0-9.\-]/g, "");
            onChange(raw === "" ? "" : raw.endsWith(".") ? raw : Number(raw));
          }} />
      );
    case "date":
    case "datetime":
      return <input {...common} className="input" type="date" value={String(value ?? "").slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    case "boolean":
      return (
        <div className="radio-row" role="radiogroup" aria-labelledby={`${id}-l`}>
          {[true, false].map((b) => (
            <button key={String(b)} type="button" className="opt" role="radio" aria-checked={value === b} aria-pressed={value === b} onClick={() => onChange(b)} autoFocus={props.autoFocus && b}>
              {b ? "Yes" : "No"}
            </button>
          ))}
        </div>
      );
    case "enum":
      return (
        <select {...common} className="select" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}>
          <option value="" disabled>Choose…</option>
          {(f.options ?? []).map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
          {value && !(f.options ?? []).includes(String(value)) ? <option value={String(value)}>{String(value)}</option> : null}
        </select>
      );
    default:
      return <input {...common} className="input" value={Array.isArray(value) ? value.join(", ") : String(value ?? "")} onChange={(e) => onChange(e.target.value)} />;
  }
}

export function isEmpty(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

export function ErrorLine({ text }: { text?: string }) {
  if (!text) return null;
  return <p className="error-text" role="alert">{text}</p>;
}

export function Loading({ label = "Loading" }: { label?: string }) {
  return <p className="muted small" aria-live="polite">{label}…</p>;
}
