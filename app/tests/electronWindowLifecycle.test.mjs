import test from 'node:test';
import assert from 'node:assert/strict';

import { attachWindowLifecycle, resolveMainWindowEntryUrl, shouldCreateMainWindowOnActivate } from '../src/electron/windowLifecycle.mjs';

test('attachWindowLifecycle clears the tracked main window reference when the window closes', async () => {
  const handlers = new Map();
  const window = {
    once(event, handler) {
      handlers.set(event, handler);
    }
  };
  let cleared = 0;

  attachWindowLifecycle(window, {
    onClosed() {
      cleared += 1;
    }
  });

  assert.equal(typeof handlers.get('closed'), 'function');
  handlers.get('closed')();
  assert.equal(cleared, 1);
});

test('resolveMainWindowEntryUrl keeps runtimeUrl raw for non-packaged runs and loads the site root (default title startup) for packaged entry', async () => {
  assert.equal(resolveMainWindowEntryUrl({ runtimeUrl: 'http://127.0.0.1:41731', isPackaged: false }), 'http://127.0.0.1:41731');
  assert.equal(resolveMainWindowEntryUrl({ runtimeUrl: 'http://127.0.0.1:41731', isPackaged: true }), 'http://127.0.0.1:41731/');
});

test('shouldCreateMainWindowOnActivate only allows reopen when a runtime URL exists and no reusable window remains', async () => {
  assert.equal(shouldCreateMainWindowOnActivate({ mainWindow: null, runtimeUrl: null }), false);
  assert.equal(shouldCreateMainWindowOnActivate({ mainWindow: null, runtimeUrl: 'http://127.0.0.1:41731' }), true);
  assert.equal(shouldCreateMainWindowOnActivate({ mainWindow: { isDestroyed: () => false }, runtimeUrl: 'http://127.0.0.1:41731' }), false);
  assert.equal(shouldCreateMainWindowOnActivate({ mainWindow: { isDestroyed: () => true }, runtimeUrl: 'http://127.0.0.1:41731' }), true);
});
