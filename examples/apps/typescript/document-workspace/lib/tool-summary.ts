export function toolSummary(output: unknown): string {
  if (!output || typeof output !== "object") return "No confirmed result.";
  if ("status" in output) {
    if (output.status === "saved" && "revision" in output) return `Saved revision ${output.revision}.`;
    if (output.status === "conflict" && "actualRevision" in output) return `Revision conflict. Current revision: ${output.actualRevision}. No retry.`;
    if (output.status === "rejected") return "Rejected before execution. No change made.";
    if (output.status === "uncertain") return "Outcome unknown. Inspect the saved document before another edit.";
    if (output.status === "not-started") return "Not started. This turn permits no further save attempts.";
  }
  if ("revision" in output && "title" in output) return `Read “${output.title}” at revision ${output.revision}.`;
  return "Tool returned; inspect interaction activity.";
}
