import type { AgentChatItem } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import type { AgentChatTimelineEntry } from '../../transcript/agent-chat-timeline';
import { takeoverDividerPlacement } from '../agent-chat-takeover-divider';

function message(id: string, createdAt?: number): AgentChatTimelineEntry {
    const item: AgentChatItem = {
        id,
        type: 'userMessage',
        text: id,
        ...(createdAt !== undefined && { createdAt }),
    };
    return { kind: 'item', item };
}

function folded(id: string, createdAt?: number): AgentChatTimelineEntry {
    const item: AgentChatItem = {
        command: 'ls',
        id,
        output: '',
        status: 'completed',
        type: 'command',
        ...(createdAt !== undefined && { createdAt }),
    };
    return {
        kind: 'turn',
        id: `turn:${id}`,
        status: 'completed',
        entries: [{ kind: 'work', id: `work:${id}`, items: [item] }],
    };
}

describe('takeoverDividerPlacement', () => {
    it('goes before the first entry that arrived at or after the takeover', () => {
        const timeline = [message('a', 100), message('b', 200), message('c', 300)];
        expect(takeoverDividerPlacement(timeline, 200, true)).toEqual({
            entryKey: 'b',
            kind: 'before',
        });
        expect(takeoverDividerPlacement(timeline, 201, true)).toEqual({
            entryKey: 'c',
            kind: 'before',
        });
    });

    it('dates a folded turn by its first child', () => {
        expect(takeoverDividerPlacement([message('a', 100), folded('b', 300)], 250, true)).toEqual({
            entryKey: 'turn:b',
            kind: 'before',
        });
    });

    it('is a standalone marker when nothing arrived since the takeover', () => {
        expect(takeoverDividerPlacement([message('a', 100)], 500, true)).toEqual({
            kind: 'standalone',
        });
        expect(takeoverDividerPlacement([], 500, true)).toEqual({ kind: 'standalone' });
    });

    it('does not guess when an earlier entry has no time, as in a replayed history', () => {
        expect(takeoverDividerPlacement([message('a'), message('b', 900)], 500, true)).toEqual({
            kind: 'standalone',
        });
        expect(takeoverDividerPlacement([message('a'), message('b')], 500, true)).toEqual({
            kind: 'standalone',
        });
    });

    it('does not place it at the first entry when older history was not read back', () => {
        expect(takeoverDividerPlacement([message('a', 900)], 500, false)).toEqual({
            kind: 'standalone',
        });
        expect(
            takeoverDividerPlacement([message('a', 100), message('b', 900)], 500, false),
        ).toEqual({ entryKey: 'b', kind: 'before' });
    });

    it('skips an empty stopped-turn row and artifacts, which carry no time', () => {
        const stopped: AgentChatTimelineEntry = {
            kind: 'turn',
            id: 'turn:x',
            status: 'interrupted',
            entries: [],
        };
        expect(
            takeoverDividerPlacement([message('a', 100), stopped, message('b', 900)], 500, true),
        ).toEqual({ entryKey: 'b', kind: 'before' });
    });
});
