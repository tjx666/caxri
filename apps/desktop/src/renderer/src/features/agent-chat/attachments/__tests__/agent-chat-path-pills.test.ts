import type { DragEvent } from 'react';

import { describe, expect, it, vi } from 'vitest';

import { startFilePathDrag } from '../../../../lib/file-drag';
import type { AgentChatPathPill } from '../agent-chat-path-pills';
import {
    agentChatDraftPathPills,
    agentChatDropPathPills,
    agentChatPathPillRanges,
    isPathInsideProject,
} from '../agent-chat-path-pills';

vi.mock('../../../../stores/environment', () => ({ isSshHost: () => false }));

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
            { kind: 'directory', path: '/repo/.githooks', token: '/repo/.githooks/' },
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

describe('agentChatDraftPathPills', () => {
    it('brings the dropped paths of a restored draft back as pills', () => {
        const draft = "check /repo/docs/a.md and '/repo/my docs/' /btw /repo/b.ts:12 then";
        const pills = agentChatDraftPathPills(draft);

        expect(pills.values().toArray()).toEqual([
            { kind: 'file', path: '/repo/docs/a.md', token: '/repo/docs/a.md' },
            { kind: 'directory', path: '/repo/my docs', token: "'/repo/my docs/'" },
        ]);
        expect(agentChatPathPillRanges(draft, pills).map(({ pill }) => pill.path)).toEqual([
            '/repo/docs/a.md',
            '/repo/my docs',
        ]);
    });

    it('keeps a restored drop a pill next to a later one', () => {
        const pills = new Map(agentChatDraftPathPills('check /repo/docs/a.md'));
        const dropped: AgentChatPathPill = {
            kind: 'file',
            path: '/repo/b.md',
            token: '/repo/b.md',
        };
        pills.set(dropped.token, dropped);

        expect(
            agentChatPathPillRanges('check /repo/docs/a.md /repo/b.md now', pills).map(
                ({ pill }) => pill.path,
            ),
        ).toEqual(['/repo/docs/a.md', '/repo/b.md']);
    });
});

describe('isPathInsideProject', () => {
    it('accepts the Project root and paths under it, and nothing else', () => {
        expect(isPathInsideProject('/repo', '/repo')).toBe(true);
        expect(isPathInsideProject('/repo/src', '/repo/')).toBe(true);
        expect(isPathInsideProject('/repository', '/repo')).toBe(false);
        expect(isPathInsideProject('/elsewhere/src', '/repo')).toBe(false);
        expect(isPathInsideProject('/repo/src', undefined)).toBe(false);
    });
});
