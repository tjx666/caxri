import { describe, expect, it } from 'vitest';

import { normalizeSessionSearchWhitespace } from '../index';

describe('normalizeSessionSearchWhitespace', () => {
    it('reads newlines, paragraph breaks, tabs, and no-break spaces as single spaces', () => {
        expect(normalizeSessionSearchWhitespace('  one\n\ntwo\t three four \r\n')).toBe(
            'one two three four',
        );
        expect(normalizeSessionSearchWhitespace('')).toBe('');
    });
});
