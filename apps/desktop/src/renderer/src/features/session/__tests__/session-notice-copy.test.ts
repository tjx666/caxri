import { describe, expect, it } from 'vitest';

import { describeRestoredSession, describeRestoredSessions } from '../session-notice-copy';

describe('Session notice title quoting', () => {
    it('quotes the Session title', () => {
        expect(describeRestoredSession('api-fix')).toBe('Restored "api-fix"');
    });

    it('names the noun instead of quoting an empty or blank title', () => {
        expect(describeRestoredSession('')).toBe('Restored Session');
        expect(describeRestoredSession(' '.repeat(3))).toBe('Restored Session');
        expect(describeRestoredSession(undefined)).toBe('Restored Session');
    });

    it('trims surrounding whitespace before quoting', () => {
        expect(describeRestoredSession('  api-fix\n')).toBe('Restored "api-fix"');
    });

    it('truncates a runaway title so the notice keeps its verb', () => {
        const message = describeRestoredSession('a'.repeat(400));

        expect(message).toBe(`Restored "${'a'.repeat(48)}…"`);
        expect(message.length).toBeLessThan(64);
    });

    it('does not leave a dangling space before the ellipsis', () => {
        expect(describeRestoredSession(`${'a'.repeat(47)} tail`)).toBe(
            `Restored "${'a'.repeat(47)}…"`,
        );
    });

    it('never cuts a surrogate pair in half', () => {
        const message = describeRestoredSession('🚀'.repeat(60));

        expect(message).toBe(`Restored "${'🚀'.repeat(48)}…"`);
        expect(message).not.toContain('�');
        expect(message.split('\u{D83D}').length - 1).toBe(48);
    });
});

describe('Restored Session notice copy', () => {
    it('counts a batch and names a batch of one', () => {
        expect(describeRestoredSessions(['api-fix', 'docs'])).toBe('Restored 2 Sessions');
        expect(describeRestoredSessions(['api-fix'])).toBe('Restored "api-fix"');
    });
});
