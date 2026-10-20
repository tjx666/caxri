import type { AgentChatWorkItem } from '@caxri/protocol';
import { agentChatWorkSummaryGlyph, describeAgentChatWorkRow } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { agentChatMcpIconCandidates, isDarkBackground } from '../agent-chat-mcp-icons';
import { agentChatToolArgumentEntries } from '../agent-chat-tool-argument-entries';

const toolCall = (
    name: string,
    status: 'completed' | 'failed' | 'running' = 'completed',
): AgentChatWorkItem => ({ type: 'toolCall', id: name, name, status });

const shell = (id: string): AgentChatWorkItem => ({
    type: 'command',
    id,
    command: 'pnpm test',
    output: '',
    status: 'completed',
});

describe('MCP tool rows', () => {
    it('reads as the tool, without the server prefix', () => {
        expect(describeAgentChatWorkRow(toolCall('mcp__exa__web_search_exa'))).toMatchObject({
            kind: 'mcp',
            label: 'Web search exa',
        });
        expect(describeAgentChatWorkRow(toolCall('exa/web_fetch_exa'))).toMatchObject({
            kind: 'mcp',
            label: 'Web fetch exa',
        });
        expect(describeAgentChatWorkRow(toolCall('exa/web_fetch_exa', 'failed')).label).toBe(
            'Failed: Web fetch exa',
        );
        expect(
            describeAgentChatWorkRow(toolCall('mcp__exa__web_search_exa')).subject,
        ).toBeUndefined();
    });

    it('leads a summary with its first kind and names the first MCP call', () => {
        expect(
            agentChatWorkSummaryGlyph([
                toolCall('mcp__exa__web_search_exa'),
                shell('a'),
                toolCall('mcp__linear__get_issue'),
            ]),
        ).toEqual({ kind: 'mcp', mcpToolName: 'mcp__exa__web_search_exa' });
        expect(agentChatWorkSummaryGlyph([shell('a'), toolCall('exa/web_search_exa')])).toEqual({
            kind: 'command',
        });
    });
});

describe('agentChatMcpIconCandidates', () => {
    const server = {
        name: 'exa',
        icons: [
            { src: 'https://exa.ai/light.png?v=2', theme: 'light' as const },
            { src: 'data:image/png;base64,AQID' },
            { src: 'https://exa.ai/dark.png', theme: 'dark' as const },
        ],
        siteOrigins: ['https://exa.ai', 'https://mcp.exa.ai'],
    };

    it('tries the icon drawn for the theme, then unthemed, then the other theme, then site icons', () => {
        expect(agentChatMcpIconCandidates(server, true)).toEqual([
            { kind: 'remote', origin: 'https://exa.ai', path: '/dark.png' },
            { kind: 'inline', src: 'data:image/png;base64,AQID' },
            { kind: 'remote', origin: 'https://exa.ai', path: '/light.png?v=2' },
            { kind: 'remote', origin: 'https://exa.ai' },
            { kind: 'remote', origin: 'https://mcp.exa.ai' },
        ]);
        expect(agentChatMcpIconCandidates(server, false).at(0)).toEqual({
            kind: 'remote',
            origin: 'https://exa.ai',
            path: '/light.png?v=2',
        });
    });

    it('has nothing to try for an undescribed server', () => {
        expect(agentChatMcpIconCandidates(undefined, true)).toEqual([]);
    });

    it('reads a theme background as dark or light', () => {
        expect(isDarkBackground('#1a1b26')).toBe(true);
        expect(isDarkBackground('#ffffff')).toBe(false);
    });
});

describe('agentChatToolArgumentEntries', () => {
    it('lists a JSON object as names and values', () => {
        expect(
            agentChatToolArgumentEntries(
                '{"query":"Gemini 4 site:openrouter.ai","numResults":5,"filters":{"lang":"en"}}',
            ),
        ).toEqual([
            { name: 'query', value: 'Gemini 4 site:openrouter.ai', isCode: false },
            { name: 'numResults', value: '5', isCode: true },
            { name: 'filters', value: '{\n  "lang": "en"\n}', isCode: true },
        ]);
    });

    it('leaves a clipped or non-object preview as written', () => {
        expect(agentChatToolArgumentEntries('{"query":"Gemini 4 si')).toBeUndefined();
        expect(agentChatToolArgumentEntries('["a"]')).toBeUndefined();
        expect(agentChatToolArgumentEntries('{}')).toBeUndefined();
        expect(agentChatToolArgumentEntries('src/app.ts')).toBeUndefined();
    });
});
