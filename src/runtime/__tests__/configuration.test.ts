import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { RuntimeEvent } from '../../shared/contracts';
import { ConfigurationService, findKeybindingConflicts } from '../configuration';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
});

describe('ConfigurationService', () => {
    it('detects shortcut conflicts without flagging duplicate identical commands', () => {
        expect(
            findKeybindingConflicts([
                { key: 'cmd+t', command: 'terminal.new' },
                { key: 'CMD+T', command: 'terminal.new' },
                { key: 'cmd+t', command: 'session.create' },
            ]),
        ).toEqual([{ key: 'cmd+t', commands: ['terminal.new', 'session.create'] }]);
    });

    it('retains last-known-good settings after a parse failure', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const service = new ConfigurationService(directory, () => undefined);
        await service.initialize();
        const before = service.getSettings();
        await expect(service.updateSettings('{ broken')).rejects.toThrow(
            /settings\.jsonc:.*line 1, column/,
        );
        expect(service.getSettings()).toEqual(before);
        await service.close();
    });

    it('reloads settings after an external atomic replacement', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));
        await service.initialize();

        try {
            const source = `${JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 16 }, null, 2)}\n`;
            const temporaryPath = `${service.settingsPath}.external.tmp`;
            await writeFile(temporaryPath, source, 'utf8');
            await rename(temporaryPath, service.settingsPath);

            await expect
                .poll(() => service.getSettings().value['terminal.fontSize'], { timeout: 5_000 })
                .toBe(16);
            expect(events.filter((event) => event.event === 'settings.changed')).toEqual([
                { event: 'settings.changed', payload: { source } },
            ]);
        } finally {
            await service.close();
        }
    });

    it('does not emit a second change when the watcher observes an internal write', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-'));
        temporaryDirectories.push(directory);
        const events: RuntimeEvent[] = [];
        const service = new ConfigurationService(directory, (event) => events.push(event));
        await service.initialize();

        try {
            const source = `${JSON.stringify({ ...service.getSettings().value, 'terminal.fontSize': 15 }, null, 2)}\n`;
            await service.updateSettings(source);
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect(events.filter((event) => event.event === 'settings.changed')).toEqual([
                { event: 'settings.changed', payload: { source } },
            ]);
        } finally {
            await service.close();
        }
    });
});
