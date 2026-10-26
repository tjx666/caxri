import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished, vi } from 'vitest';

import { discoverCaxriLaunchAgents, unloadCaxriLaunchAgents } from '../uninstall-launch-agents';

describe('Caxri launch agents in the uninstall plan', () => {
    it('finds only the Claude window jobs and unloads each before it is archived', async () => {
        const home = await mkdtemp(join(tmpdir(), 'caxri-uninstall-agents-'));
        onTestFinished(() => rm(home, { recursive: true, force: true }));
        expect(await discoverCaxriLaunchAgents(home)).toEqual([]);
        const directory = join(home, 'Library', 'LaunchAgents');
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'com.caxri.app.claude-windows.abc.plist'), '');
        await writeFile(join(directory, 'com.example.other.plist'), '');
        const found = await discoverCaxriLaunchAgents(home);
        expect(found).toEqual([join(directory, 'com.caxri.app.claude-windows.abc.plist')]);

        const run = vi.fn(() => Promise.reject(new Error('not loaded')));
        await unloadCaxriLaunchAgents([join(home, 'profile'), ...found], run);
        expect(run).toHaveBeenCalledTimes(1);
        expect(run).toHaveBeenCalledWith([
            'bootout',
            expect.stringMatching(/^gui\/\d+\/com\.caxri\.app\.claude-windows\.abc$/),
        ]);
    });
});
