import { Suspense } from "react";
import { chooseCandidate, createCandidate, editCandidate } from "./actions";
import { studioCaller } from "../../lib/studio-boundary";
import styles from "./studio.module.css";

async function StudioPageContent(
  { searchParams }: {
    searchParams: Promise<{ notice?: string; left?: string; right?: string }>;
  },
) {
  const query = await searchParams;
  const caller = studioCaller(() => ({ role: "maker" as const }));
  const studio = await caller.read.view({});
  const comparison = query.left && query.right
    ? await caller.read.compare({
      leftId: query.left,
      rightId: query.right,
    }).catch(() => null)
    : null;
  return (
    <main className={styles.shell}>
      <header>
        <p>CREATIVE STUDIO · APP-OWNED CANDIDATES</p>
        <h1>Make a clear choice.</h1>
        <span>Project revision {studio.projectRevision}</span>
      </header>
      {query.notice === "uncertain" && (
        <p className={styles.notice} role="alert">
          Outcome unknown. No interaction was retried.
        </p>
      )}
      <section className={styles.new}>
        <form action={createCandidate}>
          <h2>New direction</h2>
          <label>
            Name<input name="name" required minLength={2} />
          </label>
          <label>
            Direction<textarea name="direction" required minLength={12} />
          </label>
          <button>Create candidate through Boundary</button>
        </form>
        <aside>
          Comparison reads two stored candidates. Choosing uses one explicit
          local reviewer fixture and the exact project revision.
        </aside>
      </section>
      <form className={styles.compare} method="get">
        <label>
          Left<select name="left" defaultValue={query.left}>
            {studio.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Right<select name="right" defaultValue={query.right}>
            {studio.candidates.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <button>Compare stored candidates</button>
      </form>
      {comparison && (
        <output className={styles.contrast}>{comparison.contrast}</output>
      )}
      <section className={styles.board}>
        {studio.candidates.map((candidate) => (
          <article
            key={candidate.id}
            className={candidate.status === "chosen" ? styles.selected : ""}
          >
            <p>{candidate.status}</p>
            <h2>{candidate.name}</h2>
            <p>{candidate.direction}</p>
            <form action={editCandidate}>
              <input type="hidden" name="id" value={candidate.id} />
              <input type="hidden" name="revision" value={candidate.revision} />
              <label>
                Draft edit<textarea
                  name="direction"
                  defaultValue={candidate.direction}
                  required
                  minLength={12}
                />
              </label>
              <button>Save draft edit</button>
            </form>
            <form className={styles.choose} action={chooseCandidate}>
              <input type="hidden" name="id" value={candidate.id} />
              <input
                type="hidden"
                name="projectRevision"
                value={studio.projectRevision}
              />
              <button disabled={candidate.status === "chosen"}>
                {candidate.status === "chosen"
                  ? "Current selection"
                  : "Choose with local reviewer fixture"}
              </button>
            </form>
          </article>
        ))}
      </section>
    </main>
  );
}

export default function StudioPage(props: { searchParams: Promise<{ notice?: string; left?: string; right?: string }> }) {
  return <Suspense fallback={<main aria-busy="true">Opening the workspace…</main>}><StudioPageContent {...props} /></Suspense>;
}
