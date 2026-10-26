import { history, redo, undo } from '@codemirror/commands';
import type { Transaction as TransactionType } from '@codemirror/state';
import { EditorSelection, EditorState, Transaction } from '@codemirror/state';
import { describe, expect, it } from 'vitest';

import {
    agentChatDraftChange,
    agentChatDraftTransaction,
    agentChatLimitedChange,
} from '../agent-chat-composer-view';

describe('agentChatDraftChange', () => {
    it('replaces only the span that differs', () => {
        expect(agentChatDraftChange('ask @se now', 'ask @session-1 now')).toEqual({
            from: 7,
            insert: 'ssion-1',
            to: 7,
        });
        expect(agentChatDraftChange('abc', '')).toEqual({ from: 0, insert: '', to: 3 });
        expect(agentChatDraftChange('same', 'same')).toBeUndefined();
    });

    it('keeps the overlap of a repeated character', () => {
        expect(agentChatDraftChange('aa', 'aaa')).toEqual({ from: 2, insert: 'a', to: 2 });
    });
});

describe('agentChatDraftTransaction', () => {
    it('keeps a cleared or replaced draft off the undo stack', () => {
        const cleared = agentChatDraftTransaction('sent message', '');
        expect(cleared?.annotations).toEqual(Transaction.addToHistory.of(false));
        const restored = agentChatDraftTransaction('', 'stashed');
        expect(restored?.annotations).toEqual(Transaction.addToHistory.of(false));
    });

    it('puts the caret at the end, as setting a textarea value does', () => {
        expect(agentChatDraftTransaction('', '> quoted\n\n')?.selection).toEqual(
            EditorSelection.cursor(10),
        );
    });

    it('lets an insertion into the draft be undone on its own, apart from the typing it replaced', () => {
        let state = EditorState.create({ doc: '', extensions: [history()] });
        const dispatch = (transaction: TransactionType) => {
            state = transaction.state;
        };
        dispatch(state.update({ changes: { from: 0, insert: '@fix' }, userEvent: 'input.type' }));
        const chosen = '@/tmp/s.md contains the conversation from Session "Fix login". ';
        dispatch(state.update(agentChatDraftTransaction('@fix', chosen)!));
        expect(undo({ state, dispatch })).toBe(true);
        expect(state.doc.toString()).toBe('@fix');
        expect(redo({ state, dispatch })).toBe(true);
        expect(state.doc.toString()).toBe(chosen);
    });
});

describe('agentChatLimitedChange', () => {
    const state = EditorState.create({ doc: '12345' });

    it('trims typed or pasted text to the limit, as maxLength does', () => {
        const transaction = state.update({
            changes: { from: 5, insert: 'abcdef' },
            userEvent: 'input.paste',
        });
        const limited = agentChatLimitedChange(transaction, 8);
        expect(limited).toMatchObject({ changes: { from: 5, insert: 'abc', to: 5 } });
    });

    it('refuses input once the draft is full', () => {
        const full = state.update({ changes: { from: 5, insert: 'x' }, userEvent: 'input.type' });
        expect(agentChatLimitedChange(full, 5)).toEqual([]);
    });

    it('leaves programmatic changes and changes within the limit alone', () => {
        const programmatic = state.update({ changes: { from: 5, insert: 'abcdef' } });
        expect(agentChatLimitedChange(programmatic, 8)).toBeUndefined();
        const small = state.update({ changes: { from: 5, insert: 'a' }, userEvent: 'input.type' });
        expect(agentChatLimitedChange(small, 8)).toBeUndefined();
    });
});
