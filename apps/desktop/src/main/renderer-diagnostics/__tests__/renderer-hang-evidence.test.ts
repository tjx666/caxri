import type { WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

import type { RendererHangEvidenceDependencies } from '../renderer-hang-evidence';
import { createRendererHangEvidenceSampler, parsePsCpuTime } from '../renderer-hang-evidence';

type Processes = Awaited<
    ReturnType<NonNullable<RendererHangEvidenceDependencies['readProcesses']>>
>;

function sampler(reads: Processes[], options: { destroyed?: boolean; clock?: number[] } = {}) {
    const webContents = { isDestroyed: () => options.destroyed ?? false } as unknown as WebContents;
    const clock = [...(options.clock ?? [1_000, 5_000])];
    const readProcesses = vi.fn(() => Promise.resolve(reads.shift() ?? new Map()));
    const evidence = createRendererHangEvidenceSampler(webContents, {
        cpuCount: () => 18,
        getLoadAverage1m: () => 32.449,
        getProcessIds: () => ({ gpu: 300, main: 100, renderer: 200 }),
        getRendererWorkingSetMb: () => 1646,
        getWindow: () => ({
            isFocused: () => false,
            isMinimized: () => false,
            isVisible: () => true,
        }),
        now: () => clock.shift() ?? 0,
        readProcesses,
    });
    return { evidence, readProcesses };
}

describe('renderer hang evidence', () => {
    it('derives each process CPU share from cumulative CPU time over the marked window', async () => {
        const { evidence } = sampler([
            new Map([
                [100, { cpuSeconds: 10, state: 'S' }],
                [200, { cpuSeconds: 50, state: 'R' }],
                [300, { cpuSeconds: 20, state: 'S' }],
            ]),
            new Map([
                [100, { cpuSeconds: 10.2, state: 'S' }],
                [200, { cpuSeconds: 54, state: 'R' }],
                [300, { cpuSeconds: 21, state: 'S' }],
            ]),
        ]);

        evidence.mark();

        await expect(evidence.read()).resolves.toEqual({
            cpuCount: 18,
            gpuCpuPercent: 25,
            loadAverage1m: 32.4,
            mainCpuPercent: 5,
            rendererCpuPercent: 100,
            rendererProcessState: 'R',
            rendererWorkingSetMb: 1646,
            windowFocused: false,
            windowMinimized: false,
            windowVisible: true,
        });
    });

    it('reports a blocked Renderer as near zero CPU in an uninterruptible wait', async () => {
        const { evidence } = sampler([
            new Map([[200, { cpuSeconds: 50, state: 'S' }]]),
            new Map([[200, { cpuSeconds: 50.04, state: 'U' }]]),
        ]);

        evidence.mark();

        await expect(evidence.read()).resolves.toMatchObject({
            rendererCpuPercent: 1,
            rendererProcessState: 'U',
        });
    });

    it('omits CPU shares without a mark but still reports load and window state', async () => {
        const { evidence } = sampler([new Map([[200, { cpuSeconds: 50, state: 'S' }]])]);

        const read = await evidence.read();

        expect(read).toMatchObject({ cpuCount: 18, loadAverage1m: 32.4, windowVisible: true });
        expect(read).not.toHaveProperty('rendererCpuPercent');
    });

    it('never rejects when ps fails', async () => {
        const webContents = { isDestroyed: () => false } as unknown as WebContents;
        const evidence = createRendererHangEvidenceSampler(webContents, {
            cpuCount: () => 18,
            getLoadAverage1m: () => 1,
            getProcessIds: () => ({ main: 100, renderer: 200 }),
            getWindow: () => null,
            readProcesses: () => Promise.reject(new Error('ps unavailable')),
        });

        evidence.mark();

        await expect(evidence.read()).resolves.toMatchObject({ cpuCount: 18 });
    });

    it('omits process and window fields once the window is destroyed', async () => {
        const { evidence, readProcesses } = sampler([], { destroyed: true });

        const read = await evidence.read();

        expect(read).toEqual({ cpuCount: 18, loadAverage1m: 32.4 });
        expect(readProcesses).not.toHaveBeenCalled();
    });

    it('parses ps cumulative CPU time', () => {
        expect(parsePsCpuTime('0:04.25')).toBe(4.25);
        expect(parsePsCpuTime('12:03.50')).toBe(723.5);
        expect(parsePsCpuTime('1:02:03.00')).toBe(3723);
        expect(parsePsCpuTime('2-01:00:00')).toBe(176_400);
        expect(parsePsCpuTime('garbage')).toBeUndefined();
        expect(parsePsCpuTime(undefined)).toBeUndefined();
    });
});
