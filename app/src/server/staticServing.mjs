import { promises as fs } from 'node:fs';
import path from 'node:path';

import { sendText } from './httpHelpers.mjs';

async function serveFile(res, fullPath, allowedRoot) {
  const relative = path.relative(allowedRoot, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendText(res, 'forbidden', 403);
  try {
    const body = await fs.readFile(fullPath);
    const ext = path.extname(fullPath);
    const type = ext === '.css'
      ? 'text/css; charset=utf-8'
      : ext === '.js'
        ? 'text/javascript; charset=utf-8'
        : ext === '.png'
          ? 'image/png'
          : ext === '.jpg' || ext === '.jpeg'
            ? 'image/jpeg'
            : ext === '.json'
              ? 'application/json; charset=utf-8'
              : ext === '.md'
                ? 'text/markdown; charset=utf-8'
                : ext === '.ogg'
                  ? 'audio/ogg'
                  : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    sendText(res, 'not found', 404);
  }
}

async function fileExists(fullPath) {
  try {
    await fs.access(fullPath);
    return true;
  } catch {
    return false;
  }
}

function replaceRequired(html, from, to) {
  if (!html.includes(from)) throw new Error(`index.html is missing expected initial-screen marker: ${from}`);
  return html.replace(from, to);
}

// The debug tab-bar startup (?initialScreen=debug) plus every dev-only screen entry the front-end
// (applyInitialScreenOverride) switches to after boot. The static index.html already ships the academy-map-active
// layout with the debug topbar, so these values are served unchanged and the front-end lands the actual screen.
const DEBUG_INITIAL_SCREENS = new Set([
  'debug',
  'conversation-day',
  'academy-errand',
  'academy-alchemy',
  'academy-study-circle',
  'academy-workshop',
  'academy-library',
  'academy-atelier',
  'academy-arena',
  'academy-auction',
  'academy-lounge'
]);

// Default startup (no initialScreen query) is the title screen: the static academy-map-active HTML is rewritten
// to title-active here so the debug topbar is never painted before app.js runs (flash-free). Every value in
// DEBUG_INITIAL_SCREENS is served unchanged (academy-map-active), so ?initialScreen=debug and the dev entries need
// no rewrite. An unknown value never reaches this function — serveInitialScreenIndex rejects it with 400 first.
function applyInitialScreenHtml(html, initialScreen) {
  if (initialScreen !== null) return html;
  return [
    ['<body>', '<body class="title-screen-active">'],
    ['data-screen="title">タイトル</button>', 'data-screen="title" class="active">タイトル</button>'],
    ['data-screen="academy-map" class="active">学院マップ</button>', 'data-screen="academy-map">学院マップ</button>'],
    ['id="title-screen" class="screen title-hero-screen"', 'id="title-screen" class="screen title-hero-screen active"'],
    ['id="academy-map-screen" class="screen active"', 'id="academy-map-screen" class="screen"']
  ].reduce((updatedHtml, [from, to]) => replaceRequired(updatedHtml, from, to), html);
}

async function serveInitialScreenIndex(res, fullPath, allowedRoot, initialScreen) {
  const relative = path.relative(allowedRoot, fullPath);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return sendText(res, 'forbidden', 403);
  // An initialScreen query with an unknown value is a hard error, not a silent fall-through to the default title
  // startup — matching the front-end applyInitialScreenOverride guard. Only an absent query (null) or a known
  // DEBUG_INITIAL_SCREENS value is served.
  if (initialScreen !== null && !DEBUG_INITIAL_SCREENS.has(initialScreen)) {
    return sendText(res, `unknown initialScreen: ${initialScreen}`, 400);
  }
  try {
    const html = await fs.readFile(fullPath, 'utf8');
    const responseHtml = applyInitialScreenHtml(html, initialScreen);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(responseHtml);
  } catch {
    sendText(res, 'not found', 404);
  }
}

async function servePublicFile(res, target, { publicRoot, initialScreen = null } = {}) {
  const primaryPath = path.join(publicRoot, target);
  if (target === 'index.html') return serveInitialScreenIndex(res, primaryPath, publicRoot, initialScreen);
  if (await fileExists(primaryPath)) return serveFile(res, primaryPath, publicRoot);
  return serveFile(res, primaryPath, publicRoot);
}

async function serveCanonicalAssetFile(res, filename, canonicalAssetsRoot) {
  return serveFile(res, path.join(canonicalAssetsRoot, filename), canonicalAssetsRoot);
}

function resolveGeneratedCompatibilityPath(filename) {
  if (filename.startsWith('backgrounds/')) return filename;
  if (filename.startsWith('title/')) return filename;
  if (filename.startsWith('load/')) return filename;
  if (filename.startsWith('card_images/')) return `ui/${filename}`;
  if (filename.startsWith('character_visual_sets/')) return filename;
  if (filename.startsWith('character_faces_400/')) {
    const [, visualSetId, ...rest] = filename.split('/');
    if (!visualSetId || rest.length === 0) return null;
    return `character_visual_sets/${visualSetId}/face_emotions/${rest.join('/')}`;
  }
  return null;
}

async function serveGeneratedCompatibilityFile(res, filename, canonicalAssetsRoot) {
  const canonicalPath = resolveGeneratedCompatibilityPath(filename);
  if (!canonicalPath) return sendText(res, 'not found', 404);
  return serveCanonicalAssetFile(res, canonicalPath, canonicalAssetsRoot);
}

export async function serveStatic(req, res, url, context) {
  const { publicRoot, canonicalAssetsRoot } = context;
  if (url.pathname.startsWith('/canonical/')) {
    const filename = decodeURIComponent(url.pathname.replace(/^\/canonical\//, ''));
    return serveCanonicalAssetFile(res, filename, canonicalAssetsRoot);
  }
  if (url.pathname.startsWith('/generated/')) {
    const filename = decodeURIComponent(url.pathname.replace(/^\/generated\//, ''));
    return serveGeneratedCompatibilityFile(res, filename, canonicalAssetsRoot);
  }
  const target = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
  return servePublicFile(res, target, { publicRoot, initialScreen: url.searchParams.get('initialScreen') });
}
