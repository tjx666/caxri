import { describe, expect, it } from 'vitest';

import type { DelegationNoticeKind } from '../../db';
import { NOTICE_KINDS } from '../settlement-notice/kinds';

describe('settlement notice kind descriptors', () => {
    it('defines every stored notice kind, and only those', () => {
        const stored: DelegationNoticeKind[] = ['approval', 'handback', 'question', 'settled'];
        expect(Object.keys(NOTICE_KINDS).toSorted((a, b) => a.localeCompare(b))).toEqual(stored);
    });
});
