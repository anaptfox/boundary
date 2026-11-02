/** Demo-owned collaborators. Names never confer authority. */
export const agents = {
  scout: { name: "Scout", initial: "S", role: "Read & think", interactions: ["documents.get"], introduction: "Finds the signal. Spots gaps, asks good questions, and suggests a direction. Cannot edit the document." },
  editor: { name: "Editor", initial: "E", role: "Shape & write", interactions: ["documents.get", "documents.save", "documents.publish (request only)"], introduction: "Turns the conversation into an actual draft. Your explicit Apply decision saves that exact draft. Can request publication review; only you approve publication." },
} as const;
export type AgentId = keyof typeof agents;
