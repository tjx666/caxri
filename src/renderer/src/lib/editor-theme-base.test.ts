import { describe, expect, it } from 'vitest';

import { monacoBaseThemeFor } from './editor-theme-base';

describe('monacoBaseThemeFor', () => {
    it('picks vs-dark for a dark theme background (Dracula)', () => {
        expect(monacoBaseThemeFor('#282a36')).toBe('vs-dark');
    });

    it('picks vs for a typical white light-theme background', () => {
        expect(monacoBaseThemeFor('#ffffff')).toBe('vs');
    });

    it('picks vs for a typical light-grey light-theme background', () => {
        expect(monacoBaseThemeFor('#f5f5f5')).toBe('vs');
    });

    it('is deterministic at the mid-grey edge around the threshold', () => {
        const first = monacoBaseThemeFor('#808080');
        const second = monacoBaseThemeFor('#808080');
        expect(first).toBe(second);
    });
});
