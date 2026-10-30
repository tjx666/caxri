import { describe, expect, it, vi } from 'vitest';

import {
    parseProcessList,
    ProcessExplorerSampler,
    redactProcessName,
    selectProcessTree,
} from '../sampler';

describe('Process Explorer sampling', () => {
    it('parses ps output and redacts common secret arguments', () => {
        expect(
            parseProcessList(
                ' 100 1 2.5 2048 /Applications/Caxri\n 101 100 0.0 1024 agent --api-key secret-value --mode run\n',
            ),
        ).toEqual([
            {
                pid: 100,
                parentPid: 1,
                name: '/Applications/Caxri',
                cpuPercent: 2.5,
                memoryMb: 2,
            },
            {
                pid: 101,
                parentPid: 100,
                name: 'agent --api-key=<redacted> --mode run',
                cpuPercent: 0,
                memoryMb: 1,
            },
        ]);
        expect(redactProcessName('tool --token=value --password "private value"')).toBe(
            'tool --token=<redacted> --password=<redacted>',
        );
    });

    it('keeps only descendants of the Caxri root', () => {
        const processes = parseProcessList(
            '100 1 0 1024 caxri\n101 100 0 1024 runtime\n102 101 0 1024 /bin/zsh\n900 1 0 1024 unrelated\n',
        );
        expect(selectProcessTree(processes, 100).map(({ pid }) => pid)).toEqual([100, 101, 102]);
    });

    it('coalesces samples and labels Desktop plus Server Core processes', async () => {
        const processList = vi.fn(() =>
            Promise.resolve(
                '100 1 1 1024 raw-main\n101 100 1 1024 raw-window\n200 1 1 1024 raw-server\n201 200 1 1024 /artifact/runtime/bin/node /artifact/bundles/extension-host.js\n202 200 1 1024 /artifact/runtime/bin/node /artifact/bundles/terminal-host.js\n203 202 1 1024 /bin/zsh -il\n900 1 1 1024 unrelated\n',
            ),
        );
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            serverPid: () => 200,
            processList,
            electronProcesses: () => [
                { pid: 100, type: 'Browser', cpuPercent: 3, memoryMb: 40 },
                { pid: 101, type: 'Tab', name: 'Caxri', cpuPercent: 2, memoryMb: 30 },
            ],
        });

        const [snapshot, concurrent] = await Promise.all([sampler.snapshot(), sampler.snapshot()]);

        expect(concurrent).toEqual(snapshot);
        expect(processList).toHaveBeenCalledTimes(1);
        expect(snapshot.processes).toEqual([
            expect.objectContaining({
                pid: 100,
                name: 'Caxri',
                kind: 'main',
                cpuPercent: 3,
                memoryMb: 40,
            }),
            expect.objectContaining({ pid: 101, name: 'Caxri', kind: 'window' }),
            expect.objectContaining({ pid: 200, name: 'Server Core', kind: 'service' }),
            expect.objectContaining({ pid: 201, name: 'Extension Host', kind: 'service' }),
            expect.objectContaining({ pid: 202, name: 'Terminal Host', kind: 'service' }),
            expect.objectContaining({
                pid: 203,
                name: 'zsh',
                kind: 'process',
                command: '/bin/zsh -il',
            }),
        ]);
        expect(JSON.stringify(snapshot)).not.toContain('/artifact/runtime/bin/node');
    });

    /**
     * Electron reports no `name` for `Tab` processes, so both of Caxri's renderer windows used to list as a bare
     * `window (renderer)` and a diagnostics tool could not identify its own window.
     */
    it('labels each renderer window by role instead of listing two anonymous windows', async () => {
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            processList: () =>
                Promise.resolve(
                    '100 1 1 1024 raw-main\n101 100 1 1024 raw-window\n104 100 1 1024 raw-window\n',
                ),
            electronProcesses: () => [
                { pid: 100, type: 'Browser', cpuPercent: 3, memoryMb: 40 },
                { pid: 101, type: 'Tab', cpuPercent: 2, memoryMb: 30 },
                { pid: 104, type: 'Tab', cpuPercent: 1, memoryMb: 20 },
            ],
            rendererRoles: () =>
                new Map([
                    [101, 'workbench'],
                    [104, 'process explorer'],
                ]),
        });

        const snapshot = await sampler.snapshot();

        expect(snapshot.processes).toEqual([
            expect.objectContaining({ pid: 100, name: 'Caxri' }),
            expect.objectContaining({ pid: 101, name: 'Workbench', kind: 'window' }),
            expect.objectContaining({ pid: 104, name: 'Process Explorer', kind: 'window' }),
        ]);
    });

    it('falls back to the anonymous renderer label while a window has no known role', async () => {
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            processList: () =>
                Promise.resolve('100 1 1 1024 raw-main\n101 100 1 1024 raw-window\n'),
            electronProcesses: () => [{ pid: 101, type: 'Tab', cpuPercent: 2, memoryMb: 30 }],
            rendererRoles: () => new Map(),
        });

        const snapshot = await sampler.snapshot();

        expect(snapshot.processes).toContainEqual(
            expect.objectContaining({ pid: 101, name: 'Renderer', kind: 'window' }),
        );
    });

    it('attaches running Terminals and survives a Server Core failure', async () => {
        const terminal = {
            terminalId: 't1',
            sessionId: 's1',
            sessionTitle: 'Fix the build',
            kind: 'claude' as const,
            provider: 'claude' as const,
            title: 'Claude Code',
            processId: 101,
        };
        const options = {
            rootPid: 100,
            processList: () => Promise.resolve('100 1 1 1024 raw-main\n'),
            electronProcesses: () => [],
            systemMemoryMb: () => 131_072,
        };
        const snapshot = await new ProcessExplorerSampler({
            ...options,
            terminals: () => Promise.resolve([terminal]),
        }).snapshot();
        expect(snapshot).toMatchObject({ terminals: [terminal], systemMemoryMb: 131_072 });
        const degraded = await new ProcessExplorerSampler({
            ...options,
            terminals: () => Promise.reject(new Error('Server Core unavailable')),
        }).snapshot();
        expect(degraded.terminals).toEqual([]);
        expect(degraded.processes).toHaveLength(1);
    });
    it('attributes PTY slots to their holders and moves Terminal masters off Terminal Host', async () => {
        const terminal = {
            terminalId: 't1',
            sessionId: 's1',
            sessionTitle: 'Fix the build',
            kind: 'shell' as const,
            title: 'zsh',
            processId: 203,
        };
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            serverPid: () => 200,
            processList: () =>
                Promise.resolve(
                    '100 1 1 1024 raw-main\n200 1 1 1024 raw-server\n202 200 1 1024 /artifact/runtime/bin/node /artifact/bundles/terminal-host.js\n203 202 1 1024 /bin/zsh -il\n204 203 1 1024 tmux\n900 1 1 1024 /Applications/Other.app/Contents/MacOS/Other\n901 1 1 1024 unrelated\n',
                ),
            electronProcesses: () => [],
            terminals: () => Promise.resolve([terminal]),
            ptyUsage: () =>
                Promise.resolve({
                    inUse: 6,
                    limit: 511,
                    holders: [
                        { pid: 202, count: 1 },
                        { pid: 204, count: 2 },
                        { pid: 900, count: 3 },
                    ],
                }),
        });

        const snapshot = await sampler.snapshot();

        expect(snapshot.pty).toEqual({ inUse: 6, limit: 511 });
        expect(snapshot.processes.find(({ pid }) => pid === 202)).not.toHaveProperty('ptyCount');
        expect(snapshot.processes.find(({ pid }) => pid === 204)).toMatchObject({ ptyCount: 2 });
        expect(snapshot.otherPtyHolders).toEqual([
            expect.objectContaining({ pid: 900, name: 'Other', kind: 'process', ptyCount: 3 }),
        ]);
    });

    it('lists processes without PTY readings when Server Core cannot provide them', async () => {
        const snapshot = await new ProcessExplorerSampler({
            rootPid: 100,
            processList: () => Promise.resolve('100 1 1 1024 raw-main\n'),
            electronProcesses: () => [],
            ptyUsage: () => Promise.reject(new Error('Server Core unavailable')),
        }).snapshot();

        expect(snapshot.pty).toBeUndefined();
        expect(snapshot.otherPtyHolders).toEqual([]);
        expect(snapshot.processes).toHaveLength(1);
    });
});
