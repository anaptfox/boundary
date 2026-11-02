import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { portableSchema } from "@foxworth/boundary/program";
import {
  bindProjection,
  compileInteractions,
  defineInteraction,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "../../packages/core/host/index";
import { createControlRequestContributions } from "../../packages/core/host/request-contributions";
import {
  checkHostArtifacts,
  loadInteractionsEntry,
  renderHostArtifacts,
  writeHostArtifacts,
} from "../../packages/core/host/build/index";

const execFileAsync = promisify(execFile);
const workspaceRoot = fileURLToPath(new URL("../..", import.meta.url));

const Ping = defineInteraction({
  id: "system.ping",
  output: portableSchema<{ readonly ok: true }>({
    type: "object",
    properties: { ok: { const: true } },
    required: ["ok"],
    additionalProperties: false,
  }),
  reads: [],
  changes: [],
});

describe("@foxworth/boundary/build", () => {
  it("loads only the named closed interactions export through an explicit loader", async () => {
    const loaded = await loadInteractionsEntry({
      entry: "/explicit/system.boundary.ts",
      loadModule(entry) {
        expect(entry.href).toBe("file:///explicit/system.boundary.ts");
        return { interactions: { ping: Ping }, ignored: "adjacent export" };
      },
    });
    expect(loaded.interactions).toEqual({ ping: Ping });
    expect(Object.isFrozen(loaded.interactions)).toBe(true);

    await expect(
      loadInteractionsEntry({
        entry: "/explicit/system.boundary.ts",
        loadModule: () => ({ interactions: Promise.resolve({ ping: Ping }) }),
      }),
    ).rejects.toMatchObject({ code: "INVALID_INTERACTION_MODULE" });
  });

  it("renders pure bytes and removes only previously inventoried stale files", async () => {
    const compiled = await compileInteractions({ ping: Ping });
    const implementations = implementInteractions({ ping: Ping }, {
      ping: () => ({ ok: true as const }),
    });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:ping:1",
      implementations,
      realizationIds: { ping: { direct: "realization:ping:1" } },
    });
    const projection = await projectInteractions(compiled, {
      ping: { interaction: compiled.handles.ping, modes: ["direct"] },
    });
    const bound = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (bound.status !== "bound") throw new Error("expected bound");

    const complete = renderHostArtifacts({
      program: { name: "system", value: compiled.program },
      projections: {
        agent: { name: "callers/agent", value: projection },
      },
      installations: {
        live: { name: "deployments/live", value: installation },
      },
      bindings: {
        agent: { name: "bindings/agent", value: bound.binding },
      },
      references: {
        agent: {
          name: "clients/agent",
          value: {
            binding: bound.binding,
            source: {
              compiled,
              module: "./system.boundary.js",
              export: "interactions",
            },
            exportName: "agentReferences",
            members: { ping: { definition: "ping" } },
          },
        },
      },
    });
    expect(complete.files.map((file) => file.path)).toEqual([
      "bindings/agent.binding.json",
      "callers/agent.projection.json",
      "clients/agent.references.ts",
      "deployments/live.installation.json",
      "system.program.json",
    ]);
    const referenceSource = new TextDecoder().decode(
      Uint8Array.from(
        complete.files.find(
          (file) => file.path === "clients/agent.references.ts",
        )!.bytes,
      ),
    );
    expect(referenceSource).toContain(
      'type SourceInteractions = (typeof import("./system.boundary.js"))["interactions"]',
    );
    expect(referenceSource).toContain(
      "export const agentReferences",
    );
    expect(referenceSource).toContain(
      `contractDigest: ${JSON.stringify(compiled.handles.ping.contractDigest)}`,
    );
    expect(referenceSource).not.toMatch(/^import(?! type)/mu);

    const hostileCompiled = await compileInteractions({
      ping: defineInteraction({
        id: "hostile.not-system-ping",
        output: portableSchema({ const: "wrong" }),
      }),
    });
    expect(() => renderHostArtifacts({
      references: {
        hostile: {
          name: "clients/hostile",
          value: {
            binding: bound.binding,
            source: {
              compiled: hostileCompiled,
              module: "./hostile.boundary.js",
              export: "interactions",
            },
            exportName: "hostileReferences",
            members: { ping: { definition: "ping" } },
          },
        },
      },
    })).toThrow(/exact compiled interaction/);

    const destination = await mkdtemp(join(tmpdir(), "boundary-host-artifacts-"));
    try {
      await writeFile(join(destination, "unmanaged.txt"), "keep me");
      await writeHostArtifacts(complete, { destination });
      await expect(checkHostArtifacts(complete, { destination })).resolves
        .toMatchObject({ ok: true });

      const reduced = renderHostArtifacts({
        program: { name: "system", value: compiled.program },
      });
      const before = await checkHostArtifacts(reduced, { destination });
      expect(before.stale).toEqual([
        "bindings/agent.binding.json",
        "callers/agent.projection.json",
        "clients/agent.references.ts",
        "deployments/live.installation.json",
      ]);
      const written = await writeHostArtifacts(reduced, { destination });
      expect(written.removed).toEqual(before.stale);
      await expect(readFile(join(destination, "unmanaged.txt"), "utf8"))
        .resolves.toBe("keep me");
      await expect(checkHostArtifacts(reduced, { destination })).resolves
        .toMatchObject({ ok: true });
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("orders paths by unsigned UTF-8 bytes rather than process locale", async () => {
    const compiled = await compileInteractions({ ping: Ping });
    const projection = await projectInteractions(compiled, {
      ping: { interaction: compiled.handles.ping, modes: ["direct"] },
    });
    const artifacts = renderHostArtifacts({
      projections: {
        umlaut: { name: "ä", value: projection },
        ascii: { name: "z", value: projection },
      },
    });
    expect(artifacts.files.map((file) => file.path)).toEqual([
      "z.projection.json",
      "ä.projection.json",
    ]);
  });

  it("rejects invalid generated binding names while allowing reserved property names", async () => {
    const compiled = await compileInteractions({ ["default"]: Ping });
    const projection = await projectInteractions(compiled, {
      ping: { interaction: compiled.handles["default"], modes: ["direct"] },
    });
    const reference = {
      projection,
      source: { compiled, module: "./system.boundary.js", export: "interactions" },
      members: { ping: { definition: "default" } },
    };
    for (const exportName of ["default", "await", "yield", "let", "eval", "arguments", "Object"]) {
      expect(() => renderHostArtifacts({
        references: { agent: { name: "agent", value: { ...reference, exportName } } },
      })).toThrowError(expect.objectContaining({
        code: "INVALID_ARTIFACT", path: "references.value.exportName",
      }));
    }
    expect(renderHostArtifacts({
      references: { agent: { name: "agent", value: { ...reference, exportName: "agentReferences" } } },
    }).files).toHaveLength(1);
  });

  it("compiles import-free request references with an own __proto__ alias", async () => {
    const compiled = await compileInteractions({ ping: Ping });
    const implementations = implementInteractions({ ping: Ping }, {
      ping: () => ({ ok: true as const }),
    });
    const requests = createControlRequestContributions(compiled, {
      ping: {
        interaction: compiled.handles.ping,
        controlDigest: `sha256:${"a".repeat(64)}` as `sha256:${string}`,
        previewSchema: {
          type: "object",
          properties: { id: { type: "string" } },
          required: ["id"],
          additionalProperties: false,
        },
        request: () => ({ id: "proposal-1" }),
      },
    });
    const { installation } = await installInteractions(compiled, {
      installationId: "deploy:ping:request:1",
      implementations,
      requests,
      realizationIds: {
        ping: {
          direct: "realization:ping:direct:1",
          request: "realization:ping:request:1",
        },
      },
    });
    const projection = await projectInteractions(compiled, {
      ["__proto__"]: { interaction: compiled.handles.ping, modes: ["request"] },
    });
    const bound = await bindProjection(projection, installation, {
      admit: () => ({ decision: "allow" }),
    });
    if (bound.status !== "bound") throw new Error("expected request binding");

    const artifacts = renderHostArtifacts({
      references: {
        agent: {
          name: "clients/request-agent",
          value: {
            binding: bound.binding,
            source: {
              compiled,
              module: "./system.boundary.js",
              export: "interactions",
            },
            exportName: "requestReferences",
            members: {
              ["__proto__"]: {
                definition: "ping",
                requestOutput: {
                  module: "./proposal.js",
                  export: "PingProposal",
                },
              },
            },
          },
        },
      },
    });
    const source = new TextDecoder().decode(
      Uint8Array.from(artifacts.files[0]!.bytes),
    );
    expect(source).toContain(
      'type RequestOutput0 = import("./proposal.js").PingProposal;',
    );
    expect(source).toContain(
      'readonly ["request"], RequestOutput0>',
    );

    const destination = await mkdtemp(
      join(tmpdir(), "boundary-host-compiled-reference-"),
    );
    try {
      await writeHostArtifacts(artifacts, { destination });
      await symlink(
        join(workspaceRoot, "node_modules"),
        join(destination, "node_modules"),
        "dir",
      );
      await writeFile(
        join(destination, "package.json"),
        `${JSON.stringify({ type: "module" })}\n`,
      );
      await writeFile(
        join(destination, "clients/system.boundary.ts"),
        `import { defineInteraction } from "@foxworth/boundary";
import { portableSchema } from "@foxworth/boundary/program";

export const interactions = {
  ping: defineInteraction({
    id: "system.ping",
    output: portableSchema<Readonly<{ ok: true }>>({
      type: "object",
      properties: { ok: { const: true } },
      required: ["ok"],
      additionalProperties: false,
    }),
    reads: [],
    changes: [],
  }),
} as const;
`,
      );
      await writeFile(
        join(destination, "clients/proposal.ts"),
        `export type PingProposal = Readonly<{ id: "proposal-1" }>;
`,
      );
      await writeFile(
        join(destination, "clients/consume.ts"),
        `import type { ProjectionClient } from "@foxworth/boundary/client";
import { requestReferences } from "./request-agent.references.js";

declare const client: ProjectionClient;
client.request(requestReferences["__proto__"]).then((proposal) => {
  const exact: "proposal-1" = proposal.id;
  return exact;
});
// @ts-expect-error a request-only generated reference cannot call direct mode
client.call(requestReferences["__proto__"]);
// @ts-expect-error the generated zero-arity reference rejects an input value
client.request(requestReferences["__proto__"], {});
`,
      );
      const tsconfig = join(destination, "tsconfig.json");
      await writeFile(
        tsconfig,
        `${JSON.stringify(
          {
            compilerOptions: {
              target: "ES2022",
              module: "ESNext",
              moduleResolution: "Bundler",
              strict: true,
              skipLibCheck: true,
              rootDir: "clients",
              outDir: "dist",
            },
            include: ["clients/*.ts"],
          },
          null,
          2,
        )}\n`,
      );
      try {
        await execFileAsync(
          process.execPath,
          [
            join(workspaceRoot, "node_modules/typescript/bin/tsc"),
            "--project",
            tsconfig,
          ],
          { cwd: destination },
        );
      } catch (cause) {
        const diagnostics = cause as { stdout?: string; stderr?: string };
        throw new Error(
          `generated reference did not compile:\n${diagnostics.stdout ?? ""}${diagnostics.stderr ?? ""}`,
          { cause },
        );
      }

      const emittedPath = join(destination, "dist/request-agent.references.js");
      const emittedSource = await readFile(emittedPath, "utf8");
      expect(emittedSource).not.toMatch(/^\s*import\s/mu);
      const consumed = await import(pathToFileURL(emittedPath).href);
      expect(consumed.requestReferences["__proto__"]).toEqual({
        interactionId: "system.ping",
        contractDigest: compiled.handles.ping.contractDigest,
        inputArity: 0,
        modes: ["request"],
      });
      expect(Object.keys(consumed.requestReferences)).toEqual(["__proto__"]);
      expect(Object.hasOwn(consumed.requestReferences, "__proto__")).toBe(true);
      expect(Object.getPrototypeOf(consumed.requestReferences)).toBe(Object.prototype);
      expect(Object.isFrozen(consumed.requestReferences)).toBe(true);
      expect(Object.isFrozen(consumed.requestReferences["__proto__"])).toBe(true);
      expect(Object.isFrozen(consumed.requestReferences["__proto__"].modes)).toBe(true);
    } finally {
      await rm(destination, { recursive: true, force: true });
    }
  });

  it("rejects a symlink destination and never writes through it", async () => {
    const compiled = await compileInteractions({ ping: Ping });
    const artifacts = renderHostArtifacts({
      program: { name: "system", value: compiled.program },
    });
    const parent = await mkdtemp(join(tmpdir(), "boundary-host-symlink-root-"));
    const outside = await mkdtemp(join(tmpdir(), "boundary-host-symlink-outside-"));
    const destination = join(parent, "destination");
    try {
      await symlink(outside, destination, "dir");
      await expect(
        writeHostArtifacts(artifacts, { destination }),
      ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_DESTINATION" });
      await expect(readFile(join(outside, "system.program.json"))).rejects
        .toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("rejects symlink parents for writes and inventoried stale deletion", async () => {
    const compiled = await compileInteractions({ ping: Ping });
    const nested = renderHostArtifacts({
      program: { name: "owned/stale", value: compiled.program },
    });
    const reduced = renderHostArtifacts({});
    const destination = await mkdtemp(join(tmpdir(), "boundary-host-symlink-parent-"));
    const outside = await mkdtemp(join(tmpdir(), "boundary-host-symlink-target-"));
    try {
      await mkdir(join(destination, "owned"));
      await writeHostArtifacts(nested, { destination });
      await rm(join(destination, "owned"), { recursive: true, force: true });
      await writeFile(join(outside, "stale.program.json"), "outside");
      await symlink(outside, join(destination, "owned"), "dir");

      await expect(
        writeHostArtifacts(reduced, { destination }),
      ).rejects.toMatchObject({ code: "INVALID_ARTIFACT_DESTINATION" });
      await expect(readFile(join(outside, "stale.program.json"), "utf8"))
        .resolves.toBe("outside");
    } finally {
      await rm(destination, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
});
