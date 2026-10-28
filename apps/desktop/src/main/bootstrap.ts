import { enableCompileCache, flushCompileCache } from 'node:module';
import { join } from 'node:path';
import process from 'node:process';

import { app } from 'electron';

import { holdOpenFileRequests } from './external-activation/open-file-requests';

holdOpenFileRequests(app);

/**
 * Main's build entry. ESM compiles every static import before any module body runs, so the Node compile cache must be
 * enabled here, ahead of the dynamic import that loads the real Main graph (`index.ts`). Packaged builds only: a dev
 * build changes on every edit and gains nothing from a cache. The directory mirrors the profile selection in
 * `desktop-profile.ts`; a cache written for another profile would still be valid, since entries are keyed by content.
 *
 * @see https://nodejs.org/api/module.html#module-compile-cache
 */
if (app.isPackaged) {
    const directory = join(
        process.env.CAXRI_USER_DATA_DIR ?? app.getPath('userData'),
        'compile-cache',
    );
    // Server Core's launch environment forwards this (`server-launch-environment.ts`).
    process.env.CAXRI_COMPILE_CACHE_DIR = directory;
    try {
        enableCompileCache(directory);
    } catch {
        // A cache that cannot be enabled only costs the speedup.
    }
}

async function loadMain(): Promise<void> {
    await import('./index');
    // Node otherwise writes the cache only on a normal exit, which a crash, `app.exit()`, or SIGKILL skips.
    if (app.isPackaged) flushCompileCache();
}

// Top-level await is unavailable in this bundle target, so the load is fire-and-forget; a load failure must still
// crash Main loudly instead of leaving a windowless process behind.
// eslint-disable-next-line unicorn/prefer-await -- see comment above
loadMain().catch((error: unknown) => {
    console.error(error);
    app.exit(1);
});
