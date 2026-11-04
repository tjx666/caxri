import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_CONFIGURATION_SOURCE_BYTES } from '@caxri/protocol';
import { execFileAsync } from '@caxri/system';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readSeedConfig } from '../seed-config';

const fixture = { directory: '' };

beforeEach(async () => {
    fixture.directory = await mkdtemp(join(tmpdir(), 'caxri-seed-config-'));
});

afterEach(async () => {
    await rm(fixture.directory, { recursive: true, force: true });
});

describe('readSeedConfig', () => {
    it('reads the three local sources and skips a missing one', async () => {
        await writeFile(join(fixture.directory, 'settings.jsonc'), '{"a":1}');
        await writeFile(join(fixture.directory, 'theme.json'), '{"b":2}');
        await expect(readSeedConfig(fixture.directory)).resolves.toEqual({
            keybindings: undefined,
            settings: '{"a":1}',
            theme: '{"b":2}',
        });
    });

    it('leaves the Mihomo Controller secret on this Mac and keeps every other setting and comment', async () => {
        await writeFile(
            join(fixture.directory, 'settings.jsonc'),
            [
                '{',
                '    // Shown on every Host',
                '    "workbench.colorTheme": "Dark+",',
                '    "environmentMonitor.mihomoRoutes": { "endpoint": "http://127.0.0.1:9090", "secret": "local-only" },',
                '    "git.diffExclude": []',
                '}',
            ].join('\n'),
        );
        const { settings } = await readSeedConfig(fixture.directory);
        expect(settings).not.toContain('local-only');
        expect(settings).not.toContain('environmentMonitor.mihomoRoutes');
        expect(settings).toContain('// Shown on every Host');
        expect(JSON.parse(settings!.replace(/\/\/.*$/m, ''))).toEqual({
            'git.diffExclude': [],
            'workbench.colorTheme': 'Dark+',
        });
    });

    it('reads a source exactly at the shared cap', async () => {
        const atCap = 'x'.repeat(MAX_CONFIGURATION_SOURCE_BYTES);
        await writeFile(join(fixture.directory, 'keybindings.jsonc'), atCap);
        await expect(readSeedConfig(fixture.directory)).resolves.toMatchObject({
            keybindings: atCap,
        });
    });

    it('skips only the source past the cap and keeps the others', async () => {
        await writeFile(
            join(fixture.directory, 'settings.jsonc'),
            'x'.repeat(MAX_CONFIGURATION_SOURCE_BYTES + 1),
        );
        await writeFile(join(fixture.directory, 'theme.json'), '{"b":2}');
        await expect(readSeedConfig(fixture.directory)).resolves.toEqual({
            keybindings: undefined,
            settings: undefined,
            theme: '{"b":2}',
        });
    });

    it('skips a FIFO at a source path without waiting for a writer', async () => {
        await execFileAsync('mkfifo', [join(fixture.directory, 'settings.jsonc')]);
        await writeFile(join(fixture.directory, 'theme.json'), '{"b":2}');
        const result = await Promise.race([
            readSeedConfig(fixture.directory),
            new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 3000)),
        ]);
        expect(result).toEqual({ keybindings: undefined, settings: undefined, theme: '{"b":2}' });
    });
});
