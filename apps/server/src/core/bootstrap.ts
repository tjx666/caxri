import { enableCompileCache } from 'node:module';
import process from 'node:process';

/**
 * Server Core's build entry. ESM compiles every static import before any module body runs, so the Node compile cache
 * must be enabled here, ahead of the dynamic import that loads the real Server Core graph. Packaged Desktop sets
 * `CAXRI_COMPILE_CACHE_DIR`; Server Core's own children do not inherit it.
 *
 * @see https://nodejs.org/api/module.html#module-compile-cache
 */
const compileCacheDirectory = process.env.CAXRI_COMPILE_CACHE_DIR;
if (compileCacheDirectory) {
    try {
        enableCompileCache(compileCacheDirectory);
    } catch {
        // A cache that cannot be enabled only costs the speedup.
    }
}

// `process.ts` flushes the cache once Server Core is ready; its top-level await settles only at shutdown.
await import('./process');
