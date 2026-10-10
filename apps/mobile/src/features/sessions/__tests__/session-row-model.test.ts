import { describe, expect, it } from 'vitest';

import type { MobileSessionItem } from '../session-model';
import { archivedAgeLabel, sessionAgeLabel, sessionAgentLabel } from '../session-row-model';

describe('Session row labels', () => {
    it('shows human Agent names without provider jargon', () => {
        expect(
            sessionAgentLabel({ primaryTerminal: { kind: 'claude' } } as MobileSessionItem),
        ).toBe('Claude');
        expect(sessionAgentLabel({ primaryTerminal: { kind: 'shell' } } as MobileSessionItem)).toBe(
            'Shell',
        );
        expect(sessionAgentLabel({} as MobileSessionItem)).toBe('No Agent');
    });

    it('uses short relative time at minute, hour, and day boundaries', () => {
        const now = 10_000_000;
        expect(sessionAgeLabel(now, now)).toBe('now');
        expect(sessionAgeLabel(now - 120_000, now)).toBe('2m');
        expect(sessionAgeLabel(now - 3_600_000, now)).toBe('1h');
        expect(sessionAgeLabel(now - 86_400_000, now)).toBe('1d');
    });
});

describe('archivedAgeLabel', () => {
    it('reads as a relative archive time', () => {
        const now = 1_000_000_000;
        expect(archivedAgeLabel(now, now)).toBe('archived just now');
        expect(archivedAgeLabel(now - 3_600_000, now)).toBe('archived 1h ago');
    });
});
