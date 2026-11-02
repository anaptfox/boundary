---
title: "Package artifact reference"
description: "Verify explicit Node package artifacts and compare consumer upgrade requirements without installing them."
---

# Package artifact reference

`@foxworth/boundary/artifact` is an optional **Node-only** capability. It owns the
package-content and adjacent pack-receipt algorithms used by Boundary's packaging
scripts. The root SDK and portable Program imports do not import this subpath.
Import it explicitly from a build, release, or consumer-maintenance tool.

## Verify supplied bytes

`verifyContentManifest(root, expected?)` checks `boundary-artifact.json`, its
versioned aggregate identity, the exact managed file set, and every file's byte
length and SHA-256. Optional expected `name`, `version`, and `aggregateDigest`
are reviewed pins supplied by the caller.

The v1 content algorithm excludes the manifest itself, a root `node_modules`
dependency tree, and root `.tgz` files and their adjacent receipts. It rejects
symbolic links inside package content. UTF-8 path ordering and the
`boundary.package-content/v1` identity domain remain the packaging algorithms.

`verifyPackReceipt(receiptPath, expected?)` validates one explicitly supplied
receipt and its named adjacent tarball's byte length and SHA-256. Expected
`name` and `version` are optional. It returns the checked receipt and tarball
path. This function checks archive bytes; it does not unpack the archive or prove
that its embedded content matches the receipt's `contentDigest` claim.

`readContentManifest` parses and validates the manifest's aggregate identity
without checking package files. `writeContentManifest` and `writePackReceipt`
are explicit packaging effects. The comparison never invokes them.

Integrity against a supplied manifest or receipt is not signing, publisher
authentication, authorization, or a behavior guarantee.

## Compare a consumer and candidate

```ts
import { comparePackageArtifacts } from "@foxworth/boundary/artifact";

const report = await comparePackageArtifacts({
  before: {
    root: installedPackageRoot,
    receiptPath: installedReceiptPath,
    expected: { aggregateDigest: reviewedInstalledContentDigest },
  },
  after: {
    root: unpackedCandidateRoot,
    receiptPath: candidateReceiptPath,
    expected: { aggregateDigest: reviewedCandidateContentDigest },
  },
  requiredExports: [".", "./program", "./control/host"],
  contracts: [{ before: installedContract, after: candidateContract }],
});

console.log(report.identity.versionReusedWithDifferentContent);
console.log(report.exports.missingAfter);
console.log(report.before.metadata.engines, report.after.metadata.engines);
console.log(report.contracts.deltas);
```

Both roots are required. Receipts and expected pins are optional, explicit
inputs. An expected `tarballDigest` requires `receiptPath`. Supplied receipts
must pass byte verification and identify the corresponding checked content
manifest's exact package name, version, and aggregate digest. Integrity failures
throw; they cannot become an upgrade report marked as verified.

The immutable version-1 report keeps these judgments separate:

| Field | Meaning |
| --- | --- |
| `before`, `after` | Verified content manifests, declared package exports/engines, and any verified supplied receipt. |
| `identity.sameContent` | Content aggregates are equal. |
| `identity.sameTarball` | Checked tarball digests are equal; `null` if either receipt was omitted. |
| `identity.versionReusedWithDifferentContent` | The package name and version match while the content aggregates differ. |
| `files` | Added, removed, changed, and unchanged content paths. |
| `exports` | Export-map differences and missing explicitly required declarations. |
| `runtimes` | Added, removed, changed, and unchanged `engines` keys; exact requirement strings remain in metadata. |
| `contracts` | `contractChanges` on caller-supplied before/after declarations, marked `source: "caller-supplied"`. |

Export requirements name exact declared subpaths. The tool does not expand
wildcard exports, infer requirements from imports, choose conditional export
branches, or evaluate module code. A null target supplies no export. A declared
conditional target is reported as declared; runtime resolution and successful
module evaluation remain separate checks.

Runtime requirements are reported as written, including minimums such as
`node: ">=24.21"`. The tool does not solve semver ranges or claim that a local
runtime supports the candidate. A runtime-requirement change deserves host
review independently of content changes.

Contract declarations are explicit inputs. The tool does not discover them by
executing package code, authenticate their provenance, or claim that their
schemas describe the private implementation. The existing directional
`contractChanges` judgment establishes declared compatibility only.

The comparison reads files without installing, fetching, updating, deleting, or
choosing a consumer migration. Hosts retain native-source provenance checks,
dependency refresh policy, packing, runtime acceptance, and the decision to
adopt a candidate. As with the underlying verifiers, observations concern bytes
read during the call; they do not lock a concurrently changing filesystem.
