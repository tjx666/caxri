import type { StructuredLogger } from '@caxri/system';
import { describe, expect, it, vi } from 'vitest';

import { SweepTimer } from '../sweep-timing';

function setup() {
    let clock = 0;
    const write = vi.fn();
    const timer = new SweepTimer({ write } as unknown as StructuredLogger, () => clock);
    return { advance: (ms: number) => (clock += ms), timer, write };
}

describe('SweepTimer', () => {
    it('stays silent for a fast sweep', () => {
        const { advance, timer, write } = setup();
        advance(199);
        timer.finish();
        expect(write).not.toHaveBeenCalled();
    });

    it('attributes a slow sweep to its phases', () => {
        const { advance, timer, write } = setup();
        const listStartedAt = timer.mark();
        advance(5);
        timer.listed(listStartedAt, 316, 300);
        const firstOwner = timer.mark();
        advance(40);
        timer.topology('owner-a', 100, firstOwner);
        const secondOwner = timer.mark();
        advance(900);
        timer.topology('owner-b', 200, secondOwner);
        const identityStartedAt = timer.mark();
        advance(30);
        timer.rootIdentity(identityStartedAt);
        timer.finish();

        expect(write).toHaveBeenCalledTimes(1);
        expect(write.mock.calls[0]?.[1]).toBe('workbench_root.sweep_slow');
        expect(write.mock.calls[0]?.[2]).toMatchObject({
            durationMs: 975,
            fields: {
                bindingCount: 300,
                listSessionsMs: 5,
                ownerCount: 2,
                rootIdentityMs: 30,
                sessionCount: 316,
                slowestOwnerProjectId: 'owner-b',
                slowestOwnerSessions: 200,
                slowestOwnerTopologyMs: 900,
                slowestRootIdentityMs: 30,
                topologyMs: 940,
            },
        });
    });
});
