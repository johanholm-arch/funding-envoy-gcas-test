import { useMe } from "../lib/app";
import { useDocumentTitle } from "../lib/hooks";

/** Gate G2: commercial roles are refused everywhere funding data lives. */
export function Refusal({ message }: { message: string }) {
  useDocumentTitle("No access");
  const { me, signOut } = useMe();
  return (
    <div className="refusal">
      <span className="eyebrow">Platform rule G2 · decisions are separate from sales and marketing</span>
      <h1>Sales and marketing roles cannot see funding requests</h1>
      <p className="lede">
        {me.user.name}, your role at {me.tenant?.name ?? "the company"} is in sales or marketing. Funding requests, their status and the
        decisions on them are kept away from commercial roles so that support is never linked to business. This is set by the platform,
        not by your company, and it can't be switched off.
      </p>
      <p className="muted">If an organization asks you about funding, send them to the public grants page. If you believe your role is recorded wrongly, ask your grants process owner.</p>
      <p className="hash">The API said: {message}</p>
      <div><button type="button" className="btn quiet" onClick={() => void signOut()}>Sign out</button></div>
    </div>
  );
}
