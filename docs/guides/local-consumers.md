---
title: "Use Boundary locally"
description: "Install a packed Boundary snapshot in another project, verify it, and bundle it correctly."
---

# Use Boundary locally

External projects consume the generated npm package. Boundary's own workspace
examples use source for development; a sibling project should use a packed
snapshot to exercise the same exports, JavaScript, declarations, and assets
that publishing will deliver.

From this checkout, using its pinned Node and pnpm versions:

```console
just pack
```

This builds `dist/boundary/` and prints the tarball path, adjacent receipt,
tarball SHA-256, and content digest. Record those identities, the source commit,
and whether the worktree is dirty. A dirty snapshot includes uncommitted work;
its commit alone does not identify its contents. Keep one build or packing
invocation active per checkout.

Copy the tarball and receipt into the consuming project's own vendor directory.
Replace `<VERSION>` and `<SHA256_HEX>` below with the reported package version
and the full tarball SHA-256 without its `sha256:` prefix, and `<ZOD_PEER_RANGE>`
with `peerDependencies.zod` from the generated package manifest. Run these commands
from the consumer, substituting the actual Boundary checkout path:

```console
mkdir -p vendor/boundary/<SHA256_HEX>
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz vendor/boundary/<SHA256_HEX>/
cp /path/to/boundary/dist/boundary/foxworth-boundary-<VERSION>.tgz.receipt.json vendor/boundary/<SHA256_HEX>/
pnpm add "file:vendor/boundary/<SHA256_HEX>/foxworth-boundary-<VERSION>.tgz" "zod@<ZOD_PEER_RANGE>"
```

Use the consumer's existing package manager (`npm install` accepts the same
file specifier). Install the Zod peer range from the generated package manifest
for host/root imports; `/program` can be used without Zod. Install other peers
only for the selected integrations, using that manifest's ranges:

| Import | Runtime peer |
| --- | --- |
| `/react` | `react` |
| `/mcp` | `@modelcontextprotocol/server` |
| `/frameworks/hono`, `/frameworks/trpc`, `/frameworks/vite` | `hono`, `@trpc/server`, `vite`, respectively |
| `/electron`, `/electron/ipc` | `electron` |
| `/yjs`, `/automerge` | `yjs`, `@automerge/automerge`, respectively |
| `/plugin` | `@bytecodealliance/jco` |

Keep each vendored digest directory unchanged. Refresh by packing again,
copying the new snapshot, and installing its new relative path. Different bytes
can have the same development version; version equality does not prove freshness.
Commit the selected vendor snapshot, receipt, manifest, and lockfile together
according to the consumer's repository policy. Reinstalling then uses the
consumer's retained snapshot without depending on this checkout.

## Verify the installed snapshot

Run this in the consumer with its receipt path. It checks the archive and the
installed package's actual file set and contents, and prints the resolved
location and identities:

```sh
node --input-type=module - "vendor/boundary/<SHA256_HEX>/foxworth-boundary-<VERSION>.tgz.receipt.json" <<'NODE'
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyPackReceipt, verifyContentManifest } from "@foxworth/boundary/artifact";

const packed = await verifyPackReceipt(process.argv[2], { name: "@foxworth/boundary" });
const root = path.dirname(fileURLToPath(import.meta.resolve("@foxworth/boundary/package.json")));
const content = await verifyContentManifest(root, {
  ...packed.receipt.package,
  aggregateDigest: packed.receipt.contentDigest,
});
console.log({ root, package: content.package, sha256: packed.receipt.tarball.sha256,
  contentDigest: content.aggregateDigest });
NODE
```

A mismatch means the selected installed bytes differ: update the dependency
path and lockfile, then verify again. If resolution reaches workspace source,
remove the source alias or link and install the snapshot. This checks the
ordinary Node package resolution path, including pnpm installations; it does
not inspect every bundler alias or prove application behavior. Run the
consumer's type checks, tests, build, and relevant runtime checks separately.
Report artifact verification and those checks separately; a receipt proves
integrity against supplied evidence, not publisher authenticity.

## Bundling and publishing

Applications own one installed Boundary package and import its public subpaths.
Reusable libraries declare Boundary as a peer, use a development dependency
for their own tests, and externalize `@foxworth/boundary` plus every subpath
from their distribution. Native objects carry private module-instance identity;
mixing source and built packages or bundling a second copy can reject otherwise
valid implementations and Bindings. Keep those authenticity checks intact.

Browser applications bundle the supported `/client` and `/react` entries and
explicitly import `/react/styles.css` when needed. Node servers externalize
Boundary and retain the installed package, including `/plugin` worker assets
resolved relative to the package. The generated package ships JavaScript and
declarations; consumers do not need a source alias or TypeScript transpilation
rule solely for Boundary. A mutable `dist/boundary/` directory or global link
is not the supported external local dependency.

Once published, replace the local file dependency with an explicit published
version, update the consumer lockfile, and repeat its checks. Imports and public
subpaths stay the same. The initial registry installation will be:

```console
pnpm add "@foxworth/boundary@<PUBLISHED_VERSION>" "zod@<ZOD_PEER_RANGE>"
```

Publication follows the [maintainer release runbook](../../scripts/release/README.md):
CI stages the reproducible candidate for an accepted commit, and a maintainer
releases it with 2FA after checking it matches. Local tarballs and receipts are
never staged or published. Published name/version pairs cannot be reused for different bytes.
