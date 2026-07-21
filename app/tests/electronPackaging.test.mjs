import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

import { projectRoot, runtimePublicReferenceRoot } from './testPaths.mjs';

test('default startup routes to the title screen while ?initialScreen=debug opts into the academy-map tab bar', async () => {
  const html = await readFile(path.join(runtimePublicReferenceRoot, 'index.html'), 'utf8');
  const js = await readFile(path.join(runtimePublicReferenceRoot, 'app.js'), 'utf8');

  assert.match(html, /id="academy-map-screen" class="screen active"/, 'static HTML should still ship academy-map-active (the debug tab-bar layout); the server rewrites it to title-active for the default startup');
  assert.match(js, /new URLSearchParams\(window\.location\.search\)\.get\('initialScreen'\)/, 'front-end should read the initialScreen startup query');
  assert.match(js, /if \(initialScreen === null\) \{ showScreen\('title'\); return; \}/, 'an absent initialScreen query should be the default title startup');
  assert.match(js, /if \(initialScreen === 'debug'\) return;/, '?initialScreen=debug should keep the server-served academy-map tab-bar layout without a screen switch');
  assert.match(js, /throw new Error\(`unknown initialScreen override: \$\{initialScreen\}`\);/, 'an unknown initialScreen value should fail fast, not silently default');
  assert.doesNotMatch(js, /requestedInitialScreen/, 'the removed explicit title-startup helper should leave no trace in the front-end');
  assert.match(js, /Promise\.all\(\[[\s\S]*refreshSaveSlots\(\),[\s\S]*refresh\(\)[\s\S]*\]\)\.then\(\(\)\s*=>\s*applyInitialScreenOverride\(\)\)/, 'startup override should apply only after the normal refresh boot completes');
});

test('electron packaging declares a real app icon, app display name, and centralized packaged title entry policy', async () => {
  const appDisplayName = 'STARFALL MAGIC ACADEMY';
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const publicHtml = await readFile(path.join(runtimePublicReferenceRoot, 'index.html'), 'utf8');
  const electronMain = await readFile(path.join(projectRoot, 'electron/main.mjs'), 'utf8');
  const windowLifecycle = await readFile(path.join(projectRoot, 'app/src/electron/windowLifecycle.mjs'), 'utf8');
  const windowsTargets = packageJson.build?.win?.target ?? [];
  const nsisTarget = windowsTargets.find((target) => target?.target === 'nsis');

  assert.equal(packageJson.build?.productName, appDisplayName, 'packaged app bundle should use the approved STARFALL MAGIC ACADEMY display name');
  assert.match(publicHtml, /<title>STARFALL MAGIC ACADEMY<\/title>/, 'browser document title should use the app display name');
  assert.match(publicHtml, /<h1>STARFALL MAGIC ACADEMY<\/h1>/, 'top-level browser heading should use the app display name');
  assert.match(electronMain, /STARFALL MAGIC ACADEMY Electron runtime listening/, 'Electron smoke log should identify the app display name');
  assert.match(electronMain, /STARFALL MAGIC ACADEMY を起動できません/, 'Electron startup error dialog should identify the app display name');
  assert.equal(packageJson.build?.icon, 'assets/app-icons/sera-neutral.icns', 'packaging should declare the generated Sera-neutral icns file as the app icon');
  assert.equal(packageJson.scripts?.['electron:mac'], 'electron-builder --mac dmg zip', 'package scripts should expose a dedicated macOS packaging command');
  assert.equal(packageJson.scripts?.['electron:win'], 'electron-builder --win nsis --x64', 'package scripts should expose a dedicated Windows packaging command');
  assert.equal(packageJson.build?.win?.icon, 'assets/app-icons/sera-neutral.ico', 'Windows packaging should declare the generated Sera-neutral ico file as the app icon');
  assert.equal(packageJson.build?.mac?.hardenedRuntime, true, 'macOS signing should opt into hardened runtime explicitly');
  assert.equal(packageJson.build?.mac?.gatekeeperAssess, false, 'macOS signing should not rely on local Gatekeeper assessment before notarization');
  assert.equal(packageJson.build?.mac?.strictVerify, false, 'macOS ad-hoc signing should avoid @electron/osx-sign emitting invalid --strict=true; strict verification runs after packaging');
  assert.equal(packageJson.build?.mac?.entitlements, 'build/entitlements.mac.plist', 'macOS signing should use explicit Electron entitlements');
  assert.equal(packageJson.build?.mac?.entitlementsInherit, 'build/entitlements.mac.inherit.plist', 'macOS helper signing should use inherited entitlements');
  assert.equal(packageJson.build?.mac?.preAutoEntitlements, false, 'ad-hoc packaging should not try to synthesize team-id entitlements');
  assert.equal(packageJson.build?.mac?.timestamp, 'none', 'ad-hoc signing should disable timestamping instead of asking Apple timestamp servers');
  assert.equal(packageJson.build?.mac?.notarize, false, 'ad-hoc packaging should not pretend to notarize without Developer ID credentials');
  assert.equal(packageJson.build?.mac?.sign, 'scripts/sign-macos.mjs', 'macOS packaging should run a custom signing hook instead of emitting a half-signed Electron app');
  assert.equal(packageJson.build?.mac?.forceCodeSigning, true, 'macOS packaging should fail if the custom sign hook does not run');
  await access(path.join(projectRoot, packageJson.build.mac.entitlements));
  await access(path.join(projectRoot, packageJson.build.mac.entitlementsInherit));
  const signHook = await readFile(path.join(projectRoot, packageJson.build.mac.sign), 'utf8');
  assert.match(signHook, /@electron\/osx-sign/, 'macOS signing hook should use Electron-aware bundle signing order');
  assert.match(signHook, /identity:\s*'-'/, 'macOS signing hook should use ad-hoc codesign identity when no Developer ID identity is installed');
  assert.match(signHook, /identityValidation:\s*false/, 'ad-hoc signing identity should not be keychain-validated');
  assert.match(signHook, /preAutoEntitlements:\s*false/, 'ad-hoc signing should keep explicit entitlements instead of synthesizing team-id values');
  assert.ok(nsisTarget, 'Windows packaging should declare an explicit NSIS target');
  assert.deepEqual(nsisTarget.arch, ['x64'], 'Windows packaging should constrain the first shipping target to x64');
  assert.match(windowLifecycle, /export function resolveMainWindowEntryUrl/, 'window lifecycle should define a dedicated helper for main-window entry URL policy');
  assert.match(windowLifecycle, /return isPackaged \? new URL\('\/', runtimeUrl\)\.toString\(\) : runtimeUrl;/, 'packaged entry should load the site root (the default title startup), with no initialScreen query dependency');
  assert.match(electronMain, /resolveMainWindowEntryUrl\(\{ runtimeUrl: started\.url, isPackaged: app\.isPackaged \}\)/, 'initial launch should use the centralized entry URL policy');
  assert.match(electronMain, /resolveMainWindowEntryUrl\(\{ runtimeUrl, isPackaged: app\.isPackaged \}\)/, 'activate reopen should use the same centralized entry URL policy');
  await access(path.join(projectRoot, packageJson.build.icon));
  await access(path.join(projectRoot, packageJson.build.win.icon));
});

test('electron packaging bundles canonical BGM assets but excludes the source WAV originals庫', async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, 'package.json'), 'utf8'));
  const files = packageJson.build?.files ?? [];

  assert.ok(files.includes('assets/**/*'), 'packaging should still include the canonical assets tree (canonical BGM lives under assets/canonical/bgm)');
  assert.ok(files.includes('!assets/original/**'), 'packaging must exclude the gitignored source WAV 原本庫 assets/original from the shipped bundle');
  assert.ok(
    files.indexOf('!assets/original/**') > files.indexOf('assets/**/*'),
    'the assets/original exclusion must follow the assets include so electron-builder subtracts the originals'
  );

  // The adopted takes are Ogg Opus files served from the canonical tree; the source WAVs stay under assets/original.
  await access(path.join(projectRoot, 'assets/canonical/bgm/v1-moonlit.ogg'));
});
