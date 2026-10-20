import { describe, expect, it } from 'vitest';

import { formatCommanderCompletionNotice } from '../notice-text';

describe('formatCommanderCompletionNotice', () => {
    it('formats a single transition on one prefixed line', () => {
        const text = formatCommanderCompletionNotice({
            delegations: [{ delegationId: 'd1', sessionId: 's1', status: 'completed' }],
        });
        expect(text).toBe(
            '[Caxri notice] 1 delegation update: delegation d1 in Session s1 completed.',
        );
    });

    it('coalesces multiple transitions into one line', () => {
        const text = formatCommanderCompletionNotice({
            delegations: [
                { delegationId: 'd1', sessionId: 's1', status: 'completed' },
                { delegationId: 'd2', sessionId: 's2', status: 'failed' },
                { delegationId: 'd3', sessionId: 's3', status: 'needsInput' },
            ],
        });
        expect(text).toBe(
            '[Caxri notice] 3 delegation updates: delegation d1 in Session s1 completed; ' +
                'delegation d2 in Session s2 failed; delegation d3 in Session s3 needs your input.',
        );
    });

    it('names Inbox events by item ID only, and counts mixed updates together', () => {
        expect(
            formatCommanderCompletionNotice({
                delegations: [],
                inbox: [{ itemId: 'i1', event: 'replied' }],
            }),
        ).toBe('[Caxri notice] 1 inbox update: inbox item i1 has a new reply.');
        expect(
            formatCommanderCompletionNotice({
                delegations: [{ delegationId: 'd1', sessionId: 's1', status: 'completed' }],
                inbox: [{ itemId: 'i1', event: 'merged' }],
            }),
        ).toBe(
            '[Caxri notice] 2 updates: delegation d1 in Session s1 completed; inbox item i1 was merged.',
        );
    });

    it('names hand-overs by hand-over and Session ID with a closed event word', () => {
        expect(
            formatCommanderCompletionNotice({
                delegations: [],
                handovers: [
                    { handoverId: 'h1', sessionId: 's1', event: 'ready' },
                    { handoverId: 'h2', sessionId: 's2', event: 'ownership_only' },
                ],
            }),
        ).toBe(
            '[Caxri notice] 2 hand-over updates: hand-over h1 of Session s1 is ready to continue; ' +
                'hand-over h2 of Session s2 has no conversation to continue; start a new task there.',
        );
        expect(
            formatCommanderCompletionNotice({
                delegations: [],
                inbox: [{ itemId: 'i1', event: 'replied' }],
                handovers: [{ handoverId: 'h1', sessionId: 's1', event: 'busy' }],
            }),
        ).toBe(
            '[Caxri notice] 2 updates: inbox item i1 has a new reply; ' +
                'hand-over h1 of Session s1 is still in a turn; wait for its ready notice.',
        );
    });

    it('names managed Sessions by ID with their latest state word', () => {
        expect(
            formatCommanderCompletionNotice({
                delegations: [],
                sessions: [
                    { sessionId: 's1', state: 'completed' },
                    { sessionId: 's2', state: 'waiting' },
                ],
            }),
        ).toBe(
            '[Caxri notice] 2 Session updates: Session s1 finished its turn; Session s2 needs input.',
        );
        expect(
            formatCommanderCompletionNotice({
                delegations: [{ delegationId: 'd1', sessionId: 's1', status: 'failed' }],
                sessions: [{ sessionId: 's2', state: 'running' }],
            }),
        ).toBe(
            '[Caxri notice] 2 updates: delegation d1 in Session s1 failed; Session s2 is working.',
        );
    });

    it('never lets an interpolated field introduce a control character or a newline', () => {
        const text = formatCommanderCompletionNotice({
            delegations: [
                { delegationId: 'd1\u{7}\ninjected', sessionId: 's1', status: 'completed' },
            ],
        });
        // eslint-disable-next-line no-control-regex -- asserting the output contains none.
        expect(/[\u{0}-\u{1F}\u{7F}-\u{9F}]/u.test(text)).toBe(false);
        expect(text.includes('\n')).toBe(false);
    });
});
