import type { AgentId } from "./agents";

/** Small room-addressing conventions, not a general natural-language parser.
 * These choose a speaker only; they can never authorize a document interaction. */
export function addressedParticipants(text: string): AgentId[] {
  const result: AgentId[] = [];
  const add = (name: string | undefined) => {
    if ((name === "scout" || name === "editor") && !result.includes(name)) result.push(name);
  };
  const prose = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`]*`/g, "")
    .replace(/^\s*>.*$/gm, "").replace(/"[^"\n]*"|“[^”\n]*”/g, "")
    .replace(/’/g, "'").toLowerCase();
  for (const part of prose.split(/\n+|(?<=[.!?;])\s+|,\s*(?:then|and)\s+|\s+then\s+(?=(?:invite|ask|bring|loop|have|get)\b)/)) {
    let clause = part.trim().replace(/^[-*]\s+/, "");
    const address = clause.match(/^(?:hey\s+|hi\s+|please\s+)?@?(scout|editor)(?:\s*(?:,|and|&)\s*@?(scout|editor))?(?:\s*[,!:]|\s+(?:please|can|could|would|will|help|suggest|write|draft|review)\b|\s*$)/);
    if (address) { add(address[1]); add(address[2]); clause = clause.slice(address[0].length).trim(); }
    const question = clause.match(/^(?:please\s+)?(?:can|could|would|will)\s+@?(scout|editor)\b/);
    if (question) add(question[1]);
    const invitation = clause.match(/^(?:(?:please|now)\s+|(?:can|could|would|will) you\s+)?(?:ask(?:ing|ed)?|invit(?:e|ing|ed)|bring(?:ing)?(?: in)?|loop(?:ing)?(?: in)?|get|have)\s+(?:the\s+)?@?(scout|editor)\b/);
    if (invitation) add(invitation[1]);
  }
  return result;
}
