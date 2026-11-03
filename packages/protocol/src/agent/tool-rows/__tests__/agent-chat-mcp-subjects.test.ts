import { describe, expect, it } from 'vitest';

import type { AgentChatWorkItem } from '../../agent-chat-work';
import { describeAgentChatWorkRow } from '../../agent-chat-work';

const call = (
    name: string,
    arguments_: unknown,
    output?: unknown,
    status: 'completed' | 'failed' | 'running' = 'completed',
): AgentChatWorkItem => ({
    type: 'toolCall',
    id: name,
    name,
    status,
    summary: typeof arguments_ === 'string' ? arguments_ : JSON.stringify(arguments_),
    ...(output !== undefined && {
        output: typeof output === 'string' ? output : JSON.stringify(output),
    }),
});

const row = (item: AgentChatWorkItem) => {
    const { label, subject, isCodeSubject } = describeAgentChatWorkRow(item);
    return { label, subject, isCodeSubject };
};

describe('MCP row subjects', () => {
    it('names a Linear issue by identifier and the title its result returned', () => {
        expect(
            row(
                call(
                    'mcp__linear__get_issue',
                    { id: 'LOBE-123' },
                    { id: 'LOBE-123', title: 'Fix the login loop', description: 'Long body' },
                ),
            ),
        ).toEqual({
            label: 'Get issue',
            subject: 'LOBE-123 · Fix the login loop',
            isCodeSubject: false,
        });
    });

    it('reads the title from a result cut to the output limit, and keeps the identifier alone without one', () => {
        const cut = String.raw`{"id":"LOBE-9","title":"Say \"hi\" twice","description":"aaaa`;
        expect(row(call('mcp__linear__get_issue', { id: 'LOBE-9' }, cut)).subject).toBe(
            'LOBE-9 · Say "hi" twice',
        );
        expect(
            row(call('mcp__linear__get_issue', { id: 'LOBE-9', fields: ['url'] }, { url: 'x' })),
        ).toMatchObject({ subject: 'LOBE-9', isCodeSubject: true });
        expect(row(call('mcp__linear__get_issue', { id: 'LOBE-9' }, undefined, 'running'))).toEqual(
            { label: 'Get issue', subject: 'LOBE-9', isCodeSubject: true },
        );
    });

    it('names the issue a Linear save created from its result, and comments by their issue', () => {
        expect(
            row(
                call(
                    'linear/save_issue',
                    { team: 'Engineering', title: 'Draft title', description: 'Body' },
                    { id: 'LOBE-7', uuid: 'u', title: 'Final title' },
                ),
            ).subject,
        ).toBe('LOBE-7 · Final title');
        expect(
            row(call('mcp__linear__save_comment', { issueId: 'LOBE-7', body: 'Done' })).subject,
        ).toBe('LOBE-7');
        expect(row(call('mcp__linear__list_comments', { issueId: 'LOBE-7' })).subject).toBe(
            'LOBE-7',
        );
    });

    it('names a Linear list by its search text or first filter', () => {
        expect(row(call('mcp__linear__list_issues', { query: 'login', limit: 10 }))).toMatchObject({
            subject: 'login',
            isCodeSubject: false,
        });
        expect(row(call('mcp__linear__list_issues', { assignee: 'me', limit: 10 }))).toMatchObject({
            subject: 'assignee: me',
            isCodeSubject: true,
        });
    });

    it('names Exa searches by query and fetches by URL', () => {
        expect(
            row(call('mcp__exa__web_search_exa', { query: 'electron cdp', numResults: 5 })),
        ).toMatchObject({ label: 'Web search exa', subject: 'electron cdp', isCodeSubject: false });
        expect(
            row(
                call('mcp__exa__web_fetch_exa', {
                    urls: ['https://example.com/docs/', 'https://example.org'],
                }),
            ),
        ).toMatchObject({ subject: 'example.com/docs +1', isCodeSubject: true });
    });

    it('shows any other server its first argument that names a target', () => {
        expect(row(call('mcp__docs__read', { verbose: true, id: 'doc_1' })).subject).toBe('doc_1');
        expect(row(call('mcp__docs__read', { verbose: true }))).toMatchObject({
            subject: undefined,
        });
        expect(row(call('mcp__exa__web_search_exa', 'bare query')).subject).toBe('bare query');
        const longSummary = 'x'.repeat(201);
        expect(row(call('mcp__docs__read', longSummary)).subject).toBeUndefined();
    });

    it('keeps the outcome in the verb of a failed call', () => {
        expect(
            row(call('mcp__linear__get_issue', { id: 'LOBE-1' }, 'Not found', 'failed')),
        ).toMatchObject({ label: 'Failed: Get issue', subject: 'LOBE-1' });
    });
});
