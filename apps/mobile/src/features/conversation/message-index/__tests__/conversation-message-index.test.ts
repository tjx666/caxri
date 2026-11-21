import { describe, expect, it } from 'vitest';

import {
    activeConversationMessage,
    conversationMessageMarks,
    conversationMessagePreview,
    isConversationMessageIndexShown,
} from '../conversation-message-index';

const entries = [
    { id: 'u1', user: 'Fix the  login\nbug' },
    { id: 'a1' },
    { id: 'tools' },
    { id: 'u2', user: 'Now add a test' },
    { id: 'a2' },
    { id: 'u3', user: '' },
];
const previewOf = (entry: { user?: string }): string | undefined => entry.user;

describe('conversationMessageMarks', () => {
    it('lists only user messages with their row index and a one-line preview', () => {
        expect(conversationMessageMarks(entries, previewOf)).toEqual([
            { id: 'u1', index: 0, preview: 'Fix the login bug' },
            { id: 'u2', index: 3, preview: 'Now add a test' },
            { id: 'u3', index: 5, preview: '' },
        ]);
    });
});

describe('conversationMessagePreview', () => {
    it('cuts a long message with an ellipsis', () => {
        const preview = conversationMessagePreview('x'.repeat(400));
        expect(preview).toHaveLength(160);
        expect(preview.endsWith('…')).toBe(true);
    });
});

describe('isConversationMessageIndexShown', () => {
    it('appears from the second message', () => {
        expect(isConversationMessageIndexShown(entries.slice(0, 3), previewOf)).toBe(false);
        expect(isConversationMessageIndexShown(entries.slice(0, 4), previewOf)).toBe(true);
    });
});

describe('activeConversationMessage', () => {
    const marks = conversationMessageMarks(entries, previewOf);

    it('is the message whose turn holds the first row in view', () => {
        expect(activeConversationMessage(marks, 0, false)).toBe(0);
        expect(activeConversationMessage(marks, 2, false)).toBe(0);
        expect(activeConversationMessage(marks, 3, false)).toBe(1);
        expect(activeConversationMessage(marks, 4, false)).toBe(1);
    });

    it('is the last message at the end of the list', () => {
        expect(activeConversationMessage(marks, 3, true)).toBe(2);
    });

    it('is the first message while older rows above it are in view', () => {
        const later = marks.slice(1);
        expect(activeConversationMessage(later, 1, false)).toBe(0);
    });

    it('is -1 with no messages', () => {
        expect(activeConversationMessage([], 4, false)).toBe(-1);
    });
});
