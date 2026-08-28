import { describe, expect, it } from 'vitest';

import { buildMacosGpuLogReceipt } from '../macos-gpu-log-receipt';

describe('macOS GPU unified-log receipt', () => {
    it('keeps only bounded system metadata and never reproduces raw messages or paths', () => {
        const source = [
            {
                timestamp: '2026-08-28T14:56:34.579+08:00',
                process: 'kernel',
                processID: 0,
                processImagePath: '/System/Library/Kernels/kernel',
                eventMessage:
                    'kIOGPUKernelCommandSignalSharedEvent: bad event port name secret prompt /private/project TOKEN=credential',
            },
            {
                timestamp: '2026-08-28T14:56:33.202+08:00',
                process: 'Dock',
                processID: 123,
                eventMessage: 'Space transition started for secret desktop title',
            },
        ]
            .map((record) => JSON.stringify(record))
            .join('\n');

        const receipt = buildMacosGpuLogReceipt(source);

        expect(receipt.records).toEqual([
            {
                timestamp: '2026-08-28T14:56:34.579+08:00',
                process: 'kernel',
                processId: 0,
                signal: 'iogpu-shared-event',
            },
            {
                timestamp: '2026-08-28T14:56:33.202+08:00',
                process: 'dock',
                processId: 123,
                signal: 'dock-space',
            },
        ]);
        expect(JSON.stringify(receipt)).not.toMatch(
            /secret|private|project|TOKEN|credential|event port name/u,
        );
    });
});
