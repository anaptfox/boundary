# Maintainer release runbook

Boundary publishes one npm package, `@foxworth/boundary`. CI stages each release
through npm trusted publishing. A staged version cannot be installed until a
maintainer approves it with 2FA. No npm token exists in CI, the repository, or
its secrets. npm's trust config for the package allows `release.yml` in
environment `npm` to stage, and nothing else. Rust crates are not published.

## Release

1. **Bump.** Change `version` in `packages/package.json` (Cargo follows; the
   architecture check enforces it) in a reviewed commit on `main`. Wait for that
   commit's CI to pass.
2. **Rehearse.** In GitHub Actions, run **Release** with the version, the dist-tag,
   and `dry-run` checked. Prereleases must use `next`. The run:
   - refuses unless CI passed for the exact commit
   - builds the candidate twice and requires identical bytes
   - checks both Zod peers
   - records the tarball's integrity in the run summary
   - runs `npm publish --dry-run`
3. **Stage.** Run **Release** again with `dry-run` unchecked. The stage job runs
   `npm stage publish --provenance`. Nobody can install the version yet.
4. **Review.** Find the stage ID with `npm stage list @foxworth/boundary`, then run:

   ```console
   just release-review <stage-id> <release-run-id>
   ```

   It downloads the run's candidate and the staged tarball, requires them to be
   byte-identical, and prints the version, exports, peers, and file layout.
5. **Approve.** Run `npm stage approve <stage-id>`. npm asks for 2FA. If anything
   looks wrong, run `npm stage reject <stage-id>` instead.
6. **Verify.** Run `just release-verify <release-run-id>`. It checks that npm serves the
   candidate's exact bytes, runs `npm audit signatures` on a fresh install, and
   imports the package. Then tag the release commit `v<version>` and push the tag.

## Mistakes

- A published version can never be reused, even after unpublish.
- Fix a bad release with a new version and `npm deprecate @foxworth/boundary@<version> "<reason>"`.
  Never unpublish.

## One-time npm setup

- Turn on 2FA with a security key for the account that owns `@foxworth`.
- Create the trust config:

  ```console
  npm trust github @foxworth/boundary --file release.yml --repo anaptfox/boundary --env npm --allow-stage-publish
  ```

  Grant stage publish only, never direct publish or dist-tag. The first stage
  must happen within 48 hours, or the config expires.
- After the first release, set the package to "Require two-factor
  authentication and disallow tokens".
- Run `npm trust list @foxworth/boundary` every quarter. Re-create trust after
  any repository rename or transfer.
- Provenance requires a public repository. Never publish from a private one:
  every later version must keep provenance.
