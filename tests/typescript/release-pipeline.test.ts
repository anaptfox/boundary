import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writePackReceipt } from "../../packages/core/artifact/integrity.ts";
import { compareCandidates, compareStaged, npmIntegrity, verifyCandidate } from "../../scripts/release/candidate.ts";

const workspaceRoot = process.cwd();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(label: string): string {
  const root = mkdtempSync(path.join(tmpdir(), `boundary-${label}-`));
  roots.push(root);
  return root;
}

async function candidateFixture(bytes = "tarball:@foxworth/boundary"): Promise<string> {
  const root = scratch("release-candidate");
  const tarball = path.join(root, "foxworth-boundary-0.1.3.tgz");
  writeFileSync(tarball, bytes);
  await writePackReceipt({
    tarballPath: tarball,
    packageName: "@foxworth/boundary",
    packageVersion: "0.1.3",
    contentDigest: `sha256:${"b".repeat(64)}`,
  });
  return root;
}

const workflow = (name: string) => readFileSync(path.join(workspaceRoot, ".github/workflows", name), "utf8");

/** The YAML block for one job: from `  <job>:` to the next two-space key. */
function job(source: string, name: string): string {
  const start = source.indexOf(`\n  ${name}:\n`);
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/u);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

function actionPins(source: string): string[] {
  return [...source.matchAll(/^\s*-?\s*uses:\s+[^@\s]+@([^\s#]+)/gmu)].map((match) => match[1]!);
}

describe("release candidate", () => {
  it("is one SDK tarball with its receipt, identified by npm integrity", async () => {
    const root = await candidateFixture();
    const candidate = await verifyCandidate(root);
    expect(candidate).toMatchObject({ name: "@foxworth/boundary", version: "0.1.3", tarball: "foxworth-boundary-0.1.3.tgz" });
    expect(candidate.integrity).toBe(npmIntegrity(Buffer.from("tarball:@foxworth/boundary")));
  });

  it("rejects tampered bytes and extra files", async () => {
    const tampered = await candidateFixture();
    writeFileSync(path.join(tampered, "foxworth-boundary-0.1.3.tgz"), "tampered");
    await expect(verifyCandidate(tampered)).rejects.toThrow();

    const extra = await candidateFixture();
    writeFileSync(path.join(extra, "LICENSE"), "MIT");
    await expect(verifyCandidate(extra)).rejects.toThrow(/one tarball and its receipt/u);
  });

  it("is reproducible only when both builds are byte-identical", async () => {
    await expect(compareCandidates(await candidateFixture(), await candidateFixture())).resolves.toMatchObject({ version: "0.1.3" });
    await expect(compareCandidates(await candidateFixture(), await candidateFixture("different bytes"))).rejects.toThrow(/not reproducible/u);
  });

  it("matches a staged tarball only when npm staged the exact candidate bytes", async () => {
    const candidate = await verifyCandidate(await candidateFixture());
    const staged = path.join(scratch("staged"), "staged.tgz");
    writeFileSync(staged, "tarball:@foxworth/boundary");
    await expect(compareStaged(candidate, staged)).resolves.toBeUndefined();
    writeFileSync(staged, "tarball:something-else");
    await expect(compareStaged(candidate, staged)).rejects.toThrow(/does not match the CI candidate/u);
  });
});

describe("release workflow policy", () => {
  const release = workflow("release.yml");
  const verify = job(release, "verify");
  const stage = job(release, "stage");

  it("starts only from a manual dispatch on main", () => {
    expect(release).toMatch(/^on:\n {2}workflow_dispatch:\n/mu);
    expect(release).not.toMatch(/^\s+(push|pull_request|pull_request_target|issue_comment|workflow_run|schedule):/mu);
    expect(verify).toContain("if: github.ref == 'refs/heads/main'");
  });

  it("grants no default permissions and OIDC only to the npm-environment stage job", () => {
    expect(release).toMatch(/^permissions: \{\}$/mu);
    expect(release.match(/id-token: write/gu)).toHaveLength(1);
    expect(stage).toContain("id-token: write");
    expect(stage).toContain("environment: npm");
    expect(stage).toContain("needs: verify");
    expect(verify).not.toContain("id-token");
  });

  it("stages and never publishes, with no token and no cache", () => {
    expect(stage).toContain("npm stage publish ./candidate/*.tgz --access public --tag \"$DIST_TAG\" --provenance");
    for (const line of release.split("\n").filter((text) => /\bnpm publish\b/u.test(text))) {
      expect(line).toContain("--dry-run");
    }
    expect(release).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\.|npm dist-tag|--allow-publish/u);
    expect(release).not.toMatch(/^\s+cache:|actions\/cache@/mu);
    expect(release).toContain("persist-credentials: false");
  });

  it("requires CI success, a matching version, and reproducible bytes before staging", () => {
    expect(verify).toContain("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA&event=push&status=success");
    expect(verify).toContain("does not match packages/package.json");
    expect(verify).toContain("must use dist-tag next");
    expect(verify).toContain("compare-candidates.mjs");
    expect(verify).toContain("zod-peer-smoke.mjs --candidate release-candidate --zod 4.6.5");
  });
});

describe("CI workflow policy", () => {
  const ci = workflow("ci.yml");

  it("stays read-only and credential-free", () => {
    expect(ci).toMatch(/^permissions:\n {2}contents: read$/mu);
    expect(ci).not.toMatch(/id-token|attestations:|NPM_TOKEN|NODE_AUTH_TOKEN|npm publish|npm stage/u);
  });

  it("runs the ladder and proves the release candidate on every change", () => {
    for (const text of ["just gate", "just ci", "just rust-msrv", "compare-candidates.mjs", "zod-peer-smoke.mjs --candidate release-candidate --zod '^4.6.5'"]) {
      expect(ci).toContain(text);
    }
    expect(ci).toContain("cancel-in-progress: ${{ github.event_name == 'pull_request' }}");
    expect(ci).toContain("RUSTUP_TOOLCHAIN: 1.96.0");
    expect(ci).toContain("RUSTUP_TOOLCHAIN: 1.100.0");
    expect(ci).toContain("node-version: 24.21.0");
  });

  it("pins every action in every workflow to a full commit SHA", () => {
    for (const source of [ci, workflow("release.yml")]) {
      const pins = actionPins(source);
      expect(pins.length).toBeGreaterThan(0);
      expect(pins.every((pin) => /^[0-9a-f]{40}$/u.test(pin))).toBe(true);
    }
  });
});
