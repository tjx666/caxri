import { describe, expect, it, vi } from 'vitest';

import type { ElectronProcessSample } from '../../process-explorer';
import { createSharedProcessReader, gpuRasterState, summarizeProcesses } from '../metrics';

const sample = (
    pid: number,
    type: ElectronProcessSample['type'],
    cpuPercent: number,
    memoryMb: number,
): ElectronProcessSample => ({ cpuPercent, memoryMb, pid, type });

describe('gpuRasterState', () => {
    it('maps Chromium rasterization strings', () => {
        expect(gpuRasterState({ rasterization: 'enabled' }).state).toBe('on');
        expect(gpuRasterState({ rasterization: 'enabled_on' }).state).toBe('on');
        expect(gpuRasterState({ rasterization: 'disabled_software' })).toEqual({
            raw: 'disabled_software',
            state: 'off',
        });
        expect(gpuRasterState({})).toEqual({ raw: '', state: 'unknown' });
    });
});

describe('summarizeProcesses', () => {
    it('folds processes into roles and adds the server', () => {
        const result = summarizeProcesses(
            [
                sample(1, 'Browser', 1.04, 100),
                sample(2, 'GPU', 2, 50.25),
                sample(3, 'Tab', 3, 200),
                sample(4, 'Tab', 1, 30),
            ],
            3,
            { cpuPercent: 0.5, memoryMb: 80 },
        );
        expect(result.map((row) => row.role)).toEqual([
            'workbench',
            'gpu',
            'browser',
            'server',
            'other',
        ]);
        expect(result.find((row) => row.role === 'browser')?.cpuPercent).toBe(1);
        expect(result.find((row) => row.role === 'gpu')?.memoryMb).toBe(50.3);
    });
});

describe('createSharedProcessReader', () => {
    it('reuses a reading inside the TTL and re-reads after it', () => {
        let now = 0;
        const read = vi.fn(() => []);
        const reader = createSharedProcessReader(read, () => now);
        reader();
        now = 1_000;
        reader();
        expect(read).toHaveBeenCalledTimes(1);
        now = 1_600;
        reader();
        expect(read).toHaveBeenCalledTimes(2);
    });
});
