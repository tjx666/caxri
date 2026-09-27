import { describe, expect, it, vi } from 'vitest';

import type { RunnerProcess, RunnerRecoveryAdapter } from '../runner-process-recovery';
import {
    parseRunnerProcesses,
    recoverRunnerProcesses,
    selectRunnerProcesses,
} from '../runner-process-recovery';

const scope = {
    owner: 'caxri-42-1-e2e',
    runnerTemporary: '/runner/temp',
    workspace: '/runner/workspace',
};
const startedAt = 'Sun Sep 20 12:00:00 2026';
const resolvePath = (path: string) => Promise.resolve(path);

function record(pid: number, command: string, ppid = 1): RunnerProcess {
    return { command, pid, ppid, startedAt, state: 'S' };
}

function server(pid: number, owner = 'caxri-41-1-e2e'): RunnerProcess {
    return record(
        pid,
        `/runner/workspace/apps/server/dist/server/runtime/bin/node /runner/workspace/apps/server/dist/server/bundles/server-core.js CAXRI_USER_DATA_PATH=/runner/temp/${owner}/tmp/fixture/profile PATH=/bin`,
    );
}

describe('runner process recovery', () => {
    it('recovers an ownerless historical Server and descendants without selecting live or foreign profiles', async () => {
        const old = server(8001);
        const processes = [
            old,
            record(8002, 'extension-host', 8001),
            record(8003, 'shell', 8002),
            server(8004, scope.owner),
            server(8005, 'caxri-42-1-checks'),
            server(8006, 'caxri-43-1-e2e'),
            record(8007, 'other-app CAXRI_RUNNER_OWNER=caxri-41-1-e2e'),
            {
                ...server(8008),
                command: server(8008).command.replace('/runner/temp/', '/outside/'),
            },
            {
                ...server(8009),
                command: server(8009).command.replaceAll('/runner/workspace/', '/other/workspace/'),
            },
        ];

        expect(
            (await selectRunnerProcesses(processes, scope, true, resolvePath)).map(
                ({ pid }) => pid,
            ),
        ).toEqual([8001, 8002, 8003]);
    });

    it('rejects a temporary profile symlink that resolves outside the runner boundary', async () => {
        expect(
            await selectRunnerProcesses([server(8001)], scope, true, () =>
                Promise.resolve('/outside/profile'),
            ),
        ).toEqual([]);
    });

    it('does not expose profile environment values when canonicalization fails', async () => {
        const inaccessible = Object.assign(new Error('EACCES: /private-profile-value'), {
            code: 'EACCES',
        });
        await expect(
            selectRunnerProcesses([server(8001)], scope, true, () => Promise.reject(inaccessible)),
        ).rejects.toThrow('Could not resolve runner recovery profile');
    });

    it('selects the exact current marker and its unmarked children without selecting a suffix match', async () => {
        const processes = [
            record(8001, `node CAXRI_RUNNER_OWNER=${scope.owner} PATH=/bin`),
            record(8002, 'child', 8001),
            record(8003, `node CAXRI_RUNNER_OWNER=${scope.owner}-extra PATH=/bin`),
        ];
        expect(
            (await selectRunnerProcesses(processes, scope, false, resolvePath)).map(
                ({ pid }) => pid,
            ),
        ).toEqual([8001, 8002]);
    });

    it('retains process identity across reparenting and never signals a recycled PID', async () => {
        const root = server(8001);
        const child = record(8002, 'child', 8001);
        const replacement = { ...record(8001, 'unrelated'), startedAt: 'Sun Sep 20 12:01:00 2026' };
        const adapter: RunnerRecoveryAdapter = {
            list: vi
                .fn()
                .mockResolvedValueOnce([root, child])
                .mockResolvedValueOnce([replacement, { ...child, ppid: 1 }])
                .mockResolvedValueOnce([replacement]),
            resolvePath,
            signal: vi.fn(),
            wait: vi.fn(() => Promise.resolve()),
        };

        expect(await recoverRunnerProcesses(scope, true, adapter)).toBe(2);
        expect(adapter.signal).toHaveBeenCalledTimes(2);
        expect(adapter.signal).not.toHaveBeenCalledWith(replacement, expect.anything());
    });

    it('observes children created after the first teardown snapshot', async () => {
        const root = server(8001);
        const child = record(8002, 'late child', 8001);
        const adapter: RunnerRecoveryAdapter = {
            list: vi
                .fn()
                .mockResolvedValueOnce([root])
                .mockResolvedValueOnce([root, child])
                .mockResolvedValueOnce([]),
            resolvePath,
            signal: vi.fn(),
            wait: vi.fn(() => Promise.resolve()),
        };

        expect(await recoverRunnerProcesses(scope, true, adapter)).toBe(2);
        // The child exits with its parent before it needs an independent signal.
        expect(adapter.signal).toHaveBeenCalledWith(root, 'SIGTERM');
    });

    it('does not broaden historical recovery when another queued run starts', async () => {
        const root = server(8001);
        const otherRun = server(8002, 'caxri-40-1-e2e');
        const adapter: RunnerRecoveryAdapter = {
            list: vi
                .fn()
                .mockResolvedValueOnce([root])
                .mockResolvedValueOnce([root, otherRun])
                .mockResolvedValueOnce([otherRun]),
            resolvePath,
            signal: vi.fn(),
            wait: vi.fn(() => Promise.resolve()),
        };
        expect(await recoverRunnerProcesses(scope, true, adapter)).toBe(1);
        expect(adapter.signal).not.toHaveBeenCalledWith(otherRun, expect.anything());
    });

    it('waits after SIGKILL and fails if the same process still survives', async () => {
        const root = server(8001);
        const adapter: RunnerRecoveryAdapter = {
            list: vi.fn(() => Promise.resolve([root])),
            resolvePath,
            signal: vi.fn(),
            wait: vi.fn(() => Promise.resolve()),
        };
        await expect(recoverRunnerProcesses(scope, true, adapter)).rejects.toThrow(
            'survived bounded teardown',
        );
        expect(adapter.signal).toHaveBeenCalledWith(root, 'SIGKILL');
        expect(adapter.list).toHaveBeenCalledTimes(32);
    });

    it('treats exited zombies as gone and parses stable start identities', async () => {
        const parsed = parseRunnerProcesses(
            ' 8001 1 Z Sun Sep  20 12:00:00 2026 node CAXRI_RUNNER_OWNER=caxri-42-1-e2e',
        );
        expect(parsed[0]).toMatchObject({ pid: 8001, startedAt, state: 'Z' });
        expect(await selectRunnerProcesses(parsed, scope, false, resolvePath)).toEqual([]);
    });
});
