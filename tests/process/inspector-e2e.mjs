// Built archive -> offline installed consumer -> actual browser + localhost host.
// Playwright is a pinned workspace dev dependency. Its browsers live in
// Playwright's own revision-specific cache (PLAYWRIGHT_BROWSERS_PATH, or the
// default ms-playwright cache), so a missing browser is detected by Playwright
// itself: launching throws "Executable doesn't exist" with the install command.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { verifyContentManifest, verifyPackReceipt } from '../../packages/core/artifact/integrity.ts';

const playwright = fileURLToPath(import.meta.resolve('playwright'));
try {
  const probe = await chromium.launch({ headless: true });
  await probe.close();
} catch (error) {
  if (!String(error?.message).includes("Executable doesn't exist")) throw error;
  console.error('blocked: Playwright\'s headless Chromium is not installed for this Playwright version; run: just browsers');
  process.exit(1);
}
const { version } = JSON.parse(readFileSync('packages/package.json', 'utf8'));
const artifactRoot = path.resolve('dist/boundary');
if (!existsSync(path.join(artifactRoot, 'package.json')) || !existsSync('node_modules/zod')) {
  console.error('blocked: built dist/boundary and the installed workspace Zod peer are required');
  process.exit(1);
}
const temp = mkdtempSync(path.join(tmpdir(), 'boundary-inspector-e2e-'));
try {
  const report = JSON.parse(execFileSync(process.execPath, ['scripts/build/pack-artifact.mjs', '--root', artifactRoot, '--output', temp], { encoding: 'utf8' }));
  const verified = await verifyPackReceipt(report.receipt, { name: '@foxworth/boundary', version });
  await verifyContentManifest(artifactRoot, { name: '@foxworth/boundary', version, aggregateDigest: verified.receipt.contentDigest });
  const consumer = path.join(temp, 'consumer');
  execFileSync('npm', ['install', '--offline', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', path.join(temp, 'npm-cache'), '--prefix', consumer, verified.tarballPath], { stdio: 'inherit' });
  symlinkSync(realpathSync('node_modules/zod'), path.join(consumer, 'node_modules/zod'), 'dir');
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
  console.log(`inspector archive=${verified.tarballPath} receipt=${report.receipt} sha256=${verified.receipt.tarball.sha256} content=${verified.receipt.contentDigest} source=${commit} dirty=${dirty}`);
  execFileSync(process.execPath, ['tests/process/inspector-browser.mjs', consumer, playwright], { stdio: 'inherit', timeout: 120000 });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
