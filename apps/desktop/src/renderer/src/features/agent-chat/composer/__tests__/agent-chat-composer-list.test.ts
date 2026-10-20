import { describe, expect, it } from 'vitest';

import type { AgentChatTextEdit } from '../agent-chat-composer-list';
import {
    agentChatListContinuation,
    isAgentChatListContinuationKey,
} from '../agent-chat-composer-list';

/**
 * Applies Shift+Enter at the `|` caret (or `«...»` selection) and returns the text with the caret marked again.
 */
function press(marked: string): string | undefined {
    const selection = /«([\s\S]*)»/.exec(marked);
    const value = selection ? marked.replaceAll(/«|»/g, '') : marked.replace('|', '');
    const start = selection ? selection.index : marked.indexOf('|');
    const end = selection ? start + selection[1].length : start;
    const edit: AgentChatTextEdit | undefined = agentChatListContinuation(value, start, end);
    if (!edit) return undefined;
    const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    return `${next.slice(0, edit.caret)}|${next.slice(edit.caret)}`;
}

describe('agentChatListContinuation', () => {
    it('starts the next numbered item', () => {
        expect(press('1. item1|')).toBe('1. item1\n2. |');
        expect(press('9) nine|')).toBe('9) nine\n10) |');
    });

    it('repeats a bullet and keeps the indent', () => {
        expect(press('- one|')).toBe('- one\n- |');
        expect(press('  * nested|')).toBe('  * nested\n  * |');
    });

    it('starts an unchecked task after a task', () => {
        expect(press('- [x] done|')).toBe('- [x] done\n- [ ] |');
    });

    it('carries the text after the caret into the new item', () => {
        expect(press('- first| second')).toBe('- first\n- | second');
    });

    it('replaces a selection inside the item', () => {
        expect(press('- keep «drop»')).toBe('- keep \n- |');
    });

    it('ends the list on an item with no text', () => {
        expect(press('1. a\n2. |')).toBe('1. a\n|');
        expect(press('- [ ] |')).toBe('|');
    });

    it('renumbers the ordered items below, skipping their nested lines', () => {
        expect(press('1. a|\n2. b\n   - sub\n3. c\n\ntext')).toBe(
            '1. a\n2. |\n3. b\n   - sub\n4. c\n\ntext',
        );
    });

    it('leaves already numbered items alone', () => {
        expect(press('1. a|\n3. b')).toBe('1. a\n2. |\n3. b');
    });

    it('leaves the key to the textarea outside a list', () => {
        expect(press('plain|')).toBeUndefined();
        expect(press('1.no space|')).toBeUndefined();
        expect(press('-| item')).toBeUndefined();
        expect(press('- «a\n- b»')).toBeUndefined();
    });
});

describe('isAgentChatListContinuationKey', () => {
    const key = {
        altKey: false,
        ctrlKey: false,
        isComposing: false,
        key: 'Enter',
        metaKey: false,
        repeat: false,
        shiftKey: true,
    };

    it('is Shift+Enter only', () => {
        expect(isAgentChatListContinuationKey(key)).toBe(true);
        expect(isAgentChatListContinuationKey({ ...key, shiftKey: false })).toBe(false);
        expect(isAgentChatListContinuationKey({ ...key, metaKey: true })).toBe(false);
        expect(isAgentChatListContinuationKey({ ...key, isComposing: true })).toBe(false);
    });
});
