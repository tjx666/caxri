import { Buffer } from 'node:buffer';

import type { SessionSearchEntry, SessionSearchResult } from '@caxri/protocol';
import {
    MOBILE_SESSION_SEARCH_MAX_BYTES,
    MOBILE_SESSION_SEARCH_MAX_RESULTS,
    mobileSessionSearchResultSchema,
} from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { ServerDomainService } from '../../domain-service';
import {
    clipMobileSessionSearchSnippet,
    projectMobileSessionSearch,
    searchMobileSessions,
} from '../session-search-requests';

const SESSION = '019a0000-0000-7000-8000-00000000b001';
const PROJECT = '019a0000-0000-7000-8000-00000000b002';

const entry = (overrides: Partial<SessionSearchEntry> = {}): SessionSearchEntry => ({
    key: `session:${SESSION}`,
    title: 'Fix invoice rounding',
    status: 'open',
    sessionId: SESSION,
    projectId: PROJECT,
    provider: 'codex',
    agentSessionId: 'conversation',
    cwd: '/workspace/billing',
    updatedAt: 1_000,
    match: { field: 'title' },
    ...overrides,
});

const result = (entries: SessionSearchEntry[]): SessionSearchResult => ({
    entries,
    index: { state: 'ready', conversations: entries.length, pending: 0 },
    usedSubstringScan: false,
    filters: { agents: [], projects: [] },
    relaxation: 'phrase',
});

describe('mobile Session search', () => {
    it('clips a long snippet around its first match and rebases the highlights', () => {
        const text = `${'a'.repeat(200)}invoice${'b'.repeat(193)}`;

        const clipped = clipMobileSessionSearchSnippet({
            role: 'assistant',
            text,
            highlights: [[200, 207]],
        });

        expect(clipped.text.startsWith('…')).toBe(true);
        expect(clipped.text.endsWith('…')).toBe(true);
        const [[from, to]] = clipped.highlights;
        expect(clipped.text.slice(from, to)).toBe('invoice');
    });

    it('keeps a short snippet whole and never splits a surrogate pair', () => {
        expect(
            clipMobileSessionSearchSnippet({ role: 'user', text: 'pay 🧾', highlights: [[0, 3]] }),
        ).toEqual({ role: 'user', text: 'pay 🧾', highlights: [[0, 3]] });
        const emoji = '🧾'.repeat(200);
        const clipped = clipMobileSessionSearchSnippet({
            role: 'user',
            text: emoji,
            highlights: [[201, 203]],
        });
        expect(clipped.text.replaceAll('…', '').length % 2).toBe(0);
    });

    it('drops external conversations and the Desktop-only fields', () => {
        const projected = projectMobileSessionSearch(
            result([
                entry(),
                entry({ key: 'codex:external', status: 'external', sessionId: undefined }),
            ]),
        );

        expect(projected.entries).toEqual([
            {
                sessionId: SESSION,
                projectId: PROJECT,
                title: 'Fix invoice rounding',
                status: 'open',
                provider: 'codex',
                updatedAt: 1_000,
                match: { field: 'title' },
            },
        ]);
        expect(mobileSessionSearchResultSchema.parse(projected)).toEqual(projected);
    });

    it('fits a full page of escaped worst-case rows in one gateway frame', () => {
        const escaped = '\u{1}'.repeat(400);
        const projected = projectMobileSessionSearch(
            result(
                Array.from({ length: 100 }, () =>
                    entry({
                        title: escaped,
                        match: {
                            field: 'content',
                            snippet: {
                                role: 'user',
                                text: escaped,
                                highlights: Array.from({ length: 32 }, (_, index) => [
                                    index * 10,
                                    index * 10 + 5,
                                ]),
                            },
                            messageCount: 9,
                        },
                    }),
                ),
            ),
        );

        expect(projected.entries.length).toBeGreaterThan(0);
        expect(projected.entries.length).toBeLessThanOrEqual(MOBILE_SESSION_SEARCH_MAX_RESULTS);
        expect(Buffer.byteLength(JSON.stringify(projected))).toBeLessThanOrEqual(
            MOBILE_SESSION_SEARCH_MAX_BYTES,
        );
        expect(() => mobileSessionSearchResultSchema.parse(projected)).not.toThrow();
    });

    it("searches inside the paired device's Project grant", async () => {
        const request = vi.fn(() => Promise.resolve(result([entry()])));
        const domainService = { request } as unknown as ServerDomainService;

        await searchMobileSessions(
            domainService,
            {
                kind: 'paired-device',
                deviceId: 'device_00000000000000000000000000000001',
                projectIds: [PROJECT],
            } as never,
            {
                method: 'mobile.session.search',
                params: { query: 'invoice', status: 'archived' },
            },
        );

        expect(request).toHaveBeenCalledWith('session.searchInternal', {
            query: 'invoice',
            status: 'archived',
            projectScope: [PROJECT],
        });
    });
});
