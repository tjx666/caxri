import { describe, expect, it } from 'vitest';

import { sessionTitleToneClassName } from '../session-title-tone';

describe('sessionTitleToneClassName', () => {
    it('keeps a top-level row at medium weight', () => {
        expect(sessionTitleToneClassName({ selected: false })).toBe('font-medium');
    });

    it('mutes an idle nested row until the pointer lands on it', () => {
        expect(sessionTitleToneClassName({ nested: true, selected: false })).toBe(
            'font-normal text-muted group-hover/session-row:text-foreground',
        );
    });

    it('gives a nested row full contrast when selected or when it needs the user', () => {
        const emphasized = 'font-normal text-foreground';
        expect(sessionTitleToneClassName({ nested: true, selected: true })).toBe(emphasized);
        expect(
            sessionTitleToneClassName({ approvalPending: true, nested: true, selected: false }),
        ).toBe(emphasized);
        expect(
            sessionTitleToneClassName({ delegationFailed: true, nested: true, selected: false }),
        ).toBe(emphasized);
    });
});
