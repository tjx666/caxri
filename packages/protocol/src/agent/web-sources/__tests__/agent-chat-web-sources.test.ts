import { describe, expect, it } from 'vitest';

import type { AgentChatItem } from '../../agent-chat-contract';
import { collectAgentChatWebSources, readAgentChatWebSources } from '../agent-chat-web-sources';

const tool = (
    name: string,
    fields: Partial<Extract<AgentChatItem, { type: 'toolCall' }>> = {},
): Extract<AgentChatItem, { type: 'toolCall' }> => ({
    id: `${name}-${fields.summary ?? ''}`,
    type: 'toolCall',
    name,
    status: 'completed',
    ...fields,
});

describe('readAgentChatWebSources', () => {
    it("reads Claude Code's WebSearch links with their titles", () => {
        const result = [
            'Web search results for query: "tab groups"',
            '',
            'Links: [{"title":"Save tab groups","url":"https://example.com/a"},{"title":"Help","url":"https://help.example.org/b"}]',
            '',
            'Some summary mentioning https://example.net/ignored in prose.',
        ].join('\n');
        expect(
            readAgentChatWebSources(tool('WebSearch', { summary: 'tab groups' }), result),
        ).toEqual([
            { url: 'https://example.com/a', title: 'Save tab groups' },
            { url: 'https://help.example.org/b', title: 'Help' },
        ]);
    });

    it('takes a fetch’s URL from its arguments, not the links inside the page', () => {
        expect(
            readAgentChatWebSources(
                tool('WebFetch', { summary: 'https://example.com/docs.' }),
                'See https://example.net/other for more',
            ),
        ).toEqual([{ url: 'https://example.com/docs' }]);
    });

    it('reads Title/URL entries from a search MCP and ignores other MCP tools', () => {
        const result =
            'Title: First\nURL: https://example.com/1\nHighlights:\n…\n\nTitle: Second\nURL: https://example.com/2\n';
        expect(readAgentChatWebSources(tool('mcp__exa__web_search_exa'), result)).toEqual([
            { url: 'https://example.com/1', title: 'First' },
            { url: 'https://example.com/2', title: 'Second' },
        ]);
        expect(
            readAgentChatWebSources(
                tool('mcp__files__read', { summary: 'https://example.com' }),
                result,
            ),
        ).toEqual([]);
    });

    it('ignores non-web tools and non-http addresses', () => {
        expect(
            readAgentChatWebSources(tool('Bash', { summary: 'curl https://example.com' }), ''),
        ).toEqual([]);
        expect(
            readAgentChatWebSources(tool('WebFetch', { summary: 'file:///etc/hosts' }), ''),
        ).toEqual([]);
    });
});

describe('collectAgentChatWebSources', () => {
    it('merges a turn’s sources in order, deduplicated, keeping a known title', () => {
        const items: AgentChatItem[] = [
            tool('WebFetch', { summary: 'https://example.com/a' }),
            tool('WebSearch', {
                summary: 'query',
                sources: [
                    { url: 'https://example.com/a', title: 'A' },
                    { url: 'https://example.com/b', title: 'B' },
                ],
            }),
            { id: 'm', type: 'agentMessage', text: 'https://example.com/c', streaming: false },
        ];
        expect(collectAgentChatWebSources(items)).toEqual([
            { url: 'https://example.com/a', title: 'A' },
            { url: 'https://example.com/b', title: 'B' },
        ]);
    });
});
