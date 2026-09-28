import { describe, expect, it } from 'vitest';

import { peerApprovalChipCopy } from '../peer-approval-label';

describe('peerApprovalChipCopy', () => {
    it('shows nothing while no request is set aside', () => {
        expect(peerApprovalChipCopy(0)).toBeUndefined();
    });

    it('counts one set-aside request in the singular', () => {
        expect(peerApprovalChipCopy(1)).toEqual({
            description:
                '1 peer message is waiting for your approval. Click to review the oldest one.',
            text: '1 message awaiting approval',
        });
    });

    it('counts several set-aside requests in the plural', () => {
        expect(peerApprovalChipCopy(2)).toEqual({
            description:
                '2 peer messages are waiting for your approval. Click to review the oldest one.',
            text: '2 messages awaiting approval',
        });
    });
});
