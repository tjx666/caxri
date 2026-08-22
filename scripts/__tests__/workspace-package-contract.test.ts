import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import { describe, expect, it } from 'vitest';

describe('workspace package manifests', () => {
    it('exposes caxri source types before build artifacts exist', async () => {
        const manifestPath = join(process.cwd(), 'packages/api/package.json');
        const manifestText = await readFile(manifestPath, 'utf8');
        const manifest = JSON.parse(manifestText) as {
            exports: { '.': { import: string; types: string } };
        };

        expect(manifest.exports['.']).toEqual({
            import: './dist/index.js',
            types: './src/index.ts',
        });
    });
});
