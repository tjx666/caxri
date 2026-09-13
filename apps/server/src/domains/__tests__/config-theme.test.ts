import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
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

    it('keeps theme state, source, file, and events unchanged after a zero-hit import', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-theme-zero-hit-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => events.push(event));
        await service.initialize();
        events.length = 0;
        const before = service.getTheme();
        const beforeFile = await readFile(service.themePath, 'utf8');
        const path = join(directory, 'empty-colors.json');
        await writeFile(path, JSON.stringify({ name: 'Empty colors', colors: {} }), 'utf8');

        await expect(service.importTheme(path)).rejects.toMatchObject({ code: 'VALIDATION' });
        expect(service.getTheme()).toEqual(before);
        expect(await readFile(service.themePath, 'utf8')).toBe(beforeFile);
        expect(events).toEqual([]);
        await service.close();
    });

    it('returns structured warnings only for the import and omits them from theme.json', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-theme-warnings-'));
        temporaryDirectories.push(directory);
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        const path = join(directory, 'editor-only.json');
        await writeFile(
            path,
            JSON.stringify({
                name: 'Editor only',
                type: 'dark',
                colors: { 'editor.background': '#1e1e1e' },
            }),
            'utf8',
        );

        const imported = await service.importTheme(path);
        expect(imported.warnings).toContainEqual({
            id: 'missing-syntax-colors',
            message: 'Syntax colors were not imported.',
        });
        expect(imported.value).not.toHaveProperty('warnings');
        expect(service.getTheme().value).not.toHaveProperty('warnings');
        expect(JSON.parse(await readFile(service.themePath, 'utf8'))).not.toHaveProperty(
            'warnings',
        );
        expect(service.getTheme().source).not.toContain('Syntax colors');
        await service.close();

        const restarted = new ConfigService(directory, () => {});
        await restarted.initialize();
        expect(restarted.getTheme().value).not.toHaveProperty('warnings');
        expect(restarted.getTheme().source).not.toContain('warnings');
        await restarted.close();
    });
});
