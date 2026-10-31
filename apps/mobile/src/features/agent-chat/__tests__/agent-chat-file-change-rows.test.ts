import { describe, expect, it } from 'vitest';

import { agentChatChangeColor, agentChatChangeRows } from '../agent-chat-file-change-rows';

describe('agentChatChangeRows', () => {
    it("draws a Chat diff in the Changes tab's row shape", () => {
        expect(
            agentChatChangeRows([
                { kind: 'hunk', text: '@@ -1 +1 @@' },
                { kind: 'removed', text: 'a', oldLine: 1 },
                { kind: 'added', text: 'b', newLine: 1 },
                { kind: 'context', text: 'c', oldLine: 2, newLine: 2 },
            ]),
        ).toEqual([
            {
                id: '0',
                kind: 'hunk',
                content: '@@ -1 +1 @@',
                oldLine: null,
                newLine: null,
                marker: ' ',
            },
            { id: '1', kind: 'removed', content: 'a', oldLine: 1, newLine: null, marker: '−' },
            { id: '2', kind: 'added', content: 'b', oldLine: null, newLine: 1, marker: '+' },
            { id: '3', kind: 'context', content: 'c', oldLine: 2, newLine: 2, marker: ' ' },
        ]);
    });

    it('colors each change kind with its Git status color', () => {
        expect(agentChatChangeColor('add')).toBe('gitAdded');
        expect(agentChatChangeColor('delete')).toBe('gitDeleted');
        expect(agentChatChangeColor('update')).toBe('gitModified');
    });
});
