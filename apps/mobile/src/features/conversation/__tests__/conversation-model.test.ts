import type { AgentTimelineItem, MobileTimelineReadResult } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    applyLatestConversationPage,
    applyOlderConversationPage,
    groupConversationItems,
    imageCountLabel,
    isConversationObservableThroughBlur,
    mergeLatestConversationItems,
    prependConversationPage,
    shouldFallbackToTerminal,
    shouldFollowConversation,
    shouldShowConversationJump,
    visibleConversationStatus,
} from '../conversation-model';

const message = (id: string, text = id): AgentTimelineItem => ({
    id,
    type: 'agentMessage',
    text,
});
const tool = (id: string, summary: string, durationMs = 1_000): AgentTimelineItem => ({
    id,
    type: 'toolCall',
    name: 'Bash',
    summary,
    status: 'succeeded',
    durationMs,
});
const page = (items: AgentTimelineItem[], isCursorExpired = false): MobileTimelineReadResult => ({
    status: 'available',
    items,
    cursorExpired: isCursorExpired,
    truncated: false,
});

describe('Conversation projection', () => {
    it('continues toward older history when live updates arrive between pages', () => {
        const initial = {
            historyExpired: false,
            items: [message('three'), message('four')],
            olderCursor: 'before-three',
            truncated: false,
        };
        const older = applyOlderConversationPage(
            initial,
            { ...page([message('two')]), olderCursor: 'before-two' },
            'before-three',
        );
        const live = applyLatestConversationPage(older, {
            ...page([message('four'), message('five')]),
            olderCursor: 'before-four',
        });
        expect(live.olderCursor).toBe('before-two');
        const oldest = applyOlderConversationPage(live, page([message('one')]), 'before-two');
        expect(oldest.items.map((item) => item.id)).toEqual([
            'one',
            'two',
            'three',
            'four',
            'five',
        ]);
        const finalPage = applyLatestConversationPage(oldest, {
            ...page([message('five'), message('six')]),
            olderCursor: 'before-five',
        });
        expect(finalPage.olderCursor).toBeUndefined();
    });

    it('adopts the latest cursor after history no longer overlaps', () => {
        const current = {
            historyExpired: false,
            items: [message('old')],
            olderCursor: 'before-old',
            truncated: false,
        };
        const next = applyLatestConversationPage(current, {
            ...page([message('new')]),
            olderCursor: 'before-new',
            truncated: true,
        });
        expect(next.items).toEqual([message('new')]);
        expect(next.olderCursor).toBe('before-new');
        expect(next.truncated).toBe(true);
    });
    it('groups only consecutive tool calls and keeps stable IDs', () => {
        const entries = groupConversationItems([
            message('first'),
            tool('tool-1', 'Ran npm test'),
            tool('tool-2', 'Ran git status'),
            message('second'),
            tool('tool-3', 'Edited src/file.ts'),
        ]);
        expect(entries.map((entry) => entry.id)).toEqual([
            'first',
            'tools:tool-1',
            'second',
            'tool-3',
        ]);
        expect(entries[1]).toMatchObject({ summary: 'Ran 2 commands', durationMs: 2_000 });
    });

    it('replaces a streaming suffix while preserving older reading history', () => {
        expect(
            mergeLatestConversationItems(
                [message('old'), message('live', 'a')],
                [message('live', 'b'), message('new')],
            ),
        ).toEqual([message('old'), message('live', 'b'), message('new')]);
        expect(mergeLatestConversationItems([message('old')], [message('rotated')])).toEqual([
            message('rotated'),
        ]);
    });

    it('prepends older items without duplicates and replaces expired cursor data', () => {
        const current = [message('two'), message('three')];
        const olderPage = page([message('one'), message('two')]);
        const rotatedPage = page([message('fresh')], true);
        expect(prependConversationPage(current, olderPage)).toEqual([message('one'), ...current]);
        expect(prependConversationPage(current, rotatedPage)).toEqual([message('fresh')]);
    });

    it('keeps a valid older page when live invalidations append messages', () => {
        const current = {
            historyExpired: false,
            items: [message('two'), message('three'), message('live')],
            olderCursor: 'cursor-a',
            truncated: false,
        };
        const olderPage = { ...page([message('one')]), olderCursor: 'cursor-b' };
        expect(applyOlderConversationPage(current, olderPage, 'cursor-a')).toEqual({
            ...current,
            items: [message('one'), ...current.items],
            olderCursor: 'cursor-b',
        });
        expect(applyOlderConversationPage(current, olderPage, 'different-cursor')).toBe(current);
    });

    it('replaces expired history and exposes the expired state', () => {
        const current = {
            historyExpired: false,
            items: [message('old')],
            olderCursor: 'stale-cursor',
            truncated: false,
        };
        const expiredPage = page([message('latest')], true);
        expect(applyOlderConversationPage(current, expiredPage, 'stale-cursor')).toEqual({
            ...current,
            historyExpired: true,
            items: [message('latest')],
            olderCursor: undefined,
        });
    });

    it('follows only near the bottom and offers the jump after unseen content', () => {
        expect(shouldFollowConversation(70, 720)).toBe(true);
        expect(shouldFollowConversation(120, 720)).toBe(false);
        expect(shouldFollowConversation(70, 600)).toBe(false);
        expect(shouldShowConversationJump(false, true)).toBe(true);
        expect(shouldShowConversationJump(true, true)).toBe(false);
        expect(shouldShowConversationJump(false, false)).toBe(false);
    });

    it('falls back only when the Agent timeline cannot be read', () => {
        expect(shouldFallbackToTerminal('available')).toBe(false);
        expect(shouldFallbackToTerminal('unsupported')).toBe(true);
        expect(shouldFallbackToTerminal('missing')).toBe(true);
        expect(visibleConversationStatus('unsupported', false)).toBe('unsupported');
        expect(visibleConversationStatus('missing', false)).toBe('missing');
        expect(visibleConversationStatus('unsupported', true)).toBe('unsupported');
        expect(visibleConversationStatus('available', false)).toBe('stale');
    });

    it('rides out a brief loss of observability instead of flashing stale mid pop-transition (#1329)', () => {
        // Still observable: whether the grace timer already elapsed is irrelevant.
        expect(isConversationObservableThroughBlur(true, false)).toBe(true);
        expect(isConversationObservableThroughBlur(true, true)).toBe(true);
        // Unobservable, but the hook's timer has not yet committed to stale (a pop transition finishes
        // well inside this window).
        expect(isConversationObservableThroughBlur(false, false)).toBe(true);
        // The timer fired: a sustained loss of observability finally reads as stale-worthy.
        expect(isConversationObservableThroughBlur(false, true)).toBe(false);
        // Feeding the debounced signal into `visibleConversationStatus` is the actual guard the hook
        // wires up: the transient blur keeps the last real status, the sustained one falls back to stale.
        expect(
            visibleConversationStatus(
                'available',
                isConversationObservableThroughBlur(false, false),
            ),
        ).toBe('available');
        expect(
            visibleConversationStatus(
                'available',
                isConversationObservableThroughBlur(false, true),
            ),
        ).toBe('stale');
    });

    it('names an image count in the singular or plural', () => {
        expect(imageCountLabel(1)).toBe('1 image');
        expect(imageCountLabel(3)).toBe('3 images');
    });
});
