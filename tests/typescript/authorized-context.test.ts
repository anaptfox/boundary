import { describe, expect, it } from "vitest";
import { bindAuthorizedProjection, compileInteractions, defineInteraction, implementInteractions, installInteractions, projectInteractions, type Projection } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

const Text = portableSchema<string>({ type: "string" });
const definitions = { who: defineInteraction({ id: "authorized.who", output: Text, reads: ["identity"] }) } as const;
type Raw = { readonly token: string };
type Auth = { readonly user: string };

describe("authorized projection context", () => {
  it("narrows admission context before the realization and denies and revokes", async () => {
    const compiled = compileInteractions(definitions);
    const seen: string[] = [];
    const implementations = implementInteractions<typeof definitions, Auth>(definitions, { who: (auth: Auth) => { seen.push(auth.user); return auth.user; } });
    const { installation, controller } = installInteractions<typeof definitions, Auth>(compiled, { installationId: "authorized:1", implementations, realizationIds: { who: { direct: "who:1" } } });
    const projection = projectInteractions(compiled, { who: "direct" });
    type Selected = typeof projection extends Projection<infer S> ? S : never;
    const result = bindAuthorizedProjection<Selected, Raw, Auth>(projection, installation, { admit: ({ context }) => context.token === "ok" ? { decision: "allow", context: { user: "Fox" } } : { decision: "deny", reason: "invalid" } });
    if (result.status !== "bound") throw new Error("binding failed");
    await expect(result.binding.connect().call(projection.handles.who, { token: "ok" })).resolves.toBe("Fox");
    expect(seen).toEqual(["Fox"]);
    await expect(result.binding.connect().call(projection.handles.who, { token: "no" })).rejects.toMatchObject({ cause: "denied" });
    result.controller.revoke();
    await expect(result.binding.connect().call(projection.handles.who, { token: "ok" })).rejects.toMatchObject({ cause: "revoked" });
    controller.revoke();
  });
});
