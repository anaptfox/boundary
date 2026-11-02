import { compareReports, readReport, resolveReportArg } from "./lib.mjs";

const beforePath = resolveReportArg(process.argv[2], "baseline.json");
const afterPath = resolveReportArg(process.argv[3], "current.json");
let rows;
try { rows = compareReports(readReport(beforePath), readReport(afterPath)); }
catch (error) { console.error(error.message); process.exit(1); }

function pct(value) {
  if (!Number.isFinite(value)) return "n/a";
  const signed = value >= 0 ? "+" : "";
  return `${signed}${(value * 100).toFixed(1)}%`;
}

function ns(value) {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}ms`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}µs`;
  return `${Math.round(value)}ns`;
}

console.log(`compare ${beforePath} -> ${afterPath}`);
console.log("Median and p95 summaries are medians across processes; run ranges are observed variation, not confidence intervals.");
for (const row of rows) {
  if (row.status) {
    console.log(`${row.id} ${row.status}`);
    continue;
  }
  console.log(
    `${row.id}  median ${ns(row.before.nsMedian)} -> ${ns(row.after.nsMedian)} (${pct(row.medianDelta)})  p95 ${ns(row.before.nsP95)} -> ${ns(row.after.nsP95)} (${pct(row.p95Delta)})${row.before.processMedianMinNs === undefined ? "" : `  process median range ${ns(row.before.processMedianMinNs)}–${ns(row.before.processMedianMaxNs)} -> ${ns(row.after.processMedianMinNs)}–${ns(row.after.processMedianMaxNs)}`}`,
  );
}
