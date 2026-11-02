import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { MAX_IMPORTED_THEMES, solarizedLightTheme } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';
import { ImportedThemeCatalog, importedThemeId } from '../config/imported-themes';
import { setJsoncValue } from '../config/reconcile';
import { serializeTheme } from '../theme';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

async function freshDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-config-imported-themes-'));
    temporaryDirectories.push(directory);
    return directory;
}

async function writeVsCodeTheme(
    directory: string,
    name: string,
    type: 'light' | 'dark',
    background: string,
): Promise<string> {
    const path = join(directory, `${name}.json`);
    await writeFile(
        path,
        JSON.stringify({
            name,
            type,
            colors: {
                'editor.background': background,
                'editor.foreground': type === 'light' ? '#1f1f1f' : '#e0e0e0',
            },
        }),
        'utf8',
    );
    return path;
}

describe('imported theme catalog', () => {
    it('keeps every import beside theme.json and loads it again after a restart', async () => {
        const directory = await freshDirectory();
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        await service.importTheme(await writeVsCodeTheme(directory, 'Paper', 'light', '#fbfbf7'));
        await service.importTheme(
            await writeVsCodeTheme(directory, 'Night Owl', 'dark', '#011627'),
        );
        expect(service.getTheme().value.id).toBe('imported-night-owl');
        expect(service.getTheme().imported.map(({ id }) => id)).toEqual([
            'imported-night-owl',
            'imported-paper',
        ]);
        await service.close();

        const restarted = new ConfigService(directory, () => {});
        await restarted.initialize();
        expect(restarted.getTheme().imported.map(({ name }) => name)).toEqual([
            'Night Owl',
            'Paper',
        ]);
        await restarted.close();
    });

    it('replaces an earlier import of the same name instead of adding another', async () => {
        const directory = await freshDirectory();
        const service = new ConfigService(directory, () => {});
        await service.initialize();
        await service.importTheme(await writeVsCodeTheme(directory, 'Paper', 'light', '#fbfbf7'));
        await service.importTheme(await writeVsCodeTheme(directory, 'Paper', 'light', '#f5f5ef'));
        expect(service.getTheme().imported).toHaveLength(1);
        expect(service.getTheme().imported[0]?.colors.background.toLowerCase()).toBe('#f5f5ef');
        await service.close();
    });

    it('sends a slot naming a removed theme back to its default preset and announces the change', async () => {
        const directory = await freshDirectory();
        const events: ServerEvent[] = [];
        const service = new ConfigService(directory, (event) => events.push(event));
        await service.initialize();
        await service.importTheme(await writeVsCodeTheme(directory, 'Paper', 'light', '#fbfbf7'));
        await service.updateSettings(
            setJsoncValue(
                service.getSettings().source,
                ['workbench.theme.light'],
                'imported-paper',
            ),
        );
        expect(service.getSettings().value['workbench.theme.light']).toBe('imported-paper');
        events.length = 0;

        await service.removeImportedTheme('imported-paper');
        expect(service.getTheme().imported).toEqual([]);
        expect(service.getSettings().value['workbench.theme.light']).toBe('vscode-light-plus');
        expect(await readdir(join(directory, 'config', 'themes'))).toEqual([]);
        expect(events.map(({ event }) => event)).toEqual(
            expect.arrayContaining(['settings.changed', 'theme.changed']),
        );
        await service.close();
    });

    it('skips a saved file that no longer parses or whose id disagrees with its name', async () => {
        const directory = await freshDirectory();
        const themes = join(directory, 'themes');
        const catalog = new ImportedThemeCatalog(themes);
        await catalog.save({ ...solarizedLightTheme, name: 'Paper' });
        await writeFile(join(themes, 'imported-broken.json'), '{ not json', 'utf8');
        await writeFile(
            join(themes, 'imported-renamed.json'),
            serializeTheme({ ...solarizedLightTheme, id: 'imported-other', name: 'Other' }),
            'utf8',
        );

        const reloaded = new ImportedThemeCatalog(themes);
        await reloaded.load();
        expect(reloaded.list().map(({ id }) => id)).toEqual(['imported-paper']);
    });

    it(`refuses a new import past ${MAX_IMPORTED_THEMES} themes`, async () => {
        const writes: string[] = [];
        const catalog = new ImportedThemeCatalog(await freshDirectory(), (path) => {
            writes.push(path);
            return Promise.resolve();
        });
        // Saved one after another, the way imports arrive, so each save sees the previous ones.
        await Array.from({ length: MAX_IMPORTED_THEMES }, (_, index) => index).reduce(
            async (previous, index) => {
                await previous;
                await catalog.save({ ...solarizedLightTheme, name: `Theme ${index}` });
            },
            Promise.resolve(),
        );
        await expect(
            catalog.save({ ...solarizedLightTheme, name: 'One more' }),
        ).rejects.toMatchObject({ code: 'CAPACITY' });
        await expect(
            catalog.save({ ...solarizedLightTheme, name: 'Theme 0' }),
        ).resolves.toMatchObject({ id: 'imported-theme-0' });
        expect(writes).toHaveLength(MAX_IMPORTED_THEMES + 1);
    });

    it('derives a namespaced id that cannot collide with a built-in preset', () => {
        expect(importedThemeId('Solarized Light')).toBe('imported-solarized-light');
        expect(importedThemeId('  Café ✨ ')).toBe('imported-cafe');
        expect(importedThemeId('✨')).toBe('imported-theme');
    });
});
