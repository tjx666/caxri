import { describe, expect, it } from 'vitest';

import { agentChatSelectionQuote } from '../agent-chat-selection';

describe('agentChatSelectionQuote', () => {
    it('quotes every line and keeps a blank line inside the same quote', () => {
        expect(agentChatSelectionQuote('first line\n\nsecond line  ')).toBe(
            '> first line\n>\n> second line',
        );
    });

    it('drops surrounding blank lines and normalizes Windows line endings', () => {
        expect(agentChatSelectionQuote('\n  \r\nonly line\r\n\n')).toBe('> only line');
    });

    it('is empty for whitespace alone', () => {
        expect(agentChatSelectionQuote(' \n\t\n')).toBe('');
    });
});
