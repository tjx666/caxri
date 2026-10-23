import { readdir, readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '../..');
const allowedSpec = 'e2e/startup.performance.e2e.ts';

async function filesUnder(directory: string, pattern: RegExp): Promise<string[]> {
    const entries = await readdir(join(root, directory), { recursive: true, withFileTypes: true });
    return entries
        .filter((entry) => entry.isFile() && pattern.test(entry.name))
        .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/**
 * E2E retries can turn an original red result green, so they are banned except for one narrow, documented case: the
 * packaged startup budget in the Release pools (issue #1418, `e2e-testing` skill).
 */
describe('E2E retry exception', () => {
    it('configures Playwright retries only in the startup performance spec', async () => {
        const files = [
            'playwright.config.ts',
            ...(await filesUnder('e2e', /\.ts$/u)),
            ...(await filesUnder('.github', /\.ya?ml$/u)),
        ];
        const sources = await Promise.all(
            files.map(async (file) => ({ file, source: await readFile(join(root, file), 'utf8') })),
        );
        const offenders = sources
            .filter(({ source }) => /^\s*retries\s*:|--retries\b/mu.test(source))
            .map(({ file }) => file);
        expect(offenders).toEqual([allowedSpec]);
    });

    it('limits the startup performance retry to one attempt in the Release pools', async () => {
        const source = await readFile(join(root, allowedSpec), 'utf8');
        expect(source).toContain(
            "const releaseRetryPools = new Set(['release-packaged', 'release-rehearsal']);",
        );
        expect(source).toContain(
            "retries: releaseRetryPools.has(process.env.CAXRI_E2E_POOL ?? '') ? 1 : 0,",
        );
    });
});
