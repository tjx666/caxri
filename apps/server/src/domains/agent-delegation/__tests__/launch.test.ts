import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { prepareDelegationLaunch, validateDelegationLaunch } from '../launch';

describe('delegation launch configuration', () => {
    it('keeps Grok trusted identity and pointer out of user launch settings', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'caxri-delegation-launch-'));
        const id = '49cc1001-2b93-4bb3-9ee8-104e8dcdd683';
        const launch = { executable: 'grok', args: ['--sandbox', 'workspace'] };
        try {
            const prepared = await prepareDelegationLaunch(
                directory,
                id,
                'grok',
                id,
                'Synthetic private task',
                launch,
            );
            expect(prepared.launch).toEqual(launch);
            expect(prepared.assignedAgentSessionId).toBe(id);
            expect(prepared.initialPrompt).toContain(id);
            expect(JSON.stringify(prepared)).not.toContain('Synthetic private task');
            expect(await readFile(join(directory, 'delegations', id, 'task.md'), 'utf8')).toBe(
                'Synthetic private task',
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    });
    it('preserves a read-only tool boundary without changing the owned interactive session', () => {
        expect(() =>
            validateDelegationLaunch('claude', {
                executable: 'claude',
                args: ['--tools', 'Read', '--strict-mcp-config', '--permission-mode=plan'],
            }),
        ).not.toThrow();
    });

    it.each([
        ['--print'],
        ['--resume', 'another-session'],
        ['--session-id=another-session'],
        ['--settings', 'unreviewed-settings.json'],
        ['--model', '--print'],
        ['unexpected positional prompt'],
    ])('rejects launch arguments that can replace submission or evidence: %j', (...arguments_) => {
        expect(() =>
            validateDelegationLaunch('claude', { executable: 'claude', args: arguments_ }),
        ).toThrow(/unsupported/u);
    });
});
