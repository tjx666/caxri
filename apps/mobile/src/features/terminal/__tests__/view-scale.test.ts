import { describe, expect, it } from 'vitest';

import { terminalViewScale } from '../view-scale';

describe('mobile Terminal view scale', () => {
    it('keeps a readable default when many Desktop rows exceed the phone height', () => {
        expect(terminalViewScale({ heightFit: 0.24, widthFit: 0.78, zoom: 1 })).toBe(0.6);
    });

    it('allows pinch zoom to show the complete Desktop grid', () => {
        expect(terminalViewScale({ heightFit: 0.24, widthFit: 0.78, zoom: 0.2 })).toBe(0.24);
    });
});
