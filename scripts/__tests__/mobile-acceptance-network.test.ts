import { describe, expect, it } from 'vitest';

import { enableAndroidNetwork } from '../mobile-acceptance-network';

describe('mobile acceptance network', () => {
    it('enables Wi-Fi and cellular data', () => {
        const calls: string[][] = [];
        enableAndroidNetwork((arguments_) => calls.push(arguments_));
        expect(calls).toEqual([
            ['shell', 'svc', 'wifi', 'enable'],
            ['shell', 'svc', 'data', 'enable'],
        ]);
    });

    it('still enables data when enabling Wi-Fi fails, then reports the failure', () => {
        const calls: string[][] = [];
        expect(() =>
            enableAndroidNetwork((arguments_) => {
                calls.push(arguments_);
                if (arguments_.includes('wifi')) throw new Error('adb failed');
            }),
        ).toThrow('could not enable every network transport');
        expect(calls).toHaveLength(2);
    });
});
