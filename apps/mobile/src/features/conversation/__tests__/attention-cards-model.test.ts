import type { MethodResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    attentionRequestList,
    isAttentionQueryEnabled,
    isAutoAllowGranted,
    VISIBLE_REQUEST_LIMIT,
    visibleAttentionRequests,
} from '../attention-cards-model';

type Attention = MethodResult<'mobile.attention.list'>['requests'][number];
type AttentionListResult = MethodResult<'mobile.attention.list'>;

const request = (id: string): Attention => ({
    id,
    sessionId: 'session-1',
    terminalId: 'terminal-1',
    kind: 'permission',
    status: 'pending',
    toolName: 'Bash',
    summary: 'Run a command',
    questions: [],
    expiresAt: Date.now() + 60_000,
});

const listResult = (requests: Attention[], isGranted = false): AttentionListResult => ({
    requests,
    autoAllow: { granted: isGranted },
});

describe('isAttentionQueryEnabled', () => {
    it('is enabled only when foregrounded, connected, and scoped to a known connection', () => {
        expect(isAttentionQueryEnabled(true, 'connected', 'scope-1')).toBe(true);
    });

    it('is disabled while backgrounded', () => {
        expect(isAttentionQueryEnabled(false, 'connected', 'scope-1')).toBe(false);
    });

    it('is disabled while not connected', () => {
        expect(isAttentionQueryEnabled(true, 'connecting', 'scope-1')).toBe(false);
    });

    it('is disabled without a connection scope', () => {
        expect(isAttentionQueryEnabled(true, 'connected', null)).toBe(false);
    });
});

describe('attentionRequestList', () => {
    it('returns an empty list before the first fetch resolves', () => {
        expect(attentionRequestList(undefined)).toEqual([]);
    });

    it('returns the fetched requests', () => {
        const requests = [request('a'), request('b')];
        expect(attentionRequestList(listResult(requests))).toBe(requests);
    });
});

describe('visibleAttentionRequests', () => {
    it('returns the same reference once expanded, however many requests there are', () => {
        const requests = [request('a'), request('b'), request('c'), request('d')];
        expect(visibleAttentionRequests(requests, true)).toBe(requests);
    });

    it('caps the collapsed list to the most recent VISIBLE_REQUEST_LIMIT requests', () => {
        const requests = [request('a'), request('b'), request('c'), request('d')];
        expect(requests.length).toBeGreaterThan(VISIBLE_REQUEST_LIMIT);

        const visible = visibleAttentionRequests(requests, false);

        expect(visible).toHaveLength(VISIBLE_REQUEST_LIMIT);
        expect(visible.map((item) => item.id)).toEqual(['b', 'c', 'd']);
    });

    it('keeps every request collapsed when there are fewer than the limit', () => {
        const requests = [request('a'), request('b')];
        expect(visibleAttentionRequests(requests, false)).toEqual(requests);
    });
});

describe('isAutoAllowGranted', () => {
    it('is false before the first fetch resolves', () => {
        expect(isAutoAllowGranted(undefined)).toBe(false);
    });

    it('reflects the fetched auto-allow grant', () => {
        expect(isAutoAllowGranted(listResult([], true))).toBe(true);
        expect(isAutoAllowGranted(listResult([], false))).toBe(false);
    });
});
