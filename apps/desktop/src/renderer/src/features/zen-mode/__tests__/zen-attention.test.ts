import { describe, expect, it } from 'vitest';

import { zenAttentionMessage } from '../zen-attention';

describe('zenAttentionMessage', () => {
    it('hides the dot when no Session needs the user', () => {
        expect(zenAttentionMessage(0)).toBeUndefined();
    });

    it('uses the singular for one Session and the plural above', () => {
        expect(zenAttentionMessage(1)).toEqual({ key: 'workbench.zenAttentionOne', count: 1 });
        expect(zenAttentionMessage(3)).toEqual({ key: 'workbench.zenAttentionOther', count: 3 });
    });
});
