import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// A developer installer used to prepare the app once. Everyday access is graphical.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const applications = path.join(homedir(), 'Applications');
const target = path.join(applications, 'AI Workforce.app');
const bundleId = 'local.ai-workforce.launcher';
if (process.platform !== 'darwin') throw new Error('This installer builds the macOS app launcher.');
mkdirSync(applications, { recursive: true });
if (existsSync(target)) {
  const identity = spawnSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(target, 'Contents/Info.plist')], { encoding: 'utf8' });
  if (identity.status !== 0 || identity.stdout.trim() !== bundleId) throw new Error('A different app already uses AI Workforce.app. It has been left untouched.');
}
const staging = mkdtempSync(path.join(applications, '.workforce-install-'));
const bundle = path.join(staging, 'AI Workforce.app');
const contents = path.join(bundle, 'Contents');
mkdirSync(path.join(contents, 'MacOS'), { recursive: true });
mkdirSync(path.join(contents, 'Resources/launcher'), { recursive: true });
const compile = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', path.join(root, 'scripts/launcher/AIWorkforce.swift'), '-o', path.join(contents, 'MacOS/AIWorkforce')], { encoding: 'utf8', timeout: 120000 });
if (compile.status !== 0) { rmSync(staging, { recursive: true, force: true }); throw new Error(`App compilation failed: ${compile.stderr}`); }
writeFileSync(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>AI Workforce</string>
<key>CFBundleDisplayName</key><string>AI Workforce</string>
<key>CFBundleExecutable</key><string>AIWorkforce</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>CFBundleVersion</key><string>1</string>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>13.0</string>
</dict></plist>
`);
writeFileSync(path.join(contents, 'Resources/workspace.json'), JSON.stringify({ repoRoot: root, nodePath: process.execPath }, null, 2));
cpSync(path.join(root, 'scripts/desktop-launch.mjs'), path.join(contents, 'Resources/desktop-launch.mjs'));
cpSync(path.join(root, 'scripts/launcher/settings.mjs'), path.join(contents, 'Resources/launcher/settings.mjs'));
const signed = spawnSync('/usr/bin/codesign', ['--force', '--sign', '-', bundle], { encoding: 'utf8' });
if (signed.status !== 0) { rmSync(staging, { recursive: true, force: true }); throw new Error(`Local app signing failed: ${signed.stderr}`); }
// Keep a verified prior installation until its replacement is in place.
const backup = path.join(staging, 'previous.app');
if (existsSync(target)) renameSync(target, backup);
try { renameSync(bundle, target); }
catch (error) { if (existsSync(backup)) renameSync(backup, target); throw error; }
rmSync(staging, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, installed: target, bundleId, sourceRoot: root, nodePath: process.execPath, localSourceLauncher: true }));
