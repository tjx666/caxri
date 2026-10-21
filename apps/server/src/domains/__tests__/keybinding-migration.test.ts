import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { ConfigService } from '../config';

const temporaryDirectories: string[] = [];

afterEach(async () => {
    const pendingDirectories = temporaryDirectories.slice();
    temporaryDirectories.length = 0;
    await Promise.all(pendingDirectories.map((path) => rm(path, { recursive: true, force: true })));
});

describe('ConfigurationService keybinding migrations', () => {
    it('migrates released view commands without dropping JSONC comments', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-view-command-migration-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const legacyBindings = [
            { key: 'cmd+1', command: 'inspector.showFiles' },
            { key: 'cmd+2', command: 'inspector.showGit' },
            { key: 'cmd+3', command: 'inspector.showStatus' },
            { key: 'cmd+shift+u', command: 'bottomPanel.showLogs' },
            { key: 'cmd+shift+y', command: 'bottomPanel.showInfo' },
            { key: 'cmd+shift+f', command: 'inspector.searchFiles' },
            { key: 'cmd+[', command: 'sidebar.toggle' },
            { key: 'cmd+]', command: 'inspector.toggle' },
            { key: 'cmd+j', command: 'bottomPanel.toggle' },
        ];
        const source = `${JSON.stringify(legacyBindings, null, 2).replace(
            '[\n',
            '[\n  // Keep this explanation attached to the released defaults.\n',
        )}\n`;
        await writeFile(join(configDirectory, 'keybindings.jsonc'), source, 'utf8');
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toEqual(
            expect.arrayContaining([
                { key: 'cmd+alt+1', command: 'secondarySidebar.showFiles' },
                { key: 'cmd+alt+2', command: 'secondarySidebar.showGit' },
                { key: 'cmd+alt+3', command: 'secondarySidebar.showStatus' },
                { key: 'cmd+shift+1', command: 'panel.showLogs' },
                { key: 'cmd+shift+2', command: 'panel.showInfo' },
                { key: 'cmd+shift+f', command: 'secondarySidebar.searchFiles' },
                { key: 'cmd+[', command: 'primarySidebar.toggle' },
                { key: 'cmd+]', command: 'secondarySidebar.toggle' },
                { key: 'cmd+j', command: 'panel.toggle' },
            ]),
        );
        const saved = await readFile(service.keybindingsPath, 'utf8');
        expect(saved).toContain('// Keep this explanation attached to the released defaults.');
        for (const { command } of legacyBindings) expect(saved).not.toContain(command);
        await service.close();
    });

    /**
     * The Open Session strip shipped `Cmd+1`..`Cmd+9` and `Cmd+Shift+W`. Its numbered chords move to the Pinned group
     * on the same keys, and the close chord is withdrawn, while a user's own binding on that chord survives.
     */
    it('moves the Open Session chords to Pinned Sessions and withdraws only the exact close default', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-open-session-migration-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const released = [
            { key: 'cmd+shift+w', command: 'session.closeTab' },
            { key: 'cmd+1', command: 'session.openTab1' },
            { key: 'cmd+9', command: 'session.openTab9' },
            { key: 'cmd+t', command: 'terminal.new' },
        ];
        const source = `${JSON.stringify(released, null, 2).replace(
            '[\n',
            '[\n  // Keep this comment through the removal.\n',
        )}\n`;
        await writeFile(join(configDirectory, 'keybindings.jsonc'), source, 'utf8');
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        const value = service.getKeybindings().value;
        expect(value).toEqual(
            expect.arrayContaining([
                { key: 'cmd+1', command: 'session.openPinned1' },
                { key: 'cmd+9', command: 'session.openPinned9' },
                { key: 'cmd+t', command: 'terminal.new' },
            ]),
        );
        expect(value.some(({ command }) => command === 'session.closeTab')).toBe(false);
        const saved = await readFile(service.keybindingsPath, 'utf8');
        expect(saved).toContain('// Keep this comment through the removal.');
        expect(saved).not.toContain('session.openTab');
        await service.close();
    });

    it('keeps a custom binding of the withdrawn close command', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-config-open-session-custom-'));
        temporaryDirectories.push(directory);
        const configDirectory = join(directory, 'config');
        await mkdir(configDirectory);
        const custom = { key: 'cmd+alt+w', command: 'session.closeTab' };
        await writeFile(
            join(configDirectory, 'keybindings.jsonc'),
            `${JSON.stringify([custom], null, 2)}\n`,
            'utf8',
        );
        const service = new ConfigService(directory, () => {});

        await service.initialize();

        expect(service.getKeybindings().value).toContainEqual(custom);
        await service.close();
    });
});
