import { describe, expect, it, vi } from 'vitest';

import { applyGpuStabilityWorkarounds } from '../gpu-stability';

describe('applyGpuStabilityWorkarounds', () => {
    it('disables Skia Graphite on macOS where it crashes the GPU process after occlusion', () => {
        const commandLine = { appendSwitch: vi.fn() };
        applyGpuStabilityWorkarounds(commandLine, 'darwin');
        expect(commandLine.appendSwitch).toHaveBeenCalledWith('disable-skia-graphite');
    });

    it('leaves other platforms on Chromium defaults', () => {
        const commandLine = { appendSwitch: vi.fn() };
        applyGpuStabilityWorkarounds(commandLine, 'linux');
        applyGpuStabilityWorkarounds(commandLine, 'win32');
        expect(commandLine.appendSwitch).not.toHaveBeenCalled();
    });
});
