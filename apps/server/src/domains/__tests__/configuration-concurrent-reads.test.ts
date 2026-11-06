// eslint-disable-next-line unicorn/name-replacements -- referenced by name in vitest.config.ts and scripts/__tests__/vitest-config-contract.test.ts, like its configuration*.test.ts siblings.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { ServerEvent } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';

/**
 * Split from `configuration.test.ts` (already past the 600-line source-size ratchet). It constructs a real
 * `ConfigService` with its native watcher, so it runs on the `server-serial-native` Vitest project too.
 */
const temporaryDirectories: string[] = [];
afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService concurrent reads', () => {
    it('drops an external read that a Settings update overtook (caxri#3492)', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-stale-read-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const staleRead = Promise.withResolvers<string>();
        const readStarted = Promise.withResolvers<void>();
        let shouldDelaySettingsRead = false;
        const service = new ConfigService(directory, (event) => events.push(event), undefined, {
            readConfigSource: async (path) => {
                if (shouldDelaySettingsRead && path.endsWith('settings.jsonc')) {
                    shouldDelaySettingsRead = false;
                    readStarted.resolve();
                    return staleRead.promise;
                }
                return readFile(path, 'utf8');
            },
        });
        await service.initialize();
        const before = service.getSettings().value;
        const staleSource = await readFile(service.settingsPath, 'utf8');
        events.length = 0;
        shouldDelaySettingsRead = true;
        const externalChange = (
            service as unknown as { onExternalChange(path: string): Promise<void> }
        ).onExternalChange(service.settingsPath);
        await readStarted.promise;

        await service.updateSettings(JSON.stringify({ ...before, 'terminal.fontSize': 18 }));
        staleRead.resolve(staleSource);
        await externalChange;

        expect(service.getSettings().value).toMatchObject({ 'terminal.fontSize': 18 });
        expect(events.filter(({ event }) => event === 'settings.changed')).toHaveLength(1);
        await service.close();
    });

    it('does not emit a second change when a read lands between the file write and the update bookkeeping (caxri#3490)', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-write-window-'));
        temporaryDirectories.push(directory);
        const events: ServerEvent[] = [];
        const hooks: { afterSettingsWrite?: (path: string) => Promise<void> } = {};
        const service = new ConfigService(directory, (event) => events.push(event), undefined, {
            // Simulates a watcher or poll read that completes after the new bytes reached disk but before the
            // Settings update records them as observed.
            writeConfigSource: async (path, source) => {
                await mkdir(dirname(path), { recursive: true });
                await writeFile(path, source);
                if (path.endsWith('settings.jsonc')) await hooks.afterSettingsWrite?.(path);
            },
        });
        await service.initialize();
        hooks.afterSettingsWrite = (path) =>
            (
                service as unknown as { onExternalChange(path: string): Promise<void> }
            ).onExternalChange(path);
        const before = service.getSettings().value;
        events.length = 0;

        await service.updateSettings(JSON.stringify({ ...before, 'terminal.fontSize': 18 }));

        expect(service.getSettings().value).toMatchObject({ 'terminal.fontSize': 18 });
        expect(events.filter(({ event }) => event === 'settings.changed')).toHaveLength(1);
        await service.close();
    });
});
