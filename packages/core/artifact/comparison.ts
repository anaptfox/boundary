import { canonicalJson, contractChanges, type ContractDelta, type InteractionContract, type JsonValue } from "@foxworth/boundary/program";
import { compareUtf8 } from "#program/internal";
import {
  verifyContentManifest,
  verifyPackReceipt,
  type ArtifactDigest,
  type ContentManifest,
  type PackReceipt,
} from "./integrity";
import {
  freezeArtifact,
  hasExportTarget,
  readArtifactMetadata,
  requiredExportNames,
  type ArtifactPackageMetadata,
} from "./metadata";

/** Exact paths and optional reviewed pins supplied by the consumer. */
export type PackageArtifactSource = Readonly<{
  root: string;
  receiptPath?: string;
  expected?: Readonly<{
    name?: string;
    version?: string;
    aggregateDigest?: ArtifactDigest;
    tarballDigest?: ArtifactDigest;
  }>;
}>;

export type VerifiedPackageArtifact = Readonly<{
  root: string;
  content: ContentManifest;
  metadata: ArtifactPackageMetadata;
  /** Present only after verifying the adjacent tarball and linking its content pin. */
  receipt?: PackReceipt;
}>;

export type ArtifactMemberDiff = Readonly<{
  added: readonly string[];
  removed: readonly string[];
  changed: readonly string[];
  unchanged: readonly string[];
}>;

export type PackageArtifactComparisonOptions = Readonly<{
  before: PackageArtifactSource;
  after: PackageArtifactSource;
  /** Exact subpath declarations; patterns and implicit root discovery are not expanded. */
  requiredExports?: readonly string[];
  /** Reviewed declarations supplied explicitly, never discovered by evaluating package code. */
  contracts?: readonly Readonly<{
    before: InteractionContract;
    after: InteractionContract;
  }>[];
}>;

export type PackageArtifactComparison = Readonly<{
  version: 1;
  before: VerifiedPackageArtifact;
  after: VerifiedPackageArtifact;
  identity: Readonly<{
    sameName: boolean;
    sameVersion: boolean;
    sameContent: boolean;
    /** Null when either receipt was omitted; missing evidence is not equal bytes. */
    sameTarball: boolean | null;
    versionReusedWithDifferentContent: boolean;
  }>;
  files: ArtifactMemberDiff;
  exports: ArtifactMemberDiff & Readonly<{
    required: readonly string[];
    missingBefore: readonly string[];
    missingAfter: readonly string[];
  }>;
  /** Exact engines strings and changes; this does not solve semver or prove a runtime supports them. */
  runtimes: ArtifactMemberDiff;
  /** Directional declaration judgments only, with caller-supplied provenance. */
  contracts: Readonly<{
    source: "caller-supplied";
    deltas: readonly Readonly<{
      beforeId: string;
      afterId: string;
      delta: ContractDelta;
    }>[];
  }>;
}>;

function fail(message: string): never {
  throw new Error(`Invalid Boundary artifact comparison: ${message}`);
}

async function verifySource(source: PackageArtifactSource): Promise<VerifiedPackageArtifact> {
  if (!source || typeof source !== "object" || typeof source.root !== "string"
    || source.root.trim().length === 0) {
    fail("each source requires an explicit package root");
  }
  if (source.expected?.tarballDigest !== undefined && source.receiptPath === undefined) {
    fail("an expected tarball digest requires an explicit receiptPath");
  }
  const packed = source.receiptPath === undefined ? undefined : await verifyPackReceipt(
    source.receiptPath,
    { name: source.expected?.name, version: source.expected?.version },
  );
  if (packed && source.expected?.tarballDigest !== undefined
    && packed.receipt.tarball.sha256 !== source.expected.tarballDigest) {
    fail("tarball digest does not match the reviewed expected pin");
  }
  const content = await verifyContentManifest(source.root, source.expected);
  if (packed && (packed.receipt.package.name !== content.package.name
    || packed.receipt.package.version !== content.package.version
    || packed.receipt.contentDigest !== content.aggregateDigest)) {
    fail("the verified receipt does not identify the verified package content");
  }
  const metadata = await readArtifactMetadata(source.root, content);
  return freezeArtifact({
    root: source.root,
    content,
    metadata,
    ...(packed === undefined ? {} : { receipt: packed.receipt }),
  });
}

function memberDiff(
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): ArtifactMemberDiff {
  const result = { added: [] as string[], removed: [] as string[], changed: [] as string[], unchanged: [] as string[] };
  for (const name of [...new Set([...before.keys(), ...after.keys()])].sort(compareUtf8)) {
    if (!before.has(name)) result.added.push(name);
    else if (!after.has(name)) result.removed.push(name);
    else if (before.get(name) !== after.get(name)) result.changed.push(name);
    else result.unchanged.push(name);
  }
  return result;
}

function metadataEntries(values: Readonly<Record<string, JsonValue>>): ReadonlyMap<string, string> {
  return new Map(Object.entries(values).map(([name, value]) => [name, canonicalJson(value)]));
}

/**
 * Read-only verification and comparison of explicit artifacts. Integrity checks
 * fail closed; differences are reported for host review, never installed or
 * treated as signing, publisher authentication, or realization equivalence.
 */
export async function comparePackageArtifacts(
  options: PackageArtifactComparisonOptions,
): Promise<PackageArtifactComparison> {
  if (!options || typeof options !== "object") fail("options are required");
  const required = requiredExportNames(options.requiredExports ?? []);
  if (options.contracts !== undefined && !Array.isArray(options.contracts)) {
    fail("contracts must be an explicit list of before/after declarations");
  }
  const before = await verifySource(options.before);
  const after = await verifySource(options.after);
  const sameName = before.content.package.name === after.content.package.name;
  const sameVersion = before.content.package.version === after.content.package.version;
  const sameContent = before.content.aggregateDigest === after.content.aggregateDigest;
  const deltas = (options.contracts ?? []).map((pair) => ({
    beforeId: pair.before.id,
    afterId: pair.after.id,
    delta: contractChanges(pair.before, pair.after),
  })).sort((left, right) => compareUtf8(left.beforeId, right.beforeId) || compareUtf8(left.afterId, right.afterId));
  return freezeArtifact({
    version: 1,
    before,
    after,
    identity: {
      sameName,
      sameVersion,
      sameContent,
      sameTarball: before.receipt === undefined || after.receipt === undefined
        ? null : before.receipt.tarball.sha256 === after.receipt.tarball.sha256,
      versionReusedWithDifferentContent: sameName && sameVersion && !sameContent,
    },
    files: memberDiff(
      new Map(before.content.files.map((file) => [file.path, `${file.bytes}:${file.sha256}`])),
      new Map(after.content.files.map((file) => [file.path, `${file.bytes}:${file.sha256}`])),
    ),
    exports: {
      ...memberDiff(metadataEntries(before.metadata.exports), metadataEntries(after.metadata.exports)),
      required,
      missingBefore: required.filter((name) => !hasExportTarget(before.metadata.exports[name])),
      missingAfter: required.filter((name) => !hasExportTarget(after.metadata.exports[name])),
    },
    runtimes: memberDiff(metadataEntries(before.metadata.engines), metadataEntries(after.metadata.engines)),
    contracts: { source: "caller-supplied", deltas },
  });
}
