import { describe, expect, it } from 'vitest';

import {
    agentChatMentionHeading,
    agentChatMentionRows,
    agentChatMentionToken,
    MAX_AGENT_CHAT_FILE_MENTIONS,
} from '../agent-chat-mentions';

describe('agentChatMentionToken', () => {
    it('reads the @ token at the end of the draft only', () => {
        expect(agentChatMentionToken('look at @src/ma')).toEqual({
            query: 'src/ma',
            token: '@src/ma',
        });
        expect(agentChatMentionToken('@')).toEqual({ query: '', token: '@' });
        expect(agentChatMentionToken('@src/main.ts then')).toBeUndefined();
        expect(agentChatMentionToken('mail@example')).toBeUndefined();
        expect(agentChatMentionToken('/review')).toBeUndefined();
    });
});

describe('agentChatMentionRows', () => {
    it('lists capped files with their folder, then Sessions with their Project', () => {
        const paths = Array.from({ length: 10 }, (_, index) => `src/f${index}.ts`);
        const rows = agentChatMentionRows(
            ['README.md', ...paths],
            [{ id: 's1', projectTitle: 'Demo', title: 'Fix login' }],
        );
        expect(rows).toHaveLength(MAX_AGENT_CHAT_FILE_MENTIONS + 1);
        expect(rows[0]).toEqual({
            kind: 'file',
            directory: '',
            name: 'README.md',
            path: 'README.md',
        });
        expect(rows[1]).toEqual({
            kind: 'file',
            directory: 'src',
            name: 'f0.ts',
            path: 'src/f0.ts',
        });
        expect(rows.at(-1)).toEqual({
            kind: 'session',
            projectTitle: 'Demo',
            sessionId: 's1',
            title: 'Fix login',
        });
        expect(
            rows.map((_, index) => agentChatMentionHeading(rows, index)).filter(Boolean),
        ).toEqual(['file', 'session']);
    });
});
