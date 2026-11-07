import { describe, expect, it } from 'vitest';

import type { AgentChatTextEdit } from '../agent-chat-composer-list';
import {
    agentChatIndentation,
    agentChatListContinuation,
    isAgentChatIndentKey,
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

/**
 * Applies Tab (or Shift+Tab with `isOutdent`) at the `|` caret (or `«...»` selection) and returns the text with the
 * caret marked again.
 */
function indent(marked: string, isOutdent = false): string | undefined {
    const selection = /«([\s\S]*)»/.exec(marked);
    const value = selection ? marked.replaceAll(/«|»/g, '') : marked.replace('|', '');
    const start = selection ? selection.index : marked.indexOf('|');
    const end = selection ? start + selection[1].length : start;
    const edit = agentChatIndentation(value, start, end, isOutdent);
    if (!edit) return undefined;
    const next = value.slice(0, edit.from) + edit.text + value.slice(edit.to);
    return `${next.slice(0, edit.caret)}|${next.slice(edit.caret)}`;
}

describe('agentChatIndentation', () => {
    it('nests a list item under the item above at its text column', () => {
        expect(indent('1. one\n2. |two')).toBe('1. one\n   2. |two');
        expect(indent('- one\n- tw|o')).toBe('- one\n  - tw|o');
        expect(indent('- [ ] one\n- [ ] |two')).toBe('- [ ] one\n  - [ ] |two');
    });

    it('nests the first item by its own marker width', () => {
        expect(indent('10. |one')).toBe('    10. |one');
    });

    it('nests a sub-item under its own sibling, not under its parent', () => {
        expect(indent('1. one\n   - a\n   - |b')).toBe('1. one\n   - a\n     - |b');
    });

    it('outdents a nested item back to its parent indent', () => {
        expect(indent('1. one\n   2. |two', true)).toBe('1. one\n2. |two');
        expect(indent('  - |one', true)).toBe('- |one');
    });

    it('types two spaces at the caret outside a list', () => {
        expect(indent('hello |world')).toBe('hello   |world');
        expect(indent('a «bc» d')).toBe('a   | d');
    });

    it('removes up to two leading spaces outside a list', () => {
        expect(indent('   |text', true)).toBe(' |text');
        expect(indent('te|xt', true)).toBeUndefined();
    });

    it('moves every line of a multi-line selection and keeps blank lines empty', () => {
        expect(indent('«a\n\nb»')).toBe('  a\n\n  b|');
        expect(indent('«  a\n b»', true)).toBe('a\nb|');
    });
});

describe('isAgentChatIndentKey', () => {
    const key = {
        altKey: false,
        ctrlKey: false,
        isComposing: false,
        key: 'Tab',
        metaKey: false,
        repeat: false,
        shiftKey: false,
    };

    it('takes Tab and Shift+Tab only', () => {
        expect(isAgentChatIndentKey(key)).toBe(true);
        expect(isAgentChatIndentKey({ ...key, shiftKey: true })).toBe(true);
        expect(isAgentChatIndentKey({ ...key, ctrlKey: true })).toBe(false);
        expect(isAgentChatIndentKey({ ...key, isComposing: true })).toBe(false);
    });
});
