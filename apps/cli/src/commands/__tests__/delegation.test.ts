import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, onTestFinished } from 'vitest';

import { DELEGATION_COMMANDS } from '../delegation';

describe('delegation CLI', () => {
    it('loads bounded task input from an explicit file instead of a positional prompt', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-cli-'));
        onTestFinished(() => rm(directory, { recursive: true, force: true }));
        const path = join(directory, 'task.md');
        await writeFile(path, 'Synthetic task');
        const command = DELEGATION_COMMANDS.find(
            (item) => item.method === 'agent.delegation.create',
        )!;
        const tokens = [
            '--project',
            'project',
            '--session',
            'session',
            '--provider',
            'claude',
            '--prompt-file',
            path,
        ];
        expect(await command.parseParams(tokens)).toEqual({
            projectId: 'project',
            sessionId: 'session',
            provider: 'claude',
            prompt: 'Synthetic task',
        });
        await expect(command.parseParams(['Synthetic task'])).rejects.toThrow(/unique/u);
        await writeFile(path, 'a'.repeat(16_385));
        await expect(command.parseParams(tokens)).rejects.toThrow(/16 KiB/u);
    });
});
