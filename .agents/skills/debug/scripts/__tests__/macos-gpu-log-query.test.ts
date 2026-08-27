import { describe, expect, it } from 'vitest';

import { parseMacosGpuLogWindow } from '../macos-gpu-log-query';

describe('macOS GPU unified-log query window', () => {
    it('converts ISO instants to the local format accepted by log show', () => {
        expect(
            parseMacosGpuLogWindow(
                ['--start', '2026-08-27T18:35:00Z', '--end', '2026-08-27T18:42:00Z'],
                'Asia/Shanghai',
            ),
        ).toEqual({ start: '2026-08-28 02:35:00', end: '2026-08-28 02:42:00' });
    });

    it('rejects ranges longer than the bounded collection window', () => {
        expect(() =>
            parseMacosGpuLogWindow(
                ['--start', '2026-08-27T18:00:00Z', '--end', '2026-08-27T18:31:00Z'],
                'UTC',
            ),
        ).toThrow('cannot exceed 30 minutes');
    });
});
