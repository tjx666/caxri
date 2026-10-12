import { describe, expect, it } from 'vitest';

import {
    describeArchivedSession,
    describeRestoredSession,
    describeRestoredSessions,
} from '../session-archive-commands';

describe('Archived Session notice copy', () => {
    it('quotes the Session title', () => {
        expect(describeArchivedSession('api-fix')).toBe('Archived "api-fix"');
    });

    it('names the noun instead of quoting an empty or blank title', () => {
        expect(describeArchivedSession('')).toBe('Archived Session');
        expect(describeArchivedSession(' '.repeat(3))).toBe('Archived Session');
        expect(describeArchivedSession(undefined)).toBe('Archived Session');
    });

    it('trims surrounding whitespace before quoting', () => {
        expect(describeArchivedSession('  api-fix\n')).toBe('Archived "api-fix"');
    });

    it('truncates a runaway title so the Undo action keeps its room', () => {
        const message = describeArchivedSession('a'.repeat(400));

        expect(message).toBe(`Archived "${'a'.repeat(48)}…"`);
        expect(message.length).toBeLessThan(64);
    });

    it('does not leave a dangling space before the ellipsis', () => {
        expect(describeArchivedSession(`${'a'.repeat(47)} tail`)).toBe(
            `Archived "${'a'.repeat(47)}…"`,
        );
    });

    it('never cuts a surrogate pair in half', () => {
        const message = describeArchivedSession('🚀'.repeat(60));

        expect(message).toBe(`Archived "${'🚀'.repeat(48)}…"`);
        expect(message).not.toContain('�');
        expect(message.split('\u{D83D}').length - 1).toBe(48);
    });
});

describe('Restored Session notice copy', () => {
    it('reports a restore in the same shape as the archive it reverses', () => {
        expect(describeRestoredSession('api-fix')).toBe('Restored "api-fix"');
        expect(describeRestoredSession(undefined)).toBe('Restored Session');
        expect(describeRestoredSession('a'.repeat(400))).toBe(`Restored "${'a'.repeat(48)}…"`);
    });

    it('counts a batch and names a batch of one', () => {
        expect(describeRestoredSessions(['api-fix', 'docs'])).toBe('Restored 2 Sessions');
        expect(describeRestoredSessions(['api-fix'])).toBe('Restored "api-fix"');
    });
});
