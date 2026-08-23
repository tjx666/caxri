import { access, readFile } from 'node:fs/promises';
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

    it.each(['fixture', 'status'])(
        'models the %s extension as an isolated workspace package',
        async (name) => {
            const extensionRoot = join(process.cwd(), 'extensions', name);
            const manifestText = await readFile(join(extensionRoot, 'package.json'), 'utf8');
            const manifest = JSON.parse(manifestText) as {
                devDependencies?: Record<string, string>;
                scripts?: Record<string, string>;
            };

            expect(manifest.devDependencies).toEqual({ caxri: 'workspace:*' });
            expect(manifest.scripts).toEqual({
                build: `bun run --cwd ../.. scripts/build-extension.ts --extension-root extensions/${name}`,
                typecheck: 'tsc --noEmit -p tsconfig.json',
            });
            await expect(access(join(extensionRoot, 'tsconfig.json'))).resolves.toBeUndefined();
        },
    );

    it('keeps extension typecheck and build orchestration package-local', async () => {
        const manifestText = await readFile(join(process.cwd(), 'package.json'), 'utf8');
        const manifest = JSON.parse(manifestText) as { scripts: Record<string, string> };
        const buildScript = await readFile(
            join(process.cwd(), 'scripts', 'build-extension.ts'),
            'utf8',
        );

        expect(manifest.scripts['typecheck:extensions']).toBe(
            "pnpm --recursive --filter './extensions/*' run typecheck",
        );
        expect(manifest.scripts['build:extensions']).toBe(
            "pnpm --recursive --filter './extensions/*' run build",
        );
        const sharedRoot = join(process.cwd(), 'extensions');
        const legacyConfig = access(join(sharedRoot, 'tsconfig.json'));
        const baseConfig = access(join(sharedRoot, 'tsconfig.base.json'));

        await expect(legacyConfig).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(baseConfig).resolves.toBeUndefined();
        expect(buildScript).not.toContain("from '@caxri/protocol'");
        expect(buildScript).toContain("from '../packages/protocol/src/index.ts'");
    });

    it('keeps the production package free of test-only extension resources', async () => {
        const manifestText = await readFile(join(process.cwd(), 'package.json'), 'utf8');
        const manifest = JSON.parse(manifestText) as {
            build: { extraResources: Array<{ from: string }> };
            scripts: Record<string, string>;
        };

        const extraResourceSources = manifest.build.extraResources.map(({ from }) => from);

        expect(extraResourceSources).toContain('extensions/status');
        expect(extraResourceSources).not.toContain('extensions/fixture');
        expect(manifest.scripts['package:e2e']).toBe(
            'bun run build && bun run scripts/package-extension-test-app.ts',
        );
    });
});
