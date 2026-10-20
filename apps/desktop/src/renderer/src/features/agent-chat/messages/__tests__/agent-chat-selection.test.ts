import { describe, expect, it } from 'vitest';

import {
    AGENT_CHAT_SELECTION_TOOLBAR_GAP,
    agentChatSelectionQuote,
    agentChatSelectionToolbarPosition,
} from '../agent-chat-selection';

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

describe('agentChatSelectionToolbarPosition', () => {
    const bounds = { top: 100, bottom: 600, left: 0, right: 800 };
    const size = { width: 160, height: 28 };
    const line = (top: number, left = 300, right = 500) => ({
        top,
        bottom: top + 20,
        left,
        right,
    });

    it('centers the toolbar above the first selected line', () => {
        expect(
            agentChatSelectionToolbarPosition({ bounds, first: line(300), last: line(340), size }),
        ).toEqual({ top: 300 - AGENT_CHAT_SELECTION_TOOLBAR_GAP - 28, left: 320 });
    });

    it('moves below the last line when the transcript has no room above', () => {
        expect(
            agentChatSelectionToolbarPosition({ bounds, first: line(110), last: line(150), size }),
        ).toEqual({ top: 170 + AGENT_CHAT_SELECTION_TOOLBAR_GAP, left: 320 });
    });

    it('stays inside the transcript horizontally', () => {
        expect(
            agentChatSelectionToolbarPosition({
                bounds,
                first: line(300, 0, 40),
                last: line(300, 0, 40),
                size,
            })?.left,
        ).toBe(AGENT_CHAT_SELECTION_TOOLBAR_GAP);
        expect(
            agentChatSelectionToolbarPosition({
                bounds,
                first: line(300, 760, 800),
                last: line(300, 760, 800),
                size,
            })?.left,
        ).toBe(800 - AGENT_CHAT_SELECTION_TOOLBAR_GAP - 160);
    });

    it('hides while the selection is scrolled out of the transcript', () => {
        expect(
            agentChatSelectionToolbarPosition({ bounds, first: line(20), last: line(60), size }),
        ).toBeUndefined();
        expect(
            agentChatSelectionToolbarPosition({ bounds, first: line(640), last: line(680), size }),
        ).toBeUndefined();
    });
});
