import { agentProviderCatalog, agentProviderIds } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { setLocale } from '../../../i18n/locale-store';
import { mobileAgentDisplayName } from '../agent-display-name';
import type { MobileSessionItem } from '../session-model';
import {
    archivedAgeLabel,
    savedAgeLabel,
    sessionAgeLabel,
    sessionAgentLabel,
    sessionStateLabel,
    sessionStatusGlyphKind,
    sessionTitleForDisplay,
} from '../session-row-model';

describe('sessionTitleForDisplay', () => {
    afterEach(() => setLocale('en'));

    it('translates only the stored placeholder of an unnamed Session', () => {
        setLocale('zh-CN');
        expect(sessionTitleForDisplay('Untitled')).toBe('未命名');
        expect(sessionTitleForDisplay('Fix login')).toBe('Fix login');
        setLocale('en');
        expect(sessionTitleForDisplay('Untitled')).toBe('Untitled');
    });
});

describe('Session row labels', () => {
    it('shows human Agent names without provider jargon', () => {
        expect(
            sessionAgentLabel({ primaryTerminal: { kind: 'claude' } } as MobileSessionItem),
        ).toBe('Claude');
        expect(sessionAgentLabel({ primaryTerminal: { kind: 'grok' } } as MobileSessionItem)).toBe(
            'Grok Build',
        );
        expect(sessionAgentLabel({ primaryTerminal: { kind: 'shell' } } as MobileSessionItem)).toBe(
            'Shell',
        );
        expect(sessionAgentLabel({} as MobileSessionItem)).toBe('No Agent');
    });

    it('names every Agent provider exactly as the Desktop catalog does', () => {
        for (const provider of agentProviderIds) {
            expect(mobileAgentDisplayName(provider)).toBe(
                agentProviderCatalog[provider].displayName,
            );
            expect(
                sessionAgentLabel({ primaryTerminal: { kind: provider } } as MobileSessionItem),
            ).toBe(agentProviderCatalog[provider].displayName);
        }
        expect(mobileAgentDisplayName('grok')).toBe('Grok Build');
        expect(mobileAgentDisplayName('shell')).toBe('Shell');
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

describe('savedAgeLabel', () => {
    it('reads as the age of the saved copy', () => {
        const now = 1_000_000_000;
        expect(savedAgeLabel(now, now)).toBe('saved just now');
        expect(savedAgeLabel(now - 5 * 60_000, now)).toBe('saved 5m ago');
    });
});

describe('Session status on a saved copy', () => {
    it('says how old a saved state is', () => {
        const now = 1_000_000_000;
        expect(sessionStateLabel('Working', null, now)).toBe('Working');
        expect(sessionStateLabel('Working', now, now)).toBe('Working, as of just now');
        expect(sessionStateLabel('Working', now - 5 * 60_000, now)).toBe('Working, as of 5m ago');
    });

    it('never spins for a running Session read from the saved copy', () => {
        const running = { hasUnread: false, agentActivityState: 'running' } as const;
        expect(sessionStatusGlyphKind(running, false)).toBe('running');
        expect(sessionStatusGlyphKind(running, true)).toBe('running-saved');
        expect(sessionStatusGlyphKind({ ...running, hasUnread: true }, true)).toBe('attention');
        expect(
            sessionStatusGlyphKind({ hasUnread: false, agentActivityState: 'failed' }, true),
        ).toBe('failed');
        expect(
            sessionStatusGlyphKind({ hasUnread: false, agentActivityState: 'completed' }, false),
        ).toBeNull();
    });

    it('leaves a run the screen already shows to it instead of spinning beside the title', () => {
        const running = { hasUnread: false, agentActivityState: 'running' } as const;
        expect(sessionStatusGlyphKind(running, false, true)).toBeNull();
        expect(sessionStatusGlyphKind(running, true, true)).toBeNull();
        expect(sessionStatusGlyphKind({ ...running, hasUnread: true }, false, true)).toBe(
            'attention',
        );
    });
});
