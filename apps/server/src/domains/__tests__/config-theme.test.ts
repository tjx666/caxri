import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { solarizedLightTheme } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';
import { serializeTheme } from '../theme';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService built-in themes', () => {
    it('persists a selected preset and normalizes an externally edited built-in snapshot', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-builtin-theme-'));
        temporaryDirectories.push(directory);
        const first = new ConfigService(directory, () => {});
        await first.initialize();
        await first.updateTheme(serializeTheme(solarizedLightTheme));
        await first.close();

        const restarted = new ConfigService(directory, () => {});
        await restarted.initialize();
        expect(restarted.getTheme().value).toEqual(solarizedLightTheme);
        await restarted.close();

        const edited = structuredClone(solarizedLightTheme);
        edited.colors.accent = '#268bd2';
        const editedSource = serializeTheme(edited).replace(
            '  "id":',
            '  // Keep this externally maintained theme note.\n  "id":',
        );
        await writeFile(join(directory, 'config', 'theme.json'), editedSource, 'utf8');

        const normalized = new ConfigService(directory, () => {});
        await normalized.initialize();
        expect(normalized.getTheme().value).toMatchObject({
            id: 'custom-solarized-light',
            source: 'custom',
            colors: { accent: '#268bd2' },
        });
        const normalizedSource = await readFile(normalized.themePath, 'utf8');
        expect(normalizedSource).toContain('// Keep this externally maintained theme note.');
        expect(normalizedSource).toContain('"id": "custom-solarized-light"');
        expect(normalizedSource).toContain('"source": "custom"');
        await normalized.close();
    });
});
