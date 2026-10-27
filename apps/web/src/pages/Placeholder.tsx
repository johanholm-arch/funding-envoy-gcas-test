import { useDocumentTitle } from "../lib/hooks";

/** An honest placeholder: says what will be here, shows nothing fake. */
export function Placeholder({ title, text }: { title: string; text: string }) {
  useDocumentTitle(title);
  return (
    <div className="page narrow">
      <div className="page-head">
        <span className="eyebrow">Not built yet</span>
        <h1>{title}</h1>
      </div>
      <p className="lede placeholder">{text}</p>
    </div>
  );
}
