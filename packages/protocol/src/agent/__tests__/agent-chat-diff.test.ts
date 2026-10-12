import { describe, expect, it } from 'vitest';

import {
    agentChatChangeDecoration,
    agentChatChangeKindLabel,
    agentChatDiffLines,
    agentChatDiffStat,
    agentChatFileChangesStat,
    agentChatFilesChangedLabel,
    canOpenAgentChatChange,
} from '../agent-chat-diff';

describe('agentChatDiffLines', () => {
    it('numbers an update hunk by hunk and keeps both sides in step', () => {
        const diff = [
            '@@ -1,3 +1,3 @@',
            ' keep',
            '-old',
            '+new',
            ' tail',
            '@@ -10,2 +10,3 @@',
            ' ten',
            '+inserted',
            ' eleven',
            '',
        ].join('\n');
        expect(agentChatDiffLines({ kind: 'update', diff })).toEqual([
            { kind: 'hunk', text: '@@ -1,3 +1,3 @@' },
            { kind: 'context', text: 'keep', oldLine: 1, newLine: 1 },
            { kind: 'removed', text: 'old', oldLine: 2 },
            { kind: 'added', text: 'new', newLine: 2 },
            { kind: 'context', text: 'tail', oldLine: 3, newLine: 3 },
            { kind: 'hunk', text: '@@ -10,2 +10,3 @@' },
            { kind: 'context', text: 'ten', oldLine: 10, newLine: 10 },
            { kind: 'added', text: 'inserted', newLine: 11 },
            { kind: 'context', text: 'eleven', oldLine: 11, newLine: 12 },
        ]);
    });

    it("reads Codex's rename note after the last hunk as a note, not as context", () => {
        const diff = '@@ -1 +1 @@\n-a\n+b\n\n\nMoved to: src/next.ts';
        expect(agentChatDiffLines({ kind: 'update', diff })).toEqual([
            { kind: 'hunk', text: '@@ -1 +1 @@' },
            { kind: 'removed', text: 'a', oldLine: 1 },
            { kind: 'added', text: 'b', newLine: 1 },
            { kind: 'meta', text: 'Moved to: src/next.ts' },
        ]);
    });

    it('treats a removed line that starts with dashes as a removal inside a hunk', () => {
        const diff = '--- a/notes.md\n+++ b/notes.md\n@@ -1,2 +1,1 @@\n--- divider\n keep';
        expect(agentChatDiffLines({ kind: 'update', diff })).toEqual([
            { kind: 'meta', text: '--- a/notes.md' },
            { kind: 'meta', text: '+++ b/notes.md' },
            { kind: 'hunk', text: '@@ -1,2 +1,1 @@' },
            { kind: 'removed', text: '-- divider', oldLine: 1 },
            { kind: 'context', text: 'keep', oldLine: 2, newLine: 1 },
        ]);
    });

    it('keeps a "no newline" marker and an empty context line whose space was stripped', () => {
        const diff = '@@ -1,2 +1,2 @@\n\n-a\n\\ No newline at end of file\n+b';
        expect(agentChatDiffLines({ kind: 'update', diff })).toEqual([
            { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
            { kind: 'context', text: '', oldLine: 1, newLine: 1 },
            { kind: 'removed', text: 'a', oldLine: 2 },
            { kind: 'meta', text: String.raw`\ No newline at end of file` },
            { kind: 'added', text: 'b', newLine: 2 },
        ]);
    });

    it('colors an update without hunk headers by prefix alone', () => {
        expect(agentChatDiffLines({ kind: 'update', diff: '+a\n-b\n c' })).toEqual([
            { kind: 'added', text: 'a' },
            { kind: 'removed', text: 'b' },
            { kind: 'context', text: 'c' },
        ]);
    });

    it("reads an added or deleted file's whole content as all-added or all-removed lines", () => {
        expect(agentChatDiffLines({ kind: 'add', diff: 'one\n+two\n' })).toEqual([
            { kind: 'added', text: 'one', newLine: 1 },
            { kind: 'added', text: '+two', newLine: 2 },
        ]);
        expect(agentChatDiffLines({ kind: 'delete', diff: 'gone' })).toEqual([
            { kind: 'removed', text: 'gone', oldLine: 1 },
        ]);
        expect(agentChatDiffLines({ kind: 'add', diff: '' })).toEqual([]);
    });

    it('strips the marker and prefixes of a replacement body for a created file', () => {
        expect(agentChatDiffLines({ kind: 'add', diff: '@@\n+one\n++two' })).toEqual([
            { kind: 'added', text: 'one', newLine: 1 },
            { kind: 'added', text: '+two', newLine: 2 },
        ]);
        expect(agentChatDiffLines({ kind: 'update', diff: '@@\n-a\n+b' })).toEqual([
            { kind: 'hunk', text: '@@' },
            { kind: 'removed', text: 'a' },
            { kind: 'added', text: 'b' },
        ]);
    });
});

describe('diff stats', () => {
    it('counts added and removed lines per change and across an item', () => {
        const update = { kind: 'update' as const, diff: '@@ -1,2 +1,2 @@\n-a\n+b\n+c\n' };
        expect(agentChatDiffStat(update)).toEqual({ additions: 2, deletions: 1 });
        expect(
            agentChatFileChangesStat([
                update,
                { kind: 'add', diff: 'x\ny\n' },
                { kind: 'delete', diff: 'z' },
            ]),
        ).toEqual({ additions: 4, deletions: 2 });
        expect(agentChatFileChangesStat([])).toEqual({ additions: 0, deletions: 0 });
    });

    it('labels the file count', () => {
        expect(agentChatFilesChangedLabel(1)).toBe('1 file changed');
        expect(agentChatFilesChangedLabel(3)).toBe('3 files changed');
    });
});

describe('file change presentation', () => {
    it('maps each change kind to the Git decoration Files and Source Control use', () => {
        expect(agentChatChangeDecoration('add')).toEqual({ kind: 'added', letter: 'A' });
        expect(agentChatChangeDecoration('delete')).toEqual({ kind: 'deleted', letter: 'D' });
        expect(agentChatChangeDecoration('update')).toEqual({ kind: 'modified', letter: 'M' });
        expect(agentChatChangeKindLabel('add')).toBe('Added');
        expect(agentChatChangeKindLabel('delete')).toBe('Deleted');
        expect(agentChatChangeKindLabel('update')).toBe('Modified');
    });

    it('opens only a path that exists: applied changes keep added files, pending ones keep deleted files', () => {
        expect(canOpenAgentChatChange('add', 'completed')).toBe(true);
        expect(canOpenAgentChatChange('delete', 'completed')).toBe(false);
        expect(canOpenAgentChatChange('update', 'completed')).toBe(true);
        expect(canOpenAgentChatChange('add', 'running')).toBe(false);
        expect(canOpenAgentChatChange('delete', 'running')).toBe(true);
        expect(canOpenAgentChatChange('update', 'declined')).toBe(true);
    });
});
