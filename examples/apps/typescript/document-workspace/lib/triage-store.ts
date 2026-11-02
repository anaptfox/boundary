import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export type TriageTenant = "acme" | "harbor";
export type Investigator = "signal-lens" | "runbook-reader";
export type TriageEvidence = Readonly<{
  investigator: Investigator;
  delegator: string;
  finding: string;
  references: string[];
  reviewedBy?: string;
}>;
export type TriageTicket = Readonly<{
  id: string;
  title: string;
  customer: string;
  status: "new" | "investigating" | "resolved";
  revision: number;
  evidence?: TriageEvidence;
  resolution?: string;
}>;
export type TriageReview = Readonly<{
  id: string;
  ticketId: string;
  expectedRevision: number;
  resolution: string;
  reviewer: string;
}>;
export type TriageState = {
  version: 1;
  tickets: TriageTicket[];
  reviews: TriageReview[];
};

const dataRoot = process.env.BOUNDARY_FOLIO_DATA_DIR?.trim() ||
  path.join(process.cwd(), "data");
const root = path.join(dataRoot, "triage");
const queues = new Map<TriageTenant, Promise<void>>();
const fileFor = (tenant: TriageTenant) => path.join(root, `${tenant}.json`);

function seed(tenant: TriageTenant): TriageState {
  const ticket = tenant === "acme"
    ? {
      id: "acme-401",
      title: "Invoice export stops at 99%",
      customer: "Northstar",
    }
    : {
      id: "harbor-208",
      title: "Team invite arrived twice",
      customer: "Harbor Labs",
    };
  return {
    version: 1,
    tickets: [{ ...ticket, status: "new", revision: 1 }],
    reviews: [],
  };
}

async function load(tenant: TriageTenant): Promise<TriageState> {
  try {
    const state = JSON.parse(
      await readFile(fileFor(tenant), "utf8"),
    ) as TriageState;
    if (
      state.version !== 1 || !Array.isArray(state.tickets) ||
      !Array.isArray(state.reviews)
    ) throw new Error("invalid triage state");
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return seed(tenant);
    throw error;
  }
}

async function lock<Result>(
  tenant: TriageTenant,
  work: () => Promise<Result>,
): Promise<Result> {
  const pathToLock = `${fileFor(tenant)}.lock`;
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const handle = await open(pathToLock, "wx");
      try {
        return await work();
      } finally {
        await handle.close();
        await unlink(pathToLock).catch(() => undefined);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  throw new Error("triage write remains in progress; outcome is not assumed");
}

async function persist(
  tenant: TriageTenant,
  state: TriageState,
): Promise<void> {
  const target = fileFor(tenant);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, target);
}

export async function readTriage(tenant: TriageTenant) {
  return load(tenant);
}
export async function updateTriage<Result>(
  tenant: TriageTenant,
  change: (state: TriageState) => Result,
): Promise<Result> {
  const prior = queues.get(tenant) ?? Promise.resolve();
  const run = prior.then(() =>
    lock(tenant, async () => {
      const state = await load(tenant);
      const result = change(state);
      await persist(tenant, state);
      return result;
    })
  );
  queues.set(tenant, run.then(() => undefined, () => undefined));
  return run;
}
