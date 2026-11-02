import {
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson, normalizeJson } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import { failHost } from "../errors";
import {
  HOST_ARTIFACT_INVENTORY_PATH,
  assertHostArtifactSet,
} from "./render";
import type {
  HostArtifactCheckResult,
  HostArtifactDestinationOptions,
  HostArtifactInventory,
  HostArtifactSet,
  HostArtifactWriteResult,
} from "./types";

function destinationRoot(options: HostArtifactDestinationOptions): string {
  if (options === null || typeof options !== "object") {
    return failHost(
      "INVALID_ARTIFACT_DESTINATION",
      "options",
      "artifact destination options are required",
    );
  }
  const value = options.destination;
  if (value instanceof URL) {
    if (value.protocol !== "file:") {
      return failHost(
        "INVALID_ARTIFACT_DESTINATION",
        "destination",
        "artifact destinations must be filesystem paths or file URLs",
      );
    }
    return fileURLToPath(value);
  }
  if (typeof value !== "string" || value.length === 0) {
    return failHost(
      "INVALID_ARTIFACT_DESTINATION",
      "destination",
      "an explicit artifact destination is required",
    );
  }
  return isAbsolute(value) ? value : resolve(value);
}

function target(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

async function pinnedDestinationRoot(
  options: HostArtifactDestinationOptions,
  create: boolean,
): Promise<string> {
  const requested = destinationRoot(options);
  try {
    const stat = await lstat(requested);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return failHost(
        "INVALID_ARTIFACT_DESTINATION",
        requested,
        "artifact destination must be a real directory, not a symlink",
      );
    }
    return realpath(requested);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const missing: string[] = [];
  let ancestor = requested;
  while (true) {
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      return failHost(
        "INVALID_ARTIFACT_DESTINATION",
        requested,
        "artifact destination has no existing directory ancestor",
      );
    }
    missing.unshift(relative(parent, ancestor));
    ancestor = parent;
    try {
      const stat = await lstat(ancestor);
      if (!stat.isDirectory() && !stat.isSymbolicLink()) {
        return failHost(
          "INVALID_ARTIFACT_DESTINATION",
          ancestor,
          "artifact destination ancestor must be a directory",
        );
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  const pinned = join(await realpath(ancestor), ...missing);
  if (!create) return pinned;
  await mkdir(pinned, { recursive: true });
  const stat = await lstat(pinned);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    return failHost(
      "INVALID_ARTIFACT_DESTINATION",
      pinned,
      "artifact destination changed while it was being created",
    );
  }
  return realpath(pinned);
}

async function rejectManagedSymlinks(
  root: string,
  managedPath: string,
): Promise<void> {
  const parts = managedPath.split("/");
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = join(current, parts[index]!);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) {
        failHost(
          "INVALID_ARTIFACT_DESTINATION",
          managedPath,
          "managed artifact paths must not traverse symbolic links",
        );
      }
      if (index < parts.length - 1 && !stat.isDirectory()) {
        failHost(
          "INVALID_ARTIFACT_DESTINATION",
          managedPath,
          "managed artifact parent must be a directory",
        );
      }
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
  }
}

function inventoryBytes(inventory: HostArtifactInventory): Uint8Array {
  return new TextEncoder().encode(
    `${canonicalJson(
      normalizeJson(
        { version: inventory.version, files: inventory.files },
        "inventory",
      ),
    )}\n`,
  );
}

function isMissing(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function validManagedPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    value
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..") &&
    value !== HOST_ARTIFACT_INVENTORY_PATH
  );
}

async function previousInventory(root: string): Promise<readonly string[]> {
  await rejectManagedSymlinks(root, HOST_ARTIFACT_INVENTORY_PATH);
  let bytes: Uint8Array;
  try {
    bytes = await readFile(target(root, HOST_ARTIFACT_INVENTORY_PATH));
  } catch (error) {
    if (isMissing(error)) return Object.freeze([]);
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch (cause) {
    return failHost(
      "INVALID_ARTIFACT",
      HOST_ARTIFACT_INVENTORY_PATH,
      "existing host artifact inventory is not valid JSON",
      cause,
    );
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).some((key) => key !== "version" && key !== "files") ||
    (value as { version?: unknown }).version !== 1 ||
    !Array.isArray((value as { files?: unknown }).files) ||
    !(value as { files: unknown[] }).files.every(validManagedPath)
  ) {
    return failHost(
      "INVALID_ARTIFACT",
      HOST_ARTIFACT_INVENTORY_PATH,
      "existing host artifact inventory is malformed",
    );
  }
  const files = (value as { files: string[] }).files;
  if (new Set(files).size !== files.length) {
    return failHost(
      "INVALID_ARTIFACT",
      HOST_ARTIFACT_INVENTORY_PATH,
      "existing host artifact inventory contains duplicate paths",
    );
  }
  return Object.freeze([...files]);
}

function equalBytes(left: Uint8Array, right: ArrayLike<number>): boolean {
  if (left.byteLength !== right.length) return false;
  for (let index = 0; index < right.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

async function existingBytes(path: string): Promise<Uint8Array | undefined> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeExact(
  root: string,
  relativePath: string,
  bytes: ArrayLike<number>,
): Promise<void> {
  await rejectManagedSymlinks(root, relativePath);
  const path = target(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await rejectManagedSymlinks(root, relativePath);
  const temporary = `${path}.boundary-core-${process.pid}-${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, Uint8Array.from(bytes), { flag: "wx" });
    await rejectManagedSymlinks(root, relativePath);
    await rename(temporary, path);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) throw cleanupError;
    }
    throw error;
  }
}

async function removeManagedFile(
  root: string,
  relativePath: string,
): Promise<boolean> {
  await rejectManagedSymlinks(root, relativePath);
  const path = target(root, relativePath);
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      return failHost(
        "INVALID_ARTIFACT_DESTINATION",
        path,
        "an inventoried artifact path is not a file",
      );
    }
    await unlink(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

export async function writeHostArtifacts(
  artifacts: HostArtifactSet,
  options: HostArtifactDestinationOptions,
): Promise<HostArtifactWriteResult> {
  assertHostArtifactSet(artifacts);
  const root = await pinnedDestinationRoot(options, true);
  const previous = await previousInventory(root);
  const written: string[] = [];
  for (const file of artifacts.files) {
    await writeExact(root, file.path, file.bytes);
    written.push(file.path);
  }
  const current = new Set(artifacts.inventory.files);
  const removed: string[] = [];
  for (const stale of previous
    .filter((path) => !current.has(path))
    .sort(compareUtf8)) {
    if (await removeManagedFile(root, stale)) removed.push(stale);
  }
  await writeExact(
    root,
    artifacts.inventory.path,
    inventoryBytes(artifacts.inventory),
  );
  return Object.freeze({
    written: Object.freeze(written),
    removed: Object.freeze(removed),
    inventory: artifacts.inventory.path,
  });
}

export async function checkHostArtifacts(
  artifacts: HostArtifactSet,
  options: HostArtifactDestinationOptions,
): Promise<HostArtifactCheckResult> {
  assertHostArtifactSet(artifacts);
  const root = await pinnedDestinationRoot(options, false);
  const previous = await previousInventory(root);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const file of artifacts.files) {
    await rejectManagedSymlinks(root, file.path);
    const actual = await existingBytes(target(root, file.path));
    if (actual === undefined) missing.push(file.path);
    else if (!equalBytes(actual, file.bytes)) changed.push(file.path);
  }
  const expectedInventory = [...inventoryBytes(artifacts.inventory)];
  await rejectManagedSymlinks(root, artifacts.inventory.path);
  const actualInventory = await existingBytes(
    target(root, artifacts.inventory.path),
  );
  if (actualInventory === undefined) missing.push(artifacts.inventory.path);
  else if (!equalBytes(actualInventory, expectedInventory)) {
    changed.push(artifacts.inventory.path);
  }
  const current = new Set(artifacts.inventory.files);
  const stale = previous
    .filter((path) => !current.has(path))
    .sort(compareUtf8);
  return Object.freeze({
    ok: missing.length === 0 && changed.length === 0 && stale.length === 0,
    missing: Object.freeze(missing),
    changed: Object.freeze(changed),
    stale: Object.freeze(stale),
  });
}
