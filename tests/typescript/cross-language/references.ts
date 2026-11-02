// Generated from the native Rust fixture by tests/typescript/cross-language/generate.mjs.
// Input/output types only; no declared-error interoperability claim.
import type { InteractionDefinition, InteractionHandle, ProjectedInteractionHandle } from "@foxworth/boundary";
import type { JsonValue } from "@foxworth/boundary/program";

export const references: Readonly<{
  readonly "clearCompleted": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.clearCompleted", null, { readonly "count": string }, Record<string, JsonValue>, 0>>, readonly ["direct"]>;
  readonly "create": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.create", { readonly "title": string }, { readonly "completed": boolean; readonly "id": string; readonly "title": string }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
  readonly "list": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.list", { readonly "filter": "all" | "active" | "completed" }, { readonly "items": ReadonlyArray<{ readonly "completed": boolean; readonly "id": string; readonly "title": string }> }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
  readonly "remove": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.remove", { readonly "id": string }, { readonly "completed": boolean; readonly "id": string; readonly "title": string }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
  readonly "rename": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.rename", { readonly "id": string; readonly "title": string }, { readonly "completed": boolean; readonly "id": string; readonly "title": string }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
  readonly "setAllCompleted": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.setAllCompleted", { readonly "completed": boolean }, { readonly "count": string }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
  readonly "setCompleted": ProjectedInteractionHandle<InteractionHandle<InteractionDefinition<"todos.setCompleted", { readonly "completed": boolean; readonly "id": string }, { readonly "completed": boolean; readonly "id": string; readonly "title": string }, Record<string, JsonValue>, 1>>, readonly ["direct"]>;
}> = Object.freeze({
  "clearCompleted": Object.freeze({ interactionId: "todos.clearCompleted", contractDigest: "sha256:a8402ffaebd4d7e3fcd192c061e42ce4335a89f304983d6936f625a2b3d46952", inputArity: 0, modes: Object.freeze(["direct"] as const) }),
  "create": Object.freeze({ interactionId: "todos.create", contractDigest: "sha256:51fd461bca934b7cf3937cca5eb57e74325c82d2ec60e172bb7ef04f2eecdd6d", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
  "list": Object.freeze({ interactionId: "todos.list", contractDigest: "sha256:29b863d46a935567e2ccb23d7003c2d64b18cc2ae323d8b642d45bf5bc513045", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
  "remove": Object.freeze({ interactionId: "todos.remove", contractDigest: "sha256:ec4c651d39bae8f9d929e589032adeefab87efe72b4fd24fee201bceea82c897", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
  "rename": Object.freeze({ interactionId: "todos.rename", contractDigest: "sha256:70b52183900713ed7f7e4e8f250568fd9768408ad3fd61db4d6beaf7998d641c", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
  "setAllCompleted": Object.freeze({ interactionId: "todos.setAllCompleted", contractDigest: "sha256:326fd2b3e86cec56700dbfa068f525cb1e669ed60ab2c83f8f469c4ab388c81d", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
  "setCompleted": Object.freeze({ interactionId: "todos.setCompleted", contractDigest: "sha256:668afd36961c25700c851f680b9d36d2df1daeb35042a65ccf22b1a6743bd328", inputArity: 1, modes: Object.freeze(["direct"] as const) }),
});
