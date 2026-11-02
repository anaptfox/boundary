import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildKey, cacheHit, recordBuild } from "../../scripts/wasm/build-cache";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "boundary-guest-cache-"));
  roots.push(root);
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  for (const path of ["scripts/wasm/guests.sh", "scripts/wasm/build-cache.ts", "config/wasm-versions.json", ".node-version", "pnpm-lock.yaml"])
    write(path, "initial");
  const base = "examples/guests/thumbnail/javascript/";
  write(`${base}thumbnail.js`, "export function thumbnail() {}");
  write(`${base}wit/guest.wit`, "world guest {}");
  write(`${base}thumbnail.component.wasm`, "artifact");
  return { root, write, base };
}
it("requires matching sources, tools, recipe and artifact contents", () => {
  const { root, write, base } = setup();
  const key = buildKey(root, "js", "jco@pinned");
  expect(cacheHit(root, "js", key)).toBe(false);
  recordBuild(root, "js", key, "jco@pinned");
  expect(cacheHit(root, "js", key)).toBe(true);
  expect(cacheHit(root, "js", buildKey(root, "js", "jco@changed"))).toBe(false);
  write(`${base}thumbnail.component.wasm`, "tampered");
  expect(cacheHit(root, "js", key)).toBe(false);
  write(`${base}thumbnail.component.wasm`, "artifact");
  write(`${base}wit/guest.wit`, "world changed {}");
  expect(cacheHit(root, "js", buildKey(root, "js", "jco@pinned"))).toBe(false);
  expect(() => recordBuild(root, "js", key, "jco@pinned")).toThrow("inputs changed");
});
it("invalidates for added inputs and build recipe changes but ignores build outputs", () => {
  const { root, write, base } = setup();
  const key = buildKey(root, "js", "tools");
  write(`${base}out/generated.js`, "generated");
  write(`${base}thumbnail.component.wasm`, "regenerated");
  expect(buildKey(root, "js", "tools")).toBe(key);
  write(`${base}helper.js`, "new dependency");
  expect(buildKey(root, "js", "tools")).not.toBe(key);
  rmSync(join(root, base, "helper.js"));
  write("scripts/wasm/guests.sh", "changed flags");
  expect(buildKey(root, "js", "tools")).not.toBe(key);
});
it("treats corrupt metadata as a miss and never records an empty build", () => {
  const { root, write, base } = setup();
  const key = buildKey(root, "js", "tools");
  write("target/guest-build-cache/js.json", "{");
  expect(cacheHit(root, "js", key)).toBe(false);
  write(`${base}thumbnail.component.wasm`, "");
  expect(() => recordBuild(root, "js", key, "tools")).toThrow("empty component");
});
