import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { handBackRefusalText } from '../delegation-hand-back';

describe('handBackRefusalText', () => {
    it('words each closed refusal reason in the app language', () => {
        for (const reason of [
            'not_taken_over',
            'child_busy',
            'draft_active',
            'child_changed',
            'parent_gone',
            'parent_changed',
        ])
            expect(
                handBackRefusalText(
                    new CaxriError('CONFLICT', 'server text', { reason }),
                    translate,
                ),
            ).toBe(translate(`delegation.origin.handBackReason.${reason}` as never));
    });

    it('leaves any other failure to the generic wording', () => {
        expect(handBackRefusalText(new Error('boom'), translate)).toBeUndefined();
        expect(
            handBackRefusalText(new CaxriError('CONFLICT', 'x', { reason: 'other' }), translate),
        ).toBeUndefined();
        expect(handBackRefusalText(new CaxriError('CONFLICT', 'x'), translate)).toBeUndefined();
    });
});
