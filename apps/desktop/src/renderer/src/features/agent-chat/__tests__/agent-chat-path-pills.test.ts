import type { DragEvent } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { startFilePathDrag } from '../../../lib/file-drag';
import type { AgentChatPathPill } from '../agent-chat-path-pills';
import { agentChatDropPathPills, agentChatPathPillRanges } from '../agent-chat-path-pills';

vi.mock('../../../stores/environment', () => ({ isSshHost: () => false }));

function transfer(): DataTransfer {
    const data = new Map<string, string>();
    return {
        effectAllowed: 'none',
        files: [] as unknown as FileList,
        getData: (type: string) => data.get(type) ?? '',
        setData: (type: string, value: string) => data.set(type, value),
        get types() {
            return data.keys().toArray();
        },
    } as unknown as DataTransfer;
}

function drop(dataTransfer: DataTransfer): DragEvent {
    return { dataTransfer } as DragEvent;
}

function pills(...list: AgentChatPathPill[]): Map<string, AgentChatPathPill> {
    return new Map(list.map((pill) => [pill.token, pill]));
}

describe('agentChatDropPathPills', () => {
    it('keeps a Files entry absolute and marks a folder', () => {
        const folder = transfer();
        startFilePathDrag(folder, '/repo/.githooks', true, true);
        expect(agentChatDropPathPills(drop(folder))).toEqual([
            { kind: 'directory', path: '/repo/.githooks', token: '/repo/.githooks' },
        ]);
        const file = transfer();
        startFilePathDrag(file, '/repo/my notes.md', false);
        expect(agentChatDropPathPills(drop(file))).toEqual([
            { kind: 'file', path: '/repo/my notes.md', token: "'/repo/my notes.md'" },
        ]);
    });
});

describe('agentChatPathPillRanges', () => {
    const source = { kind: 'directory', path: '/repo/src', token: '/repo/src' } as const;
    const index = {
        kind: 'file',
        path: '/repo/src/index.ts',
        token: '/repo/src/index.ts',
    } as const;

    it('finds only whole-word tokens a drop wrote', () => {
        const text = 'see /repo/src and /repo/src/index.ts, /repo/srcx';
        expect(
            agentChatPathPillRanges(text, pills(source, index)).map(({ from, to }) =>
                text.slice(from, to),
            ),
        ).toEqual(['/repo/src']);
        expect(
            agentChatPathPillRanges('/repo/src/index.ts /repo/src', pills(source, index)),
        ).toEqual([
            { from: 0, pill: index, to: 18 },
            { from: 19, pill: source, to: 28 },
        ]);
    });
});
