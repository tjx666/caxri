import type { AgentChatEditedFile, AgentChatFileChange } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    agentChatRedoFailureMessage,
    agentChatRedoSuccessMessage,
    agentChatUndoFailureMessage,
    agentChatUndoSuccessMessage,
    planAgentChatFileRedo,
    planAgentChatFileUndo,
    revertAgentChatUpdate,
} from '../agent-chat-undo';

const edited = (
    changes: AgentChatFileChange[],
    kind: AgentChatEditedFile['kind'] = 'update',
): AgentChatEditedFile => ({
    path: '/project/a.ts',
    kind,
    changes,
    truncated: changes.some((change) => change.truncated === true),
    additions: 0,
    deletions: 0,
});

describe('revertAgentChatUpdate', () => {
    it('reverses positioned hunks bottom-up and keeps CRLF line endings', () => {
        const diff = [
            '@@ -1,2 +1,2 @@',
            ' one',
            '-two',
            '+TWO',
            '@@ -5,1 +5,2 @@',
            ' five',
            '+six',
        ].join('\n');
        const after = ['one', 'TWO', 'three', 'four', 'five', 'six', ''].join('\r\n');
        expect(revertAgentChatUpdate(after, { path: 'a', kind: 'update', diff })).toBe(
            ['one', 'two', 'three', 'four', 'five', ''].join('\r\n'),
        );
    });

    it('relocates only a distinctive hunk, and refuses a short one that moved', () => {
        const moved = '@@ -2,3 +2,3 @@\n a\n-b\n+B\n c';
        expect(
            revertAgentChatUpdate('x\ny\na\nB\nc\n', { path: 'a', kind: 'update', diff: moved }),
        ).toBe('x\ny\na\nb\nc\n');
        // The edit's own lines are gone; a matching line elsewhere must not be rewritten instead.
        const short = '@@ -1,1 +1,2 @@\n+  return 1;\n }';
        expect(
            revertAgentChatUpdate('function g() {\n  return 1;\n}\n', {
                path: 'a',
                kind: 'update',
                diff: short,
            }),
        ).toBeUndefined();
    });

    it('restores a context-free removal only into the file it emptied', () => {
        const removal = '@@ -1,2 +0,0 @@\n-one\n-two';
        expect(revertAgentChatUpdate('', { path: 'a', kind: 'update', diff: removal })).toBe(
            'one\ntwo\n',
        );
        expect(
            revertAgentChatUpdate('later\n', { path: 'a', kind: 'update', diff: removal }),
        ).toBeUndefined();
    });

    it('keeps CRLF on context lines when the diff carried their carriage returns', () => {
        const diff = '@@ -1,3 +1,3 @@\n a\r\n-b\r\n+B\r\n c\r';
        expect(revertAgentChatUpdate('a\r\nB\r\nc\r\n', { path: 'a', kind: 'update', diff })).toBe(
            'a\r\nb\r\nc\r\n',
        );
    });

    it('refuses a whole-file replacement that names no original lines', () => {
        expect(
            revertAgentChatUpdate('new content\n', {
                path: 'a',
                kind: 'update',
                diff: '@@\n+new content',
            }),
        ).toBeUndefined();
    });

    it('needs a replacement without position to match exactly once', () => {
        const diff = '@@\n-old\n+new';
        expect(revertAgentChatUpdate('a\nnew\nb\n', { path: 'a', kind: 'update', diff })).toBe(
            'a\nold\nb\n',
        );
        expect(
            revertAgentChatUpdate('new\nnew\n', { path: 'a', kind: 'update', diff }),
        ).toBeUndefined();
        expect(
            revertAgentChatUpdate('none\n', { path: 'a', kind: 'update', diff }),
        ).toBeUndefined();
    });
});

describe('planAgentChatFileUndo', () => {
    it('replays several edits to one file newest first', () => {
        const file = edited([
            { path: '/project/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
            { path: '/project/a.ts', kind: 'update', diff: '@@ -1 +1 @@\n-b\n+c' },
        ]);
        expect(planAgentChatFileUndo(file, 'c\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'write', content: 'a\n' },
        });
    });

    it('trashes a created file only while it still holds what was written', () => {
        const file = edited(
            [{ path: '/project/a.ts', kind: 'add', diff: '@@\n+line one\n+line two' }],
            'add',
        );
        expect(planAgentChatFileUndo(file, 'line one\nline two\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'trash' },
        });
        expect(planAgentChatFileUndo(file, 'line one\nedited\n')).toEqual({
            ok: false,
            path: '/project/a.ts',
            reason: 'changed',
        });
    });

    it('restores a deleted file and refuses when it exists again or the diff was cut', () => {
        const deleted = edited(
            [{ path: '/project/a.ts', kind: 'delete', diff: 'one\ntwo\n' }],
            'delete',
        );
        expect(planAgentChatFileUndo(deleted, undefined)).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'restore', content: 'one\ntwo\n' },
        });
        expect(planAgentChatFileUndo(deleted, 'new')).toMatchObject({
            ok: false,
            reason: 'exists',
        });
        const cut = edited([
            { path: '/project/a.ts', kind: 'update', diff: '@@\n-a\n+b', truncated: true },
        ]);
        expect(planAgentChatFileUndo(cut, 'b')).toMatchObject({ ok: false, reason: 'truncated' });
    });
});

describe('planAgentChatFileUndo on a turn already undone', () => {
    const none = { ok: true, step: { path: '/project/a.ts', action: 'none' } };

    it('recognizes an update file already back at its content from before the turn', () => {
        const file = edited([
            {
                path: '/project/a.ts',
                kind: 'update',
                diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three',
            },
            {
                path: '/project/a.ts',
                kind: 'update',
                diff: '@@ -1,3 +1,3 @@\n one\n-TWO\n+2\n three',
            },
        ]);
        expect(planAgentChatFileUndo(file, 'one\n2\nthree\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'write', content: 'one\ntwo\nthree\n' },
        });
        expect(planAgentChatFileUndo(file, 'one\ntwo\nthree\n')).toEqual(none);
    });

    it('recognizes a created file already gone and a deleted file already back', () => {
        const created = edited(
            [{ path: '/project/a.ts', kind: 'add', diff: '@@\n+line one\n+line two' }],
            'add',
        );
        expect(planAgentChatFileUndo(created, undefined)).toEqual(none);
        const deleted = edited(
            [{ path: '/project/a.ts', kind: 'delete', diff: 'one\ntwo\n' }],
            'delete',
        );
        expect(planAgentChatFileUndo(deleted, 'one\ntwo\n')).toEqual(none);
        expect(planAgentChatFileUndo(deleted, 'other\n')).toMatchObject({
            ok: false,
            reason: 'exists',
        });
    });

    it('still reports a file changed to something that is neither before nor after the turn', () => {
        const file = edited([
            {
                path: '/project/a.ts',
                kind: 'update',
                diff: '@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three',
            },
        ]);
        expect(planAgentChatFileUndo(file, 'one\nlater\nthree\n')).toMatchObject({
            ok: false,
            reason: 'changed',
        });
    });

    it('prefers undoing an append that also replays onto its own result', () => {
        const file = edited([
            { path: '/project/a.ts', kind: 'update', diff: '@@ -1,3 +1,4 @@\n a\n b\n c\n+d' },
        ]);
        expect(planAgentChatFileUndo(file, 'a\nb\nc\nd\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'write', content: 'a\nb\nc\n' },
        });
    });
});

describe('planAgentChatFileRedo', () => {
    const file = { path: '/project/a.ts', displayPath: 'a.ts', before: 'b\n', after: 'a\n' };

    it('puts back what the Undo replaced while the file holds what the Undo wrote', () => {
        expect(planAgentChatFileRedo(file, 'a\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'write', content: 'b\n' },
        });
        expect(planAgentChatFileRedo({ ...file, after: undefined }, undefined)).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'restore', content: 'b\n' },
        });
        expect(planAgentChatFileRedo({ ...file, before: undefined }, 'a\n')).toEqual({
            ok: true,
            step: { path: '/project/a.ts', action: 'trash' },
        });
    });

    it('refuses to overwrite a file that changed after the Undo', () => {
        expect(planAgentChatFileRedo(file, 'later\n')).toMatchObject({
            ok: false,
            reason: 'changed',
        });
        expect(planAgentChatFileRedo(file, undefined)).toMatchObject({
            ok: false,
            reason: 'missing',
        });
        expect(planAgentChatFileRedo({ ...file, after: undefined }, 'new\n')).toMatchObject({
            ok: false,
            reason: 'exists',
        });
    });

    it('names the blocking file and counts the files redone', () => {
        expect(agentChatRedoFailureMessage('src/a.ts', 'changed')).toBe(
            'Nothing was redone: src/a.ts cannot be restored because it changed after the Undo.',
        );
        expect(agentChatRedoSuccessMessage(2)).toBe('Redid the changes to 2 files');
    });
});

describe('agentChatUndoFailureMessage', () => {
    it('names the next step when a later change blocks the Undo', () => {
        expect(agentChatUndoFailureMessage('src/a.ts', 'changed')).toBe(
            'Nothing was undone: src/a.ts cannot be restored because it changed after the Agent edited it. Undo the later turn that edited it first, or use Restore Code to Here on the message that started this turn.',
        );
    });

    it('states the cause alone when there is nothing to do instead', () => {
        expect(agentChatUndoFailureMessage('src/a.ts', 'missing')).toBe(
            'Nothing was undone: src/a.ts cannot be restored because it no longer exists.',
        );
    });
});

describe('agentChatUndoSuccessMessage', () => {
    it('counts the files restored', () => {
        expect(agentChatUndoSuccessMessage(1)).toBe('Undid the changes to 1 file');
        expect(agentChatUndoSuccessMessage(3)).toBe('Undid the changes to 3 files');
    });
});
