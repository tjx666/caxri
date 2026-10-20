import { describe, expect, it } from 'vitest';

import { agentChatMcpIconUrls, agentChatMcpServerFor } from '../agent-chat-mcp-icons';

describe('agentChatMcpIconUrls', () => {
    it('leads with the dark icon, then unthemed, then light, then the sites favicons', () => {
        expect(
            agentChatMcpIconUrls({
                name: 'exa',
                icons: [
                    { src: 'https://cdn.example/light.png', theme: 'light' },
                    { src: 'https://cdn.example/any.png' },
                    { src: 'https://cdn.example/dark.png', theme: 'dark' },
                ],
                siteOrigins: ['https://exa.example'],
            }),
        ).toEqual([
            'https://cdn.example/dark.png',
            'https://cdn.example/any.png',
            'https://cdn.example/light.png',
            'https://exa.example/favicon.ico',
        ]);
    });

    it('has nothing to load for an undescribed server and ignores non-HTTPS icons', () => {
        expect(agentChatMcpIconUrls(undefined)).toEqual([]);
        expect(
            agentChatMcpIconUrls({ name: 'x', icons: [{ src: 'data:image/png;base64,AAAA' }] }),
        ).toEqual([]);
    });
});

describe('agentChatMcpServerFor', () => {
    const servers = new Map([['exa', { name: 'exa' }]]);

    it('finds the server a Claude Code or Codex tool name carries', () => {
        expect(agentChatMcpServerFor(servers, 'mcp__exa__web_search_exa')).toEqual({ name: 'exa' });
        expect(agentChatMcpServerFor(servers, 'exa/web_search_exa')).toEqual({ name: 'exa' });
        expect(agentChatMcpServerFor(servers, 'other/tool')).toBeUndefined();
        expect(agentChatMcpServerFor(servers, 'shell')).toBeUndefined();
    });
});
