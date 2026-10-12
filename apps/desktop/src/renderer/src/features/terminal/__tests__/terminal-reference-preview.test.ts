import type { TerminalReferencePreview, TerminalReferencePreviewRequest } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import {
    basicReferencePreviewCard,
    terminalReferencePreviewCard,
    terminalReferencePreviewRequest,
    TerminalReferencePreviewStore,
} from '../terminal-reference-preview';

const NOW = Date.UTC(2026, 8, 21);

const COMMIT_PREVIEW: TerminalReferencePreview = {
    kind: 'commit',
    author: 'Ada Lovelace',
    authoredAt: NOW - 2 * 86_400_000,
    body: 'Explains why.\n\nTrailer: value',
    changedFileCount: 3,
    deletions: 4,
    insertions: 12,
    repositoryName: 'caxri',
    sha: 'f36a02ac'.padEnd(40, '0'),
    shortSha: 'f36a02a',
    subject: 'Serialize Session-state writes',
};

const COMMIT_REQUEST: TerminalReferencePreviewRequest = {
    kind: 'commit',
    reference: 'f36a02a',
};

describe('terminalReferencePreviewRequest', () => {
    it('asks about commits and GitHub references, and about nothing else', () => {
        expect(
            terminalReferencePreviewRequest({ kind: 'commit', target: 'F36A02A', text: 'F36A02A' }),
        ).toEqual({ kind: 'commit', reference: 'f36a02a' });
        expect(
            terminalReferencePreviewRequest({
                kind: 'url',
                target: 'https://github.com/tjx666/caxri/issues/445',
                text: 'tjx666/caxri#445',
            }),
        ).toEqual({ kind: 'github', owner: 'tjx666', repo: 'caxri', number: 445 });
        // A configured rule already carries everything its card shows, so hovering one costs no request.
        expect(
            terminalReferencePreviewRequest({
                detail: 'Linear issue',
                kind: 'url',
                target: 'https://linear.app/example/issue/ABC-1',
                text: 'ABC-1',
            }),
        ).toBeUndefined();
        expect(
            terminalReferencePreviewRequest({
                kind: 'file',
                target: 'src/index.ts',
                text: 'src/index.ts',
            }),
        ).toBeUndefined();
    });
});

describe('terminalReferencePreviewCard', () => {
    it('renders a commit with its repository, author, age, and line counts', () => {
        expect(
            terminalReferencePreviewCard(
                { detail: 'Git commit', kind: 'commit', target: 'f36a02a', text: 'f36a02a' },
                COMMIT_PREVIEW,
                NOW,
            ),
        ).toEqual({
            body: 'Explains why. Trailer: value',
            detail: 'caxri \u{00B7} f36a02a',
            facts: ['Ada Lovelace', '2 days ago', '+12 -4 in 3 files'],
            title: 'Serialize Session-state writes',
        });
    });

    it('capitalizes the state GitHub reports in lowercase', () => {
        expect(
            terminalReferencePreviewCard(
                {
                    detail: 'tjx666/caxri on GitHub',
                    kind: 'url',
                    target: 'https://github.com/tjx666/caxri/issues/445',
                    text: 'tjx666/caxri#445',
                },
                {
                    kind: 'github',
                    author: 'tjx666',
                    createdAt: NOW - 3_600_000,
                    isDraft: false,
                    isMerged: false,
                    isPullRequest: false,
                    number: 445,
                    state: 'open',
                    title: 'Hover preview for Terminal references',
                    url: 'https://github.com/tjx666/caxri/issues/445',
                },
                NOW,
            ).facts[0],
        ).toBe('Open issue #445');
    });

    it('names a merged pull request instead of the closed state GitHub reports', () => {
        expect(
            terminalReferencePreviewCard(
                {
                    detail: 'tjx666/caxri on GitHub',
                    kind: 'url',
                    target: 'https://github.com/tjx666/caxri/pull/445',
                    text: 'tjx666/caxri#445',
                },
                {
                    kind: 'github',
                    author: 'tjx666',
                    createdAt: NOW - 3_600_000,
                    isDraft: false,
                    isMerged: true,
                    isPullRequest: true,
                    number: 445,
                    state: 'closed',
                    title: 'Hover preview for Terminal references',
                    url: 'https://github.com/tjx666/caxri/pull/445',
                },
                NOW,
            ).facts[0],
        ).toBe('Merged pull request #445');
    });

    it('marks a draft pull request by its state rather than repeating the raw one', () => {
        const link = {
            detail: 'tjx666/caxri on GitHub',
            kind: 'url' as const,
            target: 'https://github.com/tjx666/caxri/issues/445',
            text: 'tjx666/caxri#445',
        };
        expect(
            terminalReferencePreviewCard(
                link,
                {
                    kind: 'github',
                    author: 'tjx666',
                    createdAt: NOW - 3_600_000,
                    isDraft: true,
                    isMerged: false,
                    isPullRequest: true,
                    number: 445,
                    state: 'open',
                    title: 'Hover preview for Terminal references',
                    url: 'https://github.com/tjx666/caxri/pull/445',
                },
                NOW,
            ),
        ).toEqual({
            detail: 'tjx666/caxri on GitHub',
            facts: ['Draft pull request #445', 'tjx666', '1 hour ago'],
            title: 'Hover preview for Terminal references',
        });
    });

    it('degrades to the basic card plus a reason the operator can act on', () => {
        const link = {
            detail: 'tjx666/caxri on GitHub',
            kind: 'url' as const,
            target: 'https://github.com/tjx666/caxri/issues/445',
            text: 'tjx666/caxri#445',
        };
        expect(
            terminalReferencePreviewCard(link, { kind: 'unavailable', reason: 'cli-missing' }, NOW),
        ).toEqual({
            ...basicReferencePreviewCard(link),
            facts: ['Install the GitHub CLI to see details'],
        });
    });
});

describe('TerminalReferencePreviewStore', () => {
    it('answers a repeat hover from cache until the entry expires', async () => {
        let now = NOW;
        const request = vi.fn(() => Promise.resolve(COMMIT_PREVIEW));
        const store = new TerminalReferencePreviewStore(request, {
            now: () => now,
            ttlMs: 1_000,
        });

        expect(
            await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal),
        ).toEqual(COMMIT_PREVIEW);
        expect(
            await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal),
        ).toEqual(COMMIT_PREVIEW);
        expect(request).toHaveBeenCalledOnce();

        now += 1_000;
        await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('forgets a blank card sooner than a real one', async () => {
        let now = NOW;
        const request = vi.fn(() =>
            Promise.resolve<TerminalReferencePreview>({ kind: 'unavailable', reason: 'failed' }),
        );
        const store = new TerminalReferencePreviewStore(request, {
            now: () => now,
            ttlMs: 60_000,
            unavailableTtlMs: 1_000,
        });

        await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal);
        now += 1_000;
        await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal);
        expect(request).toHaveBeenCalledTimes(2);
    });

    it('evicts the least recently stored entry once the capacity is reached', async () => {
        const request = vi.fn(() => Promise.resolve(COMMIT_PREVIEW));
        const store = new TerminalReferencePreviewStore(request, { maxEntries: 2 });
        const reference = (value: string): TerminalReferencePreviewRequest => ({
            kind: 'commit',
            reference: value,
        });

        await store.load('terminal-1', reference('aaaaaaa'), new AbortController().signal);
        await store.load('terminal-1', reference('bbbbbbb'), new AbortController().signal);
        await store.load('terminal-1', reference('ccccccc'), new AbortController().signal);
        expect(request).toHaveBeenCalledTimes(3);

        await store.load('terminal-1', reference('ccccccc'), new AbortController().signal);
        expect(request).toHaveBeenCalledTimes(3);
        await store.load('terminal-1', reference('aaaaaaa'), new AbortController().signal);
        expect(request).toHaveBeenCalledTimes(4);
    });

    it('shares one read between concurrent hovers and cancels it only when the last one leaves', async () => {
        const pending = Promise.withResolvers<TerminalReferencePreview>();
        const signals: AbortSignal[] = [];
        const store = new TerminalReferencePreviewStore((_terminalId, _request, signal) => {
            signals.push(signal);
            return pending.promise;
        });
        const first = new AbortController();
        const second = new AbortController();

        const firstLoad = store.load('terminal-1', COMMIT_REQUEST, first.signal);
        const secondLoad = store.load('terminal-1', COMMIT_REQUEST, second.signal);
        expect(signals).toHaveLength(1);

        first.abort();
        expect(signals[0].aborted).toBe(false);
        expect(await firstLoad).toBeUndefined();

        second.abort();
        expect(signals[0].aborted).toBe(true);
        pending.resolve(COMMIT_PREVIEW);
        expect(await secondLoad).toBeUndefined();
    });

    it('returns nothing instead of rejecting when the read fails', async () => {
        const store = new TerminalReferencePreviewStore(() =>
            Promise.reject(new Error('Runtime request was canceled')),
        );
        expect(
            await store.load('terminal-1', COMMIT_REQUEST, new AbortController().signal),
        ).toBeUndefined();
    });
});
