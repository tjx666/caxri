import { describe, expect, it, vi } from 'vitest';

import { MobileGatewayDiagnostics } from '../diagnostics';

describe('mobile gateway diagnostics', () => {
    it('bounds repeated warnings while retaining exact lifetime counts', () => {
        const write = vi.fn();
        let now = 0;
        const diagnostics = new MobileGatewayDiagnostics({ write }, () => now);
        for (let index = 0; index < 100; index++) diagnostics.failure('admissionRate');
        expect(write).toHaveBeenCalledTimes(1);
        now = 60_000;
        diagnostics.failure('admissionRate');
        expect(write.mock.calls.at(-1)).toMatchObject([
            'info',
            'mobile_gateway.failure_summary',
            {
                fields: { admissionRate: 101, total: 101 },
            },
        ]);
        diagnostics.failure('inboundCapacity');
        diagnostics.flush();
        expect(write.mock.calls.at(-1)).toMatchObject([
            'info',
            'mobile_gateway.failure_summary',
            {
                fields: { admissionRate: 101, inboundCapacity: 1, total: 102 },
            },
        ]);
    });
});
