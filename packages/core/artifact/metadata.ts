import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { normalizeJson, type JsonObject, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import type { ContentManifest } from "./integrity";

/** Declared package metadata, not a module resolution or runtime compatibility proof. */
export type ArtifactPackageMetadata = Readonly<{
  exports: Readonly<Record<string, JsonValue>>;
  engines: Readonly<Record<string, string>>;
}>;

export function freezeArtifact<Value>(value: Value): Value {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeArtifact(child);
    Object.freeze(value);
  }
  return value;
}

function fail(message: string): never {
  throw new Error(`Invalid Boundary package metadata: ${message}`);
}

function isObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function object(value: JsonValue | undefined, label: string): JsonObject {
  if (!isObject(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function exportTarget(value: JsonValue): void {
  if (value === null) return;
  if (typeof value === "string") {
    if (!value.startsWith("./") || value.includes("\\") || value.includes("\0")
      || value.slice(2).split("/").some((part) => part === "." || part === ".." || part === "")) {
      fail("exports targets must be package-relative paths");
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach(exportTarget);
    return;
  }
  for (const target of Object.values(object(value, "exports target"))) exportTarget(target);
}

function exportsOf(value: JsonValue | undefined): Readonly<Record<string, JsonValue>> {
  if (value === undefined) return {};
  if (value === null || typeof value === "string" || Array.isArray(value)) {
    exportTarget(value);
    return { ".": value };
  }
  const fields = object(value, "exports");
  const keys = Object.keys(fields);
  const subpaths = keys.filter((key) => key.startsWith("."));
  if (subpaths.length !== 0 && subpaths.length !== keys.length) {
    fail("exports must not mix subpath and condition keys");
  }
  if (keys.length !== 0 && subpaths.length === 0) {
    exportTarget(fields);
    return { ".": fields };
  }
  const result: Record<string, JsonValue> = {};
  for (const key of keys.sort(compareUtf8)) {
    if (key !== "." && (!key.startsWith("./") || key.includes("\\")
      || key.slice(2).split("/").some((part) => part === "." || part === ".." || part === ""))) {
      fail(`invalid export subpath: ${key}`);
    }
    exportTarget(fields[key]!);
    Object.defineProperty(result, key, { value: fields[key], enumerable: true });
  }
  return result;
}

export function hasExportTarget(value: JsonValue | undefined): boolean {
  if (typeof value === "string") return true;
  if (value === undefined || value === null) return false;
  if (Array.isArray(value)) return value.some(hasExportTarget);
  return Object.values(object(value, "exports target")).some(hasExportTarget);
}

export function requiredExportNames(values: readonly string[]): readonly string[] {
  if (!Array.isArray(values)) fail("requiredExports must be an array");
  const result = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || (value !== "." && !value.startsWith("./"))
      || value.includes("*") || value.includes("\\") || value.includes("\0")
      || (value !== "." && value.slice(2).split("/").some((part) => !part || part === "." || part === ".."))) {
      fail("requiredExports must contain explicit package export names such as . or ./program");
    }
    result.add(value);
  }
  return Object.freeze([...result].sort(compareUtf8));
}

export async function readArtifactMetadata(
  root: string,
  content: ContentManifest,
): Promise<ArtifactPackageMetadata> {
  const entry = content.files.find((file) => file.path === "package.json");
  if (!entry) fail("the verified content must include package.json");
  const bytes = await readFile(path.join(root, "package.json"));
  const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (bytes.byteLength !== entry.bytes || hash !== entry.sha256) {
    fail("package.json changed after content verification");
  }
  let value: JsonValue;
  try {
    value = normalizeJson(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    fail("package.json must contain valid JSON");
  }
  const manifest = object(value, "package.json");
  if (manifest.name !== content.package.name || manifest.version !== content.package.version) {
    fail("package.json identity does not match the verified content manifest");
  }
  const engines: Record<string, string> = {};
  for (const [runtime, requirement] of Object.entries(
    manifest.engines === undefined ? {} : object(manifest.engines, "engines"),
  ).sort(([left], [right]) => compareUtf8(left, right))) {
    if (typeof requirement !== "string" || requirement.trim().length === 0) {
      fail(`engines.${runtime} must be a non-empty runtime requirement`);
    }
    Object.defineProperty(engines, runtime, { value: requirement, enumerable: true });
  }
  return freezeArtifact({ exports: exportsOf(manifest.exports), engines });
}
