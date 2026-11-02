import { createHash } from "node:crypto";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export const CONTENT_MANIFEST_VERSION = 1;
export const CONTENT_MANIFEST_FILE = "boundary-artifact.json";
export const PACK_RECEIPT_VERSION = 1;
export const PACK_RECEIPT_SUFFIX = ".receipt.json";

export type ArtifactDigest = `sha256:${string}`;

export type ContentManifest = Readonly<{
  version: 1;
  algorithm: "sha256";
  package: Readonly<{ name: string; version: string }>;
  files: readonly Readonly<{
    path: string;
    bytes: number;
    sha256: ArtifactDigest;
  }>[];
  aggregateDigest: ArtifactDigest;
}>;

export type PackReceipt = Readonly<{
  version: 1;
  algorithm: "sha256";
  package: Readonly<{ name: string; version: string }>;
  tarball: Readonly<{
    filename: string;
    bytes: number;
    sha256: ArtifactDigest;
  }>;
  contentDigest: ArtifactDigest;
}>;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const CONTENT_DOMAIN = "boundary.package-content/v1\0";

function sha256(bytes: Uint8Array): ArtifactDigest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function fail(message: string): never {
  throw new Error(`Invalid Boundary package artifact: ${message}`);
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  pathName: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${pathName} must be an object`);
  }
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(`${pathName} must contain exactly ${expected.join(", ")}`);
  }
  return value as Record<string, unknown>;
}

function packageIdentity(
  value: unknown,
  pathName: string,
): { name: string; version: string } {
  const identity = exactObject(value, ["name", "version"], pathName);
  if (typeof identity.name !== "string" || !identity.name.trim()) {
    fail(`${pathName}.name must be a non-empty string`);
  }
  if (typeof identity.version !== "string" || !identity.version.trim()) {
    fail(`${pathName}.version must be a non-empty string`);
  }
  return { name: identity.name, version: identity.version };
}

function portablePath(value: unknown, pathName: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value === CONTENT_MANIFEST_FILE ||
    value.includes("\\") ||
    value.includes("\0") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((piece) => piece === "" || piece === "." || piece === "..")
  ) {
    fail(`${pathName} must be a safe relative UTF-8 path`);
  }
  return value;
}

function digest(value: unknown, pathName: string): ArtifactDigest {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    fail(`${pathName} must be sha256:<64 lowercase hex>`);
  }
  return value as ArtifactDigest;
}

function contentPayload({
  package: packageValue,
  files,
}: {
  package: ContentManifest["package"];
  files: ContentManifest["files"];
}): Buffer {
  return Buffer.from(
    `${CONTENT_DOMAIN}${JSON.stringify({
      version: CONTENT_MANIFEST_VERSION,
      algorithm: "sha256",
      package: packageValue,
      files,
    })}`,
    "utf8",
  );
}

async function filesBelow(root: string, directory = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    // Local link consumers may materialize a derived dependency tree beside an
    // artifact. npm never packs node_modules, so it is not package content and
    // must not participate in the exact-byte content manifest.
    if (directory === root && entry.name === "node_modules") continue;
    // Tarballs and their adjacent receipts are derived from the package
    // content. Keeping them beside the package artifact makes each package
    // self-contained, but they must not recursively alter that content's
    // identity or make a subsequent verification fail.
    if (
      directory === root &&
      (entry.name.endsWith(".tgz") || entry.name.endsWith(`.tgz${PACK_RECEIPT_SUFFIX}`))
    ) continue;
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      fail(`package content must not contain a symbolic link: ${path.relative(root, file)}`);
    }
    if (entry.isDirectory()) {
      files.push(...(await filesBelow(root, file)));
    } else if (entry.isFile()) {
      const relative = path.relative(root, file).split(path.sep).join("/");
      if (relative !== CONTENT_MANIFEST_FILE) files.push(relative);
    } else {
      fail(`package content must contain only files and directories: ${path.relative(root, file)}`);
    }
  }
  return files.sort(compareUtf8);
}

function parseContentManifest(value: unknown): ContentManifest {
  const manifest = exactObject(
    value,
    ["version", "algorithm", "package", "files", "aggregateDigest"],
    CONTENT_MANIFEST_FILE,
  );
  if (manifest.version !== CONTENT_MANIFEST_VERSION) {
    fail(`${CONTENT_MANIFEST_FILE}.version must be ${CONTENT_MANIFEST_VERSION}`);
  }
  if (manifest.algorithm !== "sha256") {
    fail(`${CONTENT_MANIFEST_FILE}.algorithm must be sha256`);
  }
  const packageValue = packageIdentity(
    manifest.package,
    `${CONTENT_MANIFEST_FILE}.package`,
  );
  if (!Array.isArray(manifest.files)) {
    fail(`${CONTENT_MANIFEST_FILE}.files must be an array`);
  }
  const seen = new Set<string>();
  let previousPath: string | undefined;
  const files = manifest.files.map((candidate, index) => {
    const entry = exactObject(
      candidate,
      ["path", "bytes", "sha256"],
      `${CONTENT_MANIFEST_FILE}.files[${index}]`,
    );
    const relative = portablePath(
      entry.path,
      `${CONTENT_MANIFEST_FILE}.files[${index}].path`,
    );
    if (seen.has(relative)) fail(`duplicate package path: ${relative}`);
    if (previousPath !== undefined && compareUtf8(previousPath, relative) >= 0) {
      fail(`${CONTENT_MANIFEST_FILE}.files must be UTF-8 sorted`);
    }
    previousPath = relative;
    seen.add(relative);
    if (!Number.isSafeInteger(entry.bytes) || Number(entry.bytes) < 0) {
      fail(`${CONTENT_MANIFEST_FILE}.files[${index}].bytes must be a non-negative safe integer`);
    }
    return {
      path: relative,
      bytes: entry.bytes as number,
      sha256: digest(
        entry.sha256,
        `${CONTENT_MANIFEST_FILE}.files[${index}].sha256`,
      ),
    };
  });
  const aggregateDigest = digest(
    manifest.aggregateDigest,
    `${CONTENT_MANIFEST_FILE}.aggregateDigest`,
  );
  if (sha256(contentPayload({ package: packageValue, files })) !== aggregateDigest) {
    fail(`${CONTENT_MANIFEST_FILE}.aggregateDigest does not match its content list`);
  }
  return {
    version: CONTENT_MANIFEST_VERSION,
    algorithm: "sha256",
    package: packageValue,
    files,
    aggregateDigest,
  };
}

export async function readContentManifest(root: string): Promise<ContentManifest> {
  let value: unknown;
  try {
    value = JSON.parse(
      await readFile(path.join(root, CONTENT_MANIFEST_FILE), "utf8"),
    );
  } catch {
    fail(`${CONTENT_MANIFEST_FILE} is missing or is not valid JSON`);
  }
  return parseContentManifest(value);
}

export async function writeContentManifest(
  root: string,
  packageValue: Readonly<{ name: string; version: string }>,
): Promise<ContentManifest> {
  await rm(path.join(root, CONTENT_MANIFEST_FILE), { force: true });
  const identity = packageIdentity(packageValue, "package");
  const files: Array<{ path: string; bytes: number; sha256: ArtifactDigest }> = [];
  for (const relative of await filesBelow(root)) {
    const bytes = await readFile(path.join(root, relative));
    files.push({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) });
  }
  const manifest: ContentManifest = {
    version: CONTENT_MANIFEST_VERSION,
    algorithm: "sha256",
    package: identity,
    files,
    aggregateDigest: sha256(contentPayload({ package: identity, files })),
  };
  await writeFile(
    path.join(root, CONTENT_MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function verifyContentManifest(
  root: string,
  expected: Readonly<{
    name?: string;
    version?: string;
    aggregateDigest?: ArtifactDigest;
  }> = {},
): Promise<ContentManifest> {
  const manifest = await readContentManifest(root);
  if (expected.name !== undefined && manifest.package.name !== expected.name) {
    fail(`package name is ${manifest.package.name}, expected ${expected.name}`);
  }
  if (
    expected.version !== undefined &&
    manifest.package.version !== expected.version
  ) {
    fail(`package version is ${manifest.package.version}, expected ${expected.version}`);
  }
  if (
    expected.aggregateDigest !== undefined &&
    manifest.aggregateDigest !== expected.aggregateDigest
  ) {
    fail("content aggregate digest does not match the receipt");
  }

  const actualPaths = await filesBelow(root);
  const expectedPaths = manifest.files.map((entry) => entry.path);
  if (
    actualPaths.length !== expectedPaths.length ||
    actualPaths.some((value, index) => value !== expectedPaths[index])
  ) {
    fail("package file set does not match the content manifest");
  }

  for (const entry of manifest.files) {
    const bytes = await readFile(path.join(root, entry.path));
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      fail(`package file does not match the content manifest: ${entry.path}`);
    }
  }
  return manifest;
}

export async function writePackReceipt(options: Readonly<{
  tarballPath: string;
  packageName: string;
  packageVersion: string;
  contentDigest: ArtifactDigest;
}>): Promise<Readonly<{ receipt: PackReceipt; receiptPath: string }>> {
  const { tarballPath, packageName, packageVersion, contentDigest } = options;
  const filename = path.basename(tarballPath);
  const bytes = await readFile(tarballPath);
  const receipt: PackReceipt = {
    version: PACK_RECEIPT_VERSION,
    algorithm: "sha256",
    package: { name: packageName, version: packageVersion },
    tarball: {
      filename,
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    },
    contentDigest: digest(contentDigest, "receipt.contentDigest"),
  };
  const receiptPath = `${tarballPath}${PACK_RECEIPT_SUFFIX}`;
  await writeFile(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptPath };
}

function parsePackReceipt(value: unknown): PackReceipt {
  const receipt = exactObject(
    value,
    ["version", "algorithm", "package", "tarball", "contentDigest"],
    "receipt",
  );
  if (receipt.version !== PACK_RECEIPT_VERSION) {
    fail(`receipt.version must be ${PACK_RECEIPT_VERSION}`);
  }
  if (receipt.algorithm !== "sha256") fail("receipt.algorithm must be sha256");
  const packageValue = packageIdentity(receipt.package, "receipt.package");
  const tarball = exactObject(
    receipt.tarball,
    ["filename", "bytes", "sha256"],
    "receipt.tarball",
  );
  if (
    typeof tarball.filename !== "string" ||
    !tarball.filename.endsWith(".tgz") ||
    path.basename(tarball.filename) !== tarball.filename
  ) {
    fail("receipt.tarball.filename must name one adjacent .tgz file");
  }
  if (!Number.isSafeInteger(tarball.bytes) || Number(tarball.bytes) < 0) {
    fail("receipt.tarball.bytes must be a non-negative safe integer");
  }
  const expectedFilename = `${packageValue.name
    .replace(/^@/u, "")
    .replaceAll("/", "-")}-${packageValue.version}.tgz`;
  if (tarball.filename !== expectedFilename) {
    fail(`receipt.tarball.filename must be ${expectedFilename}`);
  }
  return {
    version: PACK_RECEIPT_VERSION,
    algorithm: "sha256",
    package: packageValue,
    tarball: {
      filename: tarball.filename,
      bytes: tarball.bytes as number,
      sha256: digest(tarball.sha256, "receipt.tarball.sha256"),
    },
    contentDigest: digest(receipt.contentDigest, "receipt.contentDigest"),
  };
}

export async function verifyPackReceipt(
  receiptPath: string,
  expected: Readonly<{ name?: string; version?: string }> = {},
): Promise<Readonly<{ receipt: PackReceipt; tarballPath: string }>> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(receiptPath, "utf8"));
  } catch {
    fail("receipt is missing or is not valid JSON");
  }
  const receipt = parsePackReceipt(value);
  if (
    path.basename(receiptPath) !==
    `${receipt.tarball.filename}${PACK_RECEIPT_SUFFIX}`
  ) {
    fail("receipt filename must identify its adjacent tarball");
  }
  if (expected.name !== undefined && receipt.package.name !== expected.name) {
    fail(`receipt package name is ${receipt.package.name}, expected ${expected.name}`);
  }
  if (
    expected.version !== undefined &&
    receipt.package.version !== expected.version
  ) {
    fail(`receipt package version is ${receipt.package.version}, expected ${expected.version}`);
  }
  const tarballPath = path.join(path.dirname(receiptPath), receipt.tarball.filename);
  let metadata;
  try {
    metadata = await stat(tarballPath);
  } catch {
    fail("the tarball named by the receipt is missing");
  }
  if (!metadata.isFile() || metadata.size !== receipt.tarball.bytes) {
    fail("tarball byte length does not match the receipt");
  }
  const bytes = await readFile(tarballPath);
  if (sha256(bytes) !== receipt.tarball.sha256) {
    fail("tarball SHA-256 does not match the receipt");
  }
  return { receipt, tarballPath };
}
