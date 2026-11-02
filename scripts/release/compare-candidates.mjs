// Fail unless two independently built candidates are byte-identical.
import path from "node:path";
import { compareCandidates } from "./candidate.ts";

const [left, right] = process.argv.slice(2);
if (!left || !right) throw new Error("usage: compare-candidates.mjs LEFT RIGHT");
const candidate = await compareCandidates(path.resolve(left), path.resolve(right));
process.stdout.write(`${JSON.stringify({ reproducible: true, candidate }, null, 2)}\n`);
