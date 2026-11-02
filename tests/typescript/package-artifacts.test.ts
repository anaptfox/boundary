import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_MANIFEST_FILE,
  verifyContentManifest,
  verifyPackReceipt,
  writeContentManifest,
  writePackReceipt,
} from "../../packages/core/artifact/integrity.ts";

const workspaceRoot = process.cwd();

function manifestFor() {
  return JSON.parse(
    readFileSync(
      path.join(workspaceRoot, "packages", "package.json"),
      "utf8",
    ),
  ) as Record<string, any>;
}

describe("Boundary package topology", () => {
  it("derives each documented direct package from its own interface", () => {
    for (const name of ["boundary"]) {
      const packageRoot = path.join(workspaceRoot, "packages");
      const manifest = manifestFor();
      expect(manifest).toMatchObject({
        name: `@foxworth/${name}`,
        license: "MIT",
        author: "Taron Foxworth",
      });
      expect(existsSync(path.join(packageRoot, "README.md"))).toBe(true);
      expect(manifest.description).toEqual(expect.any(String));
      // tsdown keeps source exports and publishConfig.exports in step.
      expect(Object.keys(manifest.publishConfig.exports).sort()).toEqual(Object.keys(manifest.exports).sort());
      for (const [key, target] of Object.entries(manifest.publishConfig.exports) as [string, any][]) {
        if (key === "./package.json") continue;
        const file = typeof target === "string" ? target : target.default ?? target.node;
        expect(file, key).toMatch(/^\.\/dist\//u);
      }
      for (const target of Object.values(manifest.exports) as unknown[]) {
        if (typeof target !== "string") continue;
        expect(existsSync(path.join(packageRoot, target))).toBe(true);
      }
    }
  });

  it("creates an boundary.package-content artifact that excludes itself", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "boundary-content-manifest-"));
    try {
      mkdirSync(path.join(root, "nested"));
      writeFileSync(path.join(root, "a.txt"), "alpha");
      writeFileSync(path.join(root, "nested", "é.txt"), "unicode");

      const manifest = await writeContentManifest(root, {
        name: "@foxworth/boundary",
        version: "0.1.0",
      });
      expect(CONTENT_MANIFEST_FILE).toBe("boundary-artifact.json");
      expect(manifest).toMatchObject({
        version: 1,
        algorithm: "sha256",
        package: { name: "@foxworth/boundary", version: "0.1.0" },
        aggregateDigest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
      });
      expect(manifest.files.map((entry) => entry.path)).toEqual([
        "a.txt",
        "nested/é.txt",
      ]);
      expect(
        manifest.files.every((entry) => entry.path !== CONTENT_MANIFEST_FILE),
      ).toBe(true);
      await expect(
        verifyContentManifest(root, {
          name: "@foxworth/boundary",
          version: "0.1.0",
          aggregateDigest: manifest.aggregateDigest,
        }),
      ).resolves.toEqual(manifest);

      writeFileSync(path.join(root, "a.txt"), "tampered");
      await expect(verifyContentManifest(root)).rejects.toThrow(
        /package file does not match/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps optional framework dependencies behind their owning subpaths", () => {
    const sdk = manifestFor();
    expect(sdk.dependencies ?? {}).toEqual({});
    for (const peer of Object.keys(sdk.peerDependencies)) {
      expect(sdk.peerDependenciesMeta[peer]).toEqual({ optional: true });
    }
    expect(sdk.exports["."]).toBe("./core/host/index.ts");
    expect(sdk.exports["./frameworks/hono"]).toBe("./adapters/frameworks/hono.ts");
    expect(sdk.exports["./react"]).toBe("./callers/react/index.ts");
  });

  it("binds an adjacent receipt to exact package tarball bytes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "boundary-pack-receipt-"));
    try {
      const tarballPath = path.join(root, "foxworth-boundary-0.1.0.tgz");
      writeFileSync(tarballPath, "packed bytes");
      const contentDigest = `sha256:${"a".repeat(64)}` as `sha256:${string}`;
      const created = await writePackReceipt({
        tarballPath,
        packageName: "@foxworth/boundary",
        packageVersion: "0.1.0",
        contentDigest,
      });

      await expect(
        verifyPackReceipt(created.receiptPath, {
          name: "@foxworth/boundary",
          version: "0.1.0",
        }),
      ).resolves.toMatchObject({ tarballPath });
      writeFileSync(tarballPath, "changed bytes");
      await expect(verifyPackReceipt(created.receiptPath)).rejects.toThrow(
        /tarball byte length does not match|tarball SHA-256 does not match/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
