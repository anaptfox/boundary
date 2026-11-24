/**
 * The version 1 Handoff HTTP framing, checked against reviewed evidence.
 *
 * Every TypeScript mount already shares one framing in
 * `packages/adapters/http/protocol.ts`. This test promotes that convention to
 * something a non-TypeScript host can be held to: it reads
 * `tests/conformance/v1/http-framing.json` and proves the shipped handler
 * matches it, so the Rust implementation of the same vector is checked against
 * the same evidence rather than against a reading of the TypeScript source.
 *
 * The vector is read-only here. If the handler and the vector disagree, the
 * vector is the reviewed decision and must change first.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  bindProjection,
  compileInteractions,
  declaredInteractionError,
  defineInteraction,
  direct,
  directRealizationIds,
  implementInteractions,
  installInteractions,
  projectInteractions,
} from "@foxworth/boundary";
import { createProtocolHandler } from "@foxworth/boundary/http/protocol";
import { statusForRemoteResult } from "@foxworth/boundary/remote";
import { portableSchema } from "@foxworth/boundary/program";
import type { HandoffOutcome } from "@foxworth/boundary/handoff";

type StatusCase = {
  readonly name: string;
  readonly result: { readonly kind: string; readonly cause?: string };
  readonly status: number;
};

type RejectionCase = {
  readonly name: string;
  readonly status: number;
  readonly kind: string;
  readonly code: string;
  readonly path: string | null;
};

type Vector = {
  readonly version: 1;
  readonly routes: {
    readonly manifest: { readonly method: string; readonly suffix: string };
    readonly invoke: { readonly method: string; readonly suffix: string };
  };
  readonly contentType: { readonly response: string; readonly request: string };
  readonly manifest: {
    readonly okStatus: number;
    readonly cacheControl: string;
    readonly notModified: {
      readonly requestHeader: string;
      readonly status: number;
      readonly emptyBody: boolean;
    };
  };
  readonly statusForOutcome: readonly StatusCase[];
  readonly rejections: {
    readonly cases: readonly RejectionCase[];
    readonly conflictStatusRule: {
      readonly status: number;
      readonly codePrefixes: readonly string[];
      readonly codes: readonly string[];
      readonly otherwise: number;
    };
  };
};

const vector = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL("../conformance/v1/http-framing.json", import.meta.url),
    ),
    "utf8",
  ),
) as Vector;

const Empty = portableSchema<Record<string, never>>({
  type: "object",
  properties: {},
  additionalProperties: false,
});
const Echo = portableSchema<Readonly<{ text: string }>>({
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false,
});

const interactions = {
  echo: defineInteraction({
    id: "framing.echo",
    input: Echo,
    output: Echo,
    reads: ["framing"],
    changes: [],
  }),
  fail: defineInteraction({
    id: "framing.fail",
    input: Empty,
    output: Empty,
    errors: { REFUSED: Empty },
    reads: ["framing"],
    changes: [],
  }),
} as const;

const BASE = "/boundary/v1";

async function fixture(options: { readonly admit?: boolean } = {}) {
  const compiled = compileInteractions(interactions);
  const implementations = implementInteractions(interactions, {
    echo: (input) => ({ text: input.text }),
    fail: () => {
      throw declaredInteractionError(interactions.fail, "REFUSED", {});
    },
  });
  const { installation } = installInteractions(compiled, {
    installationId: "deploy:http-framing:1",
    implementations,
    realizationIds: directRealizationIds(compiled, "v1"),
  });
  const projection = projectInteractions(compiled, {
    echo: direct(compiled.handles.echo),
    fail: direct(compiled.handles.fail),
  });
  const bound = bindProjection(projection, installation, {
    admit: () =>
      options.admit === false
        ? { decision: "deny" as const, reason: "DENIED" }
        : { decision: "allow" as const },
  });
  if (bound.status !== "bound") throw new Error("fixture must bind");
  const handler = createProtocolHandler({
    binding: bound.binding,
    // This fixture's admission ignores context, so the Binding's Context is
    // void. The handler still resolves one per invocation.
    context: () => {},
    path: BASE,
  });
  return { handler, binding: bound.binding };
}

function url(suffix: string): string {
  return `https://host.invalid${BASE}${suffix}`;
}

async function manifestResponse(handler: Awaited<ReturnType<typeof fixture>>["handler"]) {
  return handler(new Request(url(vector.routes.manifest.suffix), { method: "GET" }));
}

describe("HTTP framing — routes and cache validation", () => {
  it("serves the manifest with the reviewed status, content type, and cache directive", async () => {
    const { handler } = await fixture();
    const response = await manifestResponse(handler);

    expect(response.status).toBe(vector.manifest.okStatus);
    expect(response.headers.get("content-type")).toBe(
      vector.contentType.response,
    );
    expect(response.headers.get("cache-control")).toBe(
      vector.manifest.cacheControl,
    );
  });

  it("uses the binding digest as the entity tag", async () => {
    const { handler, binding } = await fixture();
    const response = await manifestResponse(handler);
    const manifest = (await response.json()) as { bindingDigest: string };

    // Revalidation is against exact Binding identity, not a timestamp: a
    // replaced Installation produces a different digest and a different tag.
    expect(response.headers.get("etag")).toBe(`"${manifest.bindingDigest}"`);
    expect(manifest.bindingDigest).toBe(binding.manifest.bindingDigest);
  });

  it("answers a matching validator with an empty not-modified response", async () => {
    const { handler } = await fixture();
    const first = await manifestResponse(handler);
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const revalidated = await handler(
      new Request(url(vector.routes.manifest.suffix), {
        method: "GET",
        headers: { [vector.manifest.notModified.requestHeader]: etag as string },
      }),
    );

    expect(revalidated.status).toBe(vector.manifest.notModified.status);
    expect(await revalidated.text()).toBe("");
    expect(revalidated.headers.get("etag")).toBe(etag);
  });

  it("rejects every route outside the reviewed two", async () => {
    const { handler } = await fixture();
    const expected = vector.rejections.cases.find(
      (entry) => entry.name === "route-not-found",
    );
    expect(expected).toBeDefined();

    const response = await handler(
      new Request(url("/not-a-route"), { method: "GET" }),
    );
    expect(response.status).toBe(expected?.status);
    const body = (await response.json()) as {
      error: { kind: string; code: string; path: string };
    };
    expect(body.error.kind).toBe(expected?.kind);
    expect(body.error.code).toBe(expected?.code);
    expect(body.error.path).toBe(expected?.path);
  });

  it("treats the manifest route under the wrong method as no route", async () => {
    const { handler } = await fixture();
    const response = await handler(
      new Request(url(vector.routes.manifest.suffix), { method: "POST" }),
    );
    expect(response.status).toBe(404);
  });
});

describe("HTTP framing — invocation envelopes", () => {
  it("carries a bare outcome envelope and the reviewed success status", async () => {
    const { handler, binding } = await fixture();
    const manifest = binding.manifest;
    const entry = manifest.interactions.find((op) => op.alias === "echo");
    expect(entry).toBeDefined();

    const response = await handler(
      new Request(url(vector.routes.invoke.suffix), {
        method: "POST",
        headers: { "content-type": vector.contentType.request },
        body: JSON.stringify({
          version: 1,
          bindingDigest: manifest.bindingDigest,
          installationId: manifest.installationId,
          interactionId: entry?.interactionId,
          expectedContractDigest: entry?.expectedContractDigest,
          actualContractDigest: entry?.actualContractDigest,
          mode: entry?.mode,
          realizationId: entry?.realizationId,
          input: { text: "hello" },
        }),
      }),
    );

    const returned = vector.statusForOutcome.find(
      (entry_) => entry_.name === "returned",
    );
    expect(response.status).toBe(returned?.status);

    // The body is the envelope itself, with no wrapper object around it.
    const outcome = (await response.json()) as HandoffOutcome;
    expect(outcome.version).toBe(1);
    expect(outcome.bindingDigest).toBe(manifest.bindingDigest);
    expect(outcome.result).toEqual({ kind: "returned", value: { text: "hello" } });
  });

  it("carries a declared error as a domain outcome, not a malformed request", async () => {
    const { handler, binding } = await fixture();
    const manifest = binding.manifest;
    const entry = manifest.interactions.find((op) => op.alias === "fail");

    const response = await handler(
      new Request(url(vector.routes.invoke.suffix), {
        method: "POST",
        headers: { "content-type": vector.contentType.request },
        body: JSON.stringify({
          version: 1,
          bindingDigest: manifest.bindingDigest,
          installationId: manifest.installationId,
          interactionId: entry?.interactionId,
          expectedContractDigest: entry?.expectedContractDigest,
          actualContractDigest: entry?.actualContractDigest,
          mode: entry?.mode,
          realizationId: entry?.realizationId,
          input: {},
        }),
      }),
    );

    const declared = vector.statusForOutcome.find(
      (entry_) => entry_.name === "declared-error",
    );
    expect(response.status).toBe(declared?.status);
    const outcome = (await response.json()) as HandoffOutcome;
    expect(outcome.result.kind).toBe("declared-error");
  });

  it("rejects an empty body and malformed JSON with the reviewed envelope", async () => {
    const { handler } = await fixture();
    for (const name of ["empty-body", "malformed-json"]) {
      const expected = vector.rejections.cases.find(
        (entry) => entry.name === name,
      );
      expect(expected, name).toBeDefined();

      const response = await handler(
        new Request(url(vector.routes.invoke.suffix), {
          method: "POST",
          headers: { "content-type": vector.contentType.request },
          body: name === "empty-body" ? "" : "{not json",
        }),
      );

      expect(response.status, name).toBe(expected?.status);
      const body = (await response.json()) as {
        error: { kind: string; code: string; path: string };
      };
      expect(body.error.kind, name).toBe(expected?.kind);
      expect(body.error.code, name).toBe(expected?.code);
      expect(body.error.path, name).toBe(expected?.path);
    }
  });
});

describe("HTTP framing — status mapping is exhaustive", () => {
  const outcome = (result: unknown): HandoffOutcome =>
    ({
      version: 1,
      bindingDigest: "sha256:0",
      installationId: "installation:0",
      interactionId: "framing.echo",
      expectedContractDigest: "sha256:0",
      actualContractDigest: "sha256:0",
      mode: "direct",
      realizationId: "realization:0",
      certainty: "completed",
      result,
    }) as unknown as HandoffOutcome;

  for (const entry of vector.statusForOutcome) {
    it(`maps ${entry.name} to ${entry.status}`, () => {
      const result =
        entry.result.kind === "fault"
          ? { kind: "fault", cause: entry.result.cause }
          : entry.result.kind === "returned"
            ? { kind: "returned", value: null }
            : entry.result.kind === "declared-error"
              ? { kind: "declared-error", code: "X", details: null }
              : entry.result.kind === "proposed"
                ? { kind: "proposed", proposal: null }
                : { kind: "denied", code: "DENIED" };
      expect(statusForRemoteResult(outcome(result))).toBe(entry.status);
    });
  }

  it("covers every fault cause the Handoff protocol defines", () => {
    // If a new cause is added without a reviewed status, this fails rather
    // than letting it fall through to 500 unnoticed.
    const causes = new Set(
      vector.statusForOutcome
        .filter((entry) => entry.result.kind === "fault")
        .map((entry) => entry.result.cause),
    );
    expect(causes).toEqual(
      new Set([
        "invalid-input",
        "revoked",
        "admission-failed",
        "request-failed",
        "invalid-realization-outcome",
        "realization-failed",
        "invalid-invocation",
      ]),
    );
  });
});
