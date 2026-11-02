import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export type StudioCandidate = Readonly<
  {
    id: string;
    name: string;
    direction: string;
    revision: number;
    status: "draft" | "chosen";
  }
>;
export type StudioState = {
  version: 1;
  projectRevision: number;
  chosenCandidateId?: string;
  candidates: StudioCandidate[];
};
const dataRoot = process.env.BOUNDARY_FOLIO_DATA_DIR?.trim() ||
  path.join(process.cwd(), "data");
const file = path.join(dataRoot, "studio.json");
let queue = Promise.resolve();
const seed = (): StudioState => ({
  version: 1,
  projectRevision: 1,
  candidates: [
    {
      id: "candidate-aurora",
      name: "Aurora",
      direction:
        "A spare title sequence with a soft amber field and one decisive line.",
      revision: 1,
      status: "draft",
    },
    {
      id: "candidate-current",
      name: "Current",
      direction:
        "A sharp editorial treatment that moves from customer quote to concrete proof.",
      revision: 1,
      status: "draft",
    },
  ],
});
async function load(): Promise<StudioState> {
  try {
    const state = JSON.parse(await readFile(file, "utf8")) as StudioState;
    if (state.version !== 1 || !Array.isArray(state.candidates)) {
      throw new Error("invalid studio state");
    }
    return state;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return seed();
    throw error;
  }
}
async function persist(state: StudioState) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, file);
}
export async function readStudio() {
  return load();
}
export async function updateStudio<Result>(
  change: (state: StudioState) => Result,
): Promise<Result> {
  const run = queue.then(async () => {
    const state = await load();
    const result = change(state);
    await persist(state);
    return result;
  });
  queue = run.then(() => undefined, () => undefined);
  return run;
}
