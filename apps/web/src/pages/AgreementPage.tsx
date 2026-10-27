import { Link, useParams } from "react-router-dom";
import { useDocumentTitle, useResource } from "../lib/hooks";
import type { RequestPayload } from "../lib/types";
import { AgreementPanel } from "../components/Downstream";

/** The requestor's view of the agreement: read it, and sign if you are the authorized signer. */
export function AgreementPage() {
  const { id = "" } = useParams();
  const r = useResource<RequestPayload>(`/api/requests/${id}`);
  const title = (r.data?.request.fields.title?.value as string | undefined) ?? r.data?.request.title ?? "Request";
  useDocumentTitle(`Agreement · ${title}`);
  return (
    <div className="page narrow">
      <div className="page-head">
        <span className="eyebrow">{r.data?.request.ref}</span>
        <h1>{title}</h1>
        <p className="small"><Link to={`/requests/${id}`}>Back to the request</Link></p>
      </div>
      <AgreementPanel id={id} onChanged={() => void r.refetch()} />
    </div>
  );
}
