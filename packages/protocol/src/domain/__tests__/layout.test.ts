import { describe, expect, it } from 'vitest';

import type { TerminalLayoutNode } from '../layout.js';
import { MAX_SPLIT_RATIO, MIN_SPLIT_RATIO, terminalLayoutSchema } from '../layout.js';

function group(id: string, terminalIds: string[], activeTerminalId?: string): TerminalLayoutNode {
    return { type: 'group', id, terminalIds, activeTerminalId };
}

function split(
    id: string,
    first: TerminalLayoutNode,
    second: TerminalLayoutNode,
    ratio = 0.5,
): TerminalLayoutNode {
    return { type: 'split', id, direction: 'horizontal', ratio, first, second };
}

describe('terminalLayoutSchema invariants', () => {
    it('accepts an empty layout with no root', () => {
        expect(terminalLayoutSchema.safeParse({}).success).toBe(true);
    });

    it('accepts a well-formed single-group layout', () => {
        const result = terminalLayoutSchema.safeParse({
            root: group('group-1', ['terminal-1', 'terminal-2'], 'terminal-1'),
            activeGroupId: 'group-1',
        });
        expect(result.success).toBe(true);
    });

    it('accepts a well-formed split layout', () => {
        const result = terminalLayoutSchema.safeParse({
            root: split(
                'split-1',
                group('group-1', ['terminal-1']),
                group('group-2', ['terminal-2']),
            ),
            activeGroupId: 'group-2',
        });
        expect(result.success).toBe(true);
    });

    it('rejects a layout with a duplicated node id', () => {
        const result = terminalLayoutSchema.safeParse({
            root: split('dup', group('dup', ['terminal-1']), group('group-2', ['terminal-2'])),
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('reuses a layout node id');
    });

    it('rejects a Terminal attached to two different layout groups', () => {
        const result = terminalLayoutSchema.safeParse({
            root: split(
                'split-1',
                group('group-1', ['terminal-shared']),
                group('group-2', ['terminal-shared']),
            ),
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('two layout groups');
    });

    it('rejects an activeTerminalId that is not part of its own group', () => {
        const result = terminalLayoutSchema.safeParse({
            root: group('group-1', ['terminal-1'], 'terminal-not-in-group'),
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('active Terminal must belong');
    });

    it('rejects an activeGroupId that is not part of the tree', () => {
        const result = terminalLayoutSchema.safeParse({
            root: group('group-1', ['terminal-1']),
            activeGroupId: 'missing-group',
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('not part of the Terminal layout');
    });

    it('rejects a layout exceeding the maximum node count', () => {
        let node: TerminalLayoutNode = group('leaf', ['terminal-leaf']);
        for (let index = 0; index < 32; index += 1) {
            node = split(`split-${index}`, node, group(`group-${index}`, [`terminal-${index}`]));
        }
        const result = terminalLayoutSchema.safeParse({ root: node });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('exceeds 31 nodes');
    });

    it('rejects a layout exceeding the maximum Terminal count', () => {
        const terminalIds = Array.from({ length: 17 }, (_, index) => `terminal-${index}`);
        const result = terminalLayoutSchema.safeParse({
            root: group('group-1', terminalIds),
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.message).toContain('exceeds 16 Terminals');
    });

    it('bounds the split ratio to the documented safe range', () => {
        const tooNarrow = terminalLayoutSchema.safeParse({
            root: split(
                'split-1',
                group('group-1', ['terminal-1']),
                group('group-2', ['terminal-2']),
                MIN_SPLIT_RATIO - 0.01,
            ),
        });
        const tooWide = terminalLayoutSchema.safeParse({
            root: split(
                'split-1',
                group('group-1', ['terminal-1']),
                group('group-2', ['terminal-2']),
                MAX_SPLIT_RATIO + 0.01,
            ),
        });
        expect(tooNarrow.success).toBe(false);
        expect(tooWide.success).toBe(false);
    });
});
