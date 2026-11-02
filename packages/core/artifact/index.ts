/** Node-only package integrity and explicit consumer upgrade inspection. */
export {
  CONTENT_MANIFEST_FILE,
  CONTENT_MANIFEST_VERSION,
  PACK_RECEIPT_SUFFIX,
  PACK_RECEIPT_VERSION,
  readContentManifest,
  verifyContentManifest,
  verifyPackReceipt,
  writeContentManifest,
  writePackReceipt,
  type ArtifactDigest,
  type ContentManifest,
  type PackReceipt,
} from "./integrity";
export {
  comparePackageArtifacts,
  type PackageArtifactSource,
  type VerifiedPackageArtifact,
  type PackageArtifactComparisonOptions,
  type PackageArtifactComparison,
  type ArtifactMemberDiff,
} from "./comparison";
export type { ArtifactPackageMetadata } from "./metadata";
