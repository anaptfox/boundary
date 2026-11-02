import { Suspense } from "react";
import { cookies } from "next/headers";
import {
  createTicket,
  delegateTicket,
  recordReview,
  resolveTicket,
} from "./actions";
import { triageCaller } from "../../lib/triage-boundary";
import styles from "./triage.module.css";

async function TriagePageContent(
  { searchParams }: { searchParams: Promise<{ notice?: string }> },
) {
  const notice = (await searchParams).notice;
  const tenant = (await cookies()).get("boundary_triage_tenant")?.value;
  if (tenant !== "acme" && tenant !== "harbor") {
    return (
      <main className={styles.shell}>
        <h1>Ticket triage</h1>
        <p>Choose a local tenant fixture.</p>
        <section className={styles.pick}>
          <form action="/triage/tenant" method="post">
            <button name="tenant" value="acme">Open Acme triage</button>
          </form>
          <form action="/triage/tenant" method="post">
            <button name="tenant" value="harbor">Open Harbor triage</button>
          </form>
        </section>
      </main>
    );
  }
  const tickets = await triageCaller(() => ({
    tenant,
    actor: "human" as const,
  })).read.list({});
  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <div>
          <p className={styles.kicker}>
            INTERACTIONS DESK · {tenant.toUpperCase()}
          </p>
          <h1>Ticket triage</h1>
          <p>
            Tenant identity is server-derived; the investigator is a local
            deterministic fixture.
          </p>
        </div>
      </header>
      {notice === "uncertain" && (
        <p className={styles.notice} role="alert">
          Outcome unknown. No interaction was retried.
        </p>
      )}
      <section className={styles.grid}>
        <form className={styles.card} action={createTicket}>
          <h2>New intake</h2>
          <label>
            Issue<input name="title" required minLength={4} />
          </label>
          <label>
            Customer<input name="customer" required minLength={2} />
          </label>
          <button>Create ticket through Boundary</button>
        </form>
        <section className={styles.list}>
          {tickets.map((ticket) => (
            <article className={styles.ticket} key={ticket.id}>
              <p className={styles.label}>{ticket.id} · {ticket.customer}</p>
              <h2>{ticket.title}</h2>
              <span className={`${styles.status} ${styles[ticket.status]}`}>
                {ticket.status}
              </span>
              {ticket.evidence && (
                <div className={styles.evidence}>
                  <p>
                    <strong>Local deterministic investigator</strong>
                    {ticket.evidence.investigator}
                  </p>
                  <p>
                    <strong>Finding</strong>
                    {ticket.evidence.finding}
                  </p>
                  <p>
                    <strong>References</strong>
                    {ticket.evidence.references.join(", ")}
                  </p>
                  <p>
                    <strong>Delegator</strong>
                    {ticket.evidence.delegator}
                  </p>
                </div>
              )}
              {ticket.status === "new" && (
                <form action={delegateTicket}>
                  <input type="hidden" name="id" value={ticket.id} />
                  <input
                    type="hidden"
                    name="revision"
                    value={ticket.revision}
                  />
                  <label>
                    Investigator<select name="agent" defaultValue="signal-lens">
                      <option value="signal-lens">Signal Lens</option>
                      <option value="runbook-reader">Runbook Reader</option>
                    </select>
                  </label>
                  <button>Delegate investigation</button>
                </form>
              )}
              {ticket.status === "investigating" && !ticket.pendingReview && (
                <form className={styles.resolve} action={recordReview}>
                  <input type="hidden" name="id" value={ticket.id} />
                  <input
                    type="hidden"
                    name="revision"
                    value={ticket.revision}
                  />
                  <label>
                    Local reviewer fixture: app-owned CAS review<textarea
                      name="resolution"
                      required
                      minLength={8}
                    />
                  </label>
                  <button>Record exact review</button>
                </form>
              )}
              {ticket.pendingReview && (
                <div className={styles.evidence}>
                  <p>
                    <strong>Stored review {ticket.pendingReview.id}</strong>
                    {ticket.pendingReview.resolution}
                  </p>
                  <p>
                    <strong>Reviewer</strong>
                    {ticket.pendingReview.reviewer}
                  </p>
                  <form action={resolveTicket}>
                    <input type="hidden" name="id" value={ticket.id} />
                    <input
                      type="hidden"
                      name="reviewId"
                      value={ticket.pendingReview.id}
                    />
                    <button>Resolve from stored review</button>
                  </form>
                </div>
              )}
              {ticket.resolution && (
                <p className={styles.resolution}>{ticket.resolution}</p>
              )}
            </article>
          ))}
        </section>
      </section>
    </main>
  );
}

export default function TriagePage(props: { searchParams: Promise<{ notice?: string }> }) {
  return <Suspense fallback={<main aria-busy="true">Opening the workspace…</main>}><TriagePageContent {...props} /></Suspense>;
}
