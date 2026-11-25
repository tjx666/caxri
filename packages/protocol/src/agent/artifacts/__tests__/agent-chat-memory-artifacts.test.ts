import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../../agent-chat-contract';
import {
    agentChatMemoryActionLabel,
    agentChatMemoryTitle,
    agentChatMemoryTypeLabel,
    isAgentChatMemoryIndexPath,
    isAgentChatMemoryPath,
} from '../agent-chat-memory-artifacts';
import { collectAgentChatTurnArtifacts } from '../agent-chat-turn-artifacts';

const MEMORY_DIR = '/home/dev/.claude/projects/-home-dev-app/memory';

const fileChange = (
    id: string,
    changes: Extract<AgentChatItem, { type: 'fileChange' }>['changes'],
): AgentChatItem => ({ id, type: 'fileChange', status: 'completed', changes });

/**
 * A Claude Code create arrives as a replacement body: a bare `@@`, then every line prefixed with `+`.
 */
const created = (lines: readonly string[]): string =>
    ['@@', ...lines.map((line) => `+${line}`)].join('\n');

const MEMORY_FILE = [
    '---',
    'name: fix-from-requirements',
    'description: "Propose the design the requirements call for, not the smallest patch"',
    'metadata:',
    '  type: feedback',
    '---',
    '',
    'Re-derive the fix from the requirements.',
    '',
    '**Why:** patches pile up.',
];

describe('memory paths', () => {
    it('matches memory files under any hidden config directory, not a repository folder', () => {
        expect(isAgentChatMemoryPath(`${MEMORY_DIR}/fix.md`)).toBe(true);
        expect(isAgentChatMemoryPath('/home/dev/.claude-work/projects/x/memory/a.md')).toBe(true);
        expect(isAgentChatMemoryPath(String.raw`C:\Users\dev\.claude\projects\x\memory\a.md`)).toBe(
            true,
        );
        expect(isAgentChatMemoryPath('/repo/projects/x/memory/a.md')).toBe(false);
        expect(isAgentChatMemoryPath(`${MEMORY_DIR}/MEMORY.md`)).toBe(false);
        expect(isAgentChatMemoryIndexPath(`${MEMORY_DIR}/MEMORY.md`)).toBe(true);
    });
});

describe('collectAgentChatTurnArtifacts memories', () => {
    it('turns a created memory into a card and folds its index pointer into it', () => {
        const artifacts = collectAgentChatTurnArtifacts('t1', [
            fileChange('f1', [
                { path: `${MEMORY_DIR}/fix.md`, kind: 'add', diff: created(MEMORY_FILE) },
                {
                    path: `${MEMORY_DIR}/MEMORY.md`,
                    kind: 'update',
                    diff: '@@ -1 +1,2 @@\n a\n+- [Fix](fix.md)',
                },
                { path: '/repo/src/app.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
            ]),
        ]);
        expect(artifacts?.files.map((file) => file.path)).toEqual(['/repo/src/app.ts']);
        expect(artifacts?.memories).toMatchObject([
            {
                action: 'created',
                name: 'fix-from-requirements',
                description: 'Propose the design the requirements call for, not the smallest patch',
                type: 'feedback',
                body: 'Re-derive the fix from the requirements.\n\n**Why:** patches pile up.',
            },
        ]);
    });

    it('keeps an update without visible frontmatter by its file name and without a body', () => {
        const artifacts = collectAgentChatTurnArtifacts('t1', [
            fileChange('f1', [
                {
                    path: `${MEMORY_DIR}/keep-short.md`,
                    kind: 'update',
                    diff: '@@ -3 +3 @@\n-old\n+new',
                },
            ]),
        ]);
        expect(artifacts?.files).toEqual([]);
        const memory = artifacts?.memories[0];
        expect(memory).toMatchObject({ action: 'updated', name: 'keep-short' });
        expect(memory?.body).toBeUndefined();
        expect(memory?.type).toBeUndefined();
    });

    it('lists an index-only edit as a changed file', () => {
        const artifacts = collectAgentChatTurnArtifacts('t1', [
            fileChange('f1', [
                { path: `${MEMORY_DIR}/MEMORY.md`, kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
            ]),
        ]);
        expect(artifacts?.memories).toEqual([]);
        expect(artifacts?.files.map((file) => file.path)).toEqual([`${MEMORY_DIR}/MEMORY.md`]);
    });

    it('names a deleted memory from the frontmatter it removed', () => {
        const artifacts = collectAgentChatTurnArtifacts('t1', [
            fileChange('f1', [
                {
                    path: `${MEMORY_DIR}/fix.md`,
                    kind: 'delete',
                    diff: ['@@', ...MEMORY_FILE.map((line) => `-${line}`)].join('\n'),
                },
            ]),
        ]);
        expect(artifacts?.memories).toMatchObject([
            { action: 'deleted', name: 'fix-from-requirements', type: 'feedback' },
        ]);
    });
});

describe('memory labels', () => {
    it('says what happened and the category', () => {
        expect(agentChatMemoryActionLabel({ action: 'created' })).toBe('Saved memory');
        expect(agentChatMemoryTypeLabel({ type: 'feedback' })).toBe('Feedback');
        expect(agentChatMemoryTypeLabel({})).toBeUndefined();
    });
});

describe('agentChatMemoryTitle', () => {
    it('prefers the description, and reads a file-name slug as words', () => {
        expect(
            agentChatMemoryTitle({ name: 'keep-worktrees', description: 'Never prune worktrees' }),
        ).toBe('Never prune worktrees');
        expect(agentChatMemoryTitle({ name: 'keep-worktrees' })).toBe('Keep worktrees');
        expect(agentChatMemoryTitle({ name: 'feedback_testing_style' })).toBe(
            'Feedback testing style',
        );
        expect(agentChatMemoryTitle({ name: 'Release checklist' })).toBe('Release checklist');
        expect(agentChatMemoryTitle({ name: 'notes' })).toBe('notes');
    });
});
