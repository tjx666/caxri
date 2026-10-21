import { describe, expect, it } from 'vitest';

import { selectionGlideKeyframes } from '../session-selection-glide';

describe('selectionGlideKeyframes', () => {
    it('starts at the old row and lands on the new one, where the fill is laid out', () => {
        const from = { height: 28, left: 8, top: 40, width: 200 };
        const to = { height: 28, left: 24, top: 160, width: 184 };

        expect(selectionGlideKeyframes(from, to)).toEqual([
            { height: '28px', transform: 'translate(-16px, -120px)', width: '200px' },
            { height: '28px', transform: 'translate(0px, 0px)', width: '184px' },
        ]);
    });
});
