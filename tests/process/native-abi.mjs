// The runner stages only the public header, native libraries and consumer source.
// The executed hosts use the native library directly; Node only composes this proof.
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const target = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(root, 'target'), 'debug');
const system = process.platform;
if (system !== 'darwin' && system !== 'linux') throw new Error(`blocked: native ABI proof does not yet support ${system}`);
const cc = process.env.CC || 'cc';
const cxx = process.env.CXX || 'c++';
const library = system === 'darwin' ? 'libboundary_ffi.dylib' : 'libboundary_ffi.so';
const archive = 'libboundary_ffi.a';
for (const file of [path.join(target, library), path.join(target, archive), path.join(root, 'crates/boundary-ffi/include/boundary.h')]) {
  if (!existsSync(file)) throw new Error(`blocked: ${file} missing; run just native-abi-build`);
}
const temp = mkdtempSync(path.join(tmpdir(), 'boundary-native-abi-'));
const prefix = path.join(temp, 'prefix');
const moved = path.join(temp, 'relocated');
const digest = file => `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
const run = (cmd, args, options = {}) => execFileSync(cmd, args, { stdio: 'inherit', timeout: 120_000, ...options });
try {
  for (const directory of ['include', 'lib', 'bin', 'src']) mkdirSync(path.join(prefix, directory), { recursive: true });
  for (const [src, dest] of [
    [path.join(root, 'crates/boundary-ffi/include/boundary.h'), 'include/boundary.h'],
    [path.join(target, library), `lib/${library}`],
    [path.join(target, archive), `lib/${archive}`],
    [path.join(root, 'examples/concepts/c/native-host.c'), 'src/native-host.c'],
    [path.join(root, 'examples/concepts/c/header-cxx.cpp'), 'src/header-cxx.cpp'],
  ]) copyFileSync(src, path.join(prefix, dest));
  console.log(`native ABI staged ${system}/${process.arch}; header=${digest(path.join(prefix, 'include/boundary.h'))} shared=${digest(path.join(prefix, 'lib', library))} static=${digest(path.join(prefix, 'lib', archive))}`);
  const symbols = execFileSync('nm', system === 'darwin' ? ['-gU', path.join(prefix, 'lib', library)] : ['-D', '--defined-only', path.join(prefix, 'lib', library)], { encoding: 'utf8' });
  if (!symbols.includes('boundary_abi_version')) throw new Error('shared library missing ABI version export');
  // The header is hand-written: every exported boundary_* function must be
  // declared in it, and every declaration must be exported.
  const exported = new Set([...symbols.matchAll(/\b_?(boundary_[a-z0-9_]+)\b/gu)].map((m) => m[1]));
  const header = readFileSync(path.join(prefix, 'include/boundary.h'), 'utf8');
  const declared = new Set([...header.matchAll(/\b(boundary_[a-z0-9_]+)\s*\(/gu)].map((m) => m[1]));
  const undeclared = [...exported].filter((name) => !declared.has(name));
  const missing = [...declared].filter((name) => !exported.has(name));
  if (undeclared.length || missing.length) {
    throw new Error(`header and exports differ; undeclared: ${undeclared.join(', ') || 'none'}; not exported: ${missing.join(', ') || 'none'}`);
  }
  if (system === 'darwin') {
    const installName = execFileSync('otool', ['-D', path.join(prefix, 'lib', library)], { encoding: 'utf8' }).trim().split('\n').at(-1);
    if (installName !== `@rpath/${library}`) throw new Error(`shared library is not relocatable: install name ${installName}`);
  }
  const common = ['-Wall', '-Wextra', '-Werror', '-I', path.join(prefix, 'include')];
  const rpath = system === 'darwin' ? '@loader_path/../lib' : '$ORIGIN/../lib';
  run(cc, ['-std=c11', ...common, path.join(prefix, 'src/native-host.c'), '-L', path.join(prefix, 'lib'), '-lboundary_ffi', `-Wl,-rpath,${rpath}`, '-o', path.join(prefix, 'bin/dynamic-host')]);
  run(cxx, ['-std=c++17', ...common, path.join(prefix, 'src/header-cxx.cpp'), '-L', path.join(prefix, 'lib'), '-lboundary_ffi', `-Wl,-rpath,${rpath}`, '-o', path.join(prefix, 'bin/cxx-host')]);
  if (system === 'darwin') {
    for (const name of ['dynamic-host', 'cxx-host']) {
      const dependencies = execFileSync('otool', ['-L', path.join(prefix, 'bin', name)], { encoding: 'utf8' });
      if (!dependencies.includes(`@rpath/${library}`) || dependencies.includes(target)) throw new Error(`${name} does not load the staged dylib`);
    }
  } else {
    for (const name of ['dynamic-host', 'cxx-host']) {
      const dependencies = execFileSync('readelf', ['-d', path.join(prefix, 'bin', name)], { encoding: 'utf8' });
      if (!dependencies.includes(`[${library}]`) || dependencies.includes(target)) throw new Error(`${name} does not load the staged shared object`);
    }
  }
  const nativeLibs = system === 'darwin' ? ['-liconv', '-lresolv', '-framework', 'Security', '-framework', 'CoreFoundation'] : ['-ldl', '-lpthread', '-lm'];
  run(cc, ['-std=c11', '-DBOUNDARY_STATIC', ...common, path.join(prefix, 'src/native-host.c'), path.join(prefix, 'lib', archive), ...nativeLibs, '-o', path.join(prefix, 'bin/static-host')]);
  const staticDeps = execFileSync(system === 'darwin' ? 'otool' : 'readelf', [system === 'darwin' ? '-L' : '-d', path.join(prefix, 'bin/static-host')], { encoding: 'utf8' });
  if (staticDeps.includes(library) || staticDeps.includes(target)) throw new Error('static consumer unexpectedly depends on the shared Boundary library');
  // Relative loader paths must survive moving the staged prefix after linking.
  renameSync(prefix, moved);
  const env = { ...process.env };
  delete env.DYLD_LIBRARY_PATH; delete env.DYLD_FALLBACK_LIBRARY_PATH; delete env.LD_LIBRARY_PATH; delete env.LD_PRELOAD;
  for (const executable of ['dynamic-host', 'cxx-host', 'static-host']) run(path.join(moved, 'bin', executable), [], { cwd: temp, env });
  const sanitizer = spawnSync(cc, ['-std=c11', ...common.map(arg => arg === path.join(prefix, 'include') ? path.join(moved, 'include') : arg), '-fsanitize=address,undefined', '-fno-omit-frame-pointer', path.join(moved, 'src/native-host.c'), '-L', path.join(moved, 'lib'), '-lboundary_ffi', `-Wl,-rpath,${rpath}`, '-o', path.join(moved, 'bin/sanitized-host')], { encoding: 'utf8', timeout: 120_000 });
  if (sanitizer.error) throw sanitizer.error;
  if (sanitizer.status !== 0) throw new Error(`blocked: C compiler could not build ASan/UBSan consumer: ${sanitizer.stderr}`);
  run(path.join(moved, 'bin/sanitized-host'), [], { cwd: temp, env });
  console.log('native ABI proof passed: relocated shared C/C++, static C, and ASan/UBSan-instrumented C consumer (Rust library not sanitizer-instrumented)');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
