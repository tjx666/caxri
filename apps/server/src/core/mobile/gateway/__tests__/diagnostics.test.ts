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

    it('counts terminal resync causes separately from transport failures', () => {
        const write = vi.fn();
        const diagnostics = new MobileGatewayDiagnostics({ write }, () => 0);
        diagnostics.terminalResync('resize');
        diagnostics.terminalResync('resize');
        diagnostics.terminalResync('source-gap');
        diagnostics.flush();
        expect(write).toHaveBeenCalledExactlyOnceWith(
            'info',
            'mobile_gateway.terminal_resync_summary',
            {
                fields: {
                    capacity: 0,
                    generationChanged: 0,
                    sourceGap: 1,
                    resize: 2,
                    total: 3,
                },
            },
        );
    });
    it('times the dashboard and Session-open reads while bounding idle-window summaries', () => {
        const write = vi.fn();
        let now = 0;
        const diagnostics = new MobileGatewayDiagnostics({ write }, () => now);
        diagnostics.request('mobile.dashboard', 40);
        diagnostics.request('mobile.session.show', 12);
        for (let index = 0; index < 24; index++) diagnostics.request('mobile.session.show', 3);
        diagnostics.request('mobile.agentChat.read', 250.4);
        diagnostics.request('session.queryForPrincipal', 1);
        expect(write).toHaveBeenCalledTimes(3);
        now = 60_000;
        diagnostics.flushIfDue();
        const summary = {
            fields: {
                dashboardReads: 1,
                dashboardTotalMs: 40,
                dashboardMaxMs: 40,
                sessionReads: 25,
                sessionTotalMs: 84,
                sessionMaxMs: 12,
                chatReads: 1,
                chatTotalMs: 250,
                chatMaxMs: 250,
            },
        };
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'mobile_gateway.session_read_summary',
            summary,
        );
        now = 120_000;
        diagnostics.flushIfDue();
        expect(write).toHaveBeenLastCalledWith(
            'info',
            'mobile_gateway.session_read_summary',
            summary,
        );
        expect(write).toHaveBeenCalledTimes(5);
    });
});
