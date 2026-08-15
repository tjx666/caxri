import { describe, expect, it, vi } from 'vitest';

import {
    parseProcessList,
    ProcessExplorerSampler,
    redactProcessName,
    selectProcessTree,
} from '../process-explorer';

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

    it('coalesces samples and labels Electron plus Runtime processes', async () => {
        const processList = vi.fn(() =>
            Promise.resolve(
                '100 1 1 1024 raw-main\n101 100 1 1024 raw-window\n102 100 1 1024 raw-runtime\n103 102 1 1024 /bin/zsh -il\n900 1 1 1024 unrelated\n',
            ),
        );
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            runtimePid: () => 102,
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
            expect.objectContaining({ pid: 100, name: 'caxri', cpuPercent: 3, memoryMb: 40 }),
            expect.objectContaining({ pid: 101, name: 'window (Caxri)' }),
            expect.objectContaining({ pid: 102, name: 'runtime' }),
            expect.objectContaining({ pid: 103, name: '/bin/zsh -il' }),
        ]);
    });

    /**
     * Electron reports no `name` for `Tab` processes, so both of Caxri's renderer windows used to list as a bare
     * `window (renderer)` and a diagnostics tool could not identify its own window.
     */
    it('labels each renderer window by role instead of listing two anonymous windows', async () => {
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            runtimePid: () => 102,
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
            expect.objectContaining({ pid: 100, name: 'caxri' }),
            expect.objectContaining({ pid: 101, name: 'window (workbench)' }),
            expect.objectContaining({ pid: 104, name: 'window (process explorer)' }),
        ]);
    });

    it('falls back to the anonymous renderer label while a window has no known role', async () => {
        const sampler = new ProcessExplorerSampler({
            rootPid: 100,
            runtimePid: () => {},
            processList: () =>
                Promise.resolve('100 1 1 1024 raw-main\n101 100 1 1024 raw-window\n'),
            electronProcesses: () => [{ pid: 101, type: 'Tab', cpuPercent: 2, memoryMb: 30 }],
            rendererRoles: () => new Map(),
        });

        const snapshot = await sampler.snapshot();

        expect(snapshot.processes).toContainEqual(
            expect.objectContaining({ pid: 101, name: 'window (renderer)' }),
        );
    });
});
