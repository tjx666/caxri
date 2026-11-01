import { describe, expect, it, vi } from 'vitest';

import type { showToast } from '../../../components/toast-store';
import type { Translate } from '../../../i18n';
import {
    continuationChoices,
    sessionForkBlocker,
    sessionRenameDraft,
    showArchiveUndo,
} from '../session-management-model';

describe('sessionRenameDraft', () => {
    it('returns the trimmed title for a valid change', () => {
        expect(sessionRenameDraft('  Fix login  ', 'Untitled')).toBe('Fix login');
    });

    it('rejects blank, unchanged, multi-line, and over-long titles', () => {
        expect(sessionRenameDraft(' '.repeat(3), 'Untitled')).toBeNull();
        expect(sessionRenameDraft(' Same ', 'Same')).toBeNull();
        expect(sessionRenameDraft('two\nlines', 'Untitled')).toBeNull();
        expect(sessionRenameDraft('x'.repeat(201), 'Untitled')).toBeNull();
    });
});

describe('sessionForkBlocker', () => {
    it('needs an Agent open as Chat', () => {
        expect(sessionForkBlocker(undefined)).toBe('noAgent');
        expect(sessionForkBlocker({ provider: undefined, surface: 'chat' })).toBe('noAgent');
        expect(sessionForkBlocker({ provider: 'codex', surface: undefined })).toBe('notChat');
        expect(sessionForkBlocker({ provider: 'codex', surface: 'chat' })).toBeUndefined();
    });
});

describe('continuationChoices', () => {
    const t = ((key: string, values?: Record<string, unknown>) =>
        values ? `${key} ${JSON.stringify(values)}` : key) as Translate;
    const now = Date.UTC(2026, 9, 31);

    it("drops the Chat's own provider and gives every unavailable one its reason", () => {
        expect(
            continuationChoices(
                [
                    { provider: 'codex', unavailable: 'current' },
                    { provider: 'claude' },
                    { provider: 'grok', unavailable: 'usageLimited' },
                ],
                now,
                t,
            ),
        ).toEqual([
            { provider: 'claude', reason: undefined },
            { provider: 'grok', reason: 'sessions.continue.usageLimited' },
        ]);
    });

    it('names when a usage-limited provider resets', () => {
        const [choice] = continuationChoices(
            [{ provider: 'claude', unavailable: 'usageLimited', resetsAt: now + 3 * 3_600_000 }],
            now,
            t,
        );
        expect(choice.reason).toMatch(/^sessions\.continue\.usageLimitedUntil /u);
    });
});

describe('showArchiveUndo', () => {
    const t = ((key: string) => key) as Translate;

    it('offers Undo that restores the Session', () => {
        const show = vi.fn();
        const restore = vi.fn(() => Promise.resolve());
        showArchiveUndo({ restore, show, t });
        const [tone, message, , action] = show.mock.calls[0] as Parameters<typeof showToast>;
        expect([tone, message, action?.label]).toEqual([
            'success',
            'sessions.manage.archived',
            'sessions.manage.undo',
        ]);
        action?.onPress();
        expect(restore).toHaveBeenCalledTimes(1);
    });

    it('reports a failed Undo', async () => {
        const show = vi.fn();
        showArchiveUndo({ restore: () => Promise.reject(new Error('offline')), show, t });
        (show.mock.calls[0]?.[3] as { onPress: () => void }).onPress();
        await vi.waitFor(() =>
            expect(show).toHaveBeenCalledWith('error', 'sessions.manage.restoreFailed'),
        );
    });
});
