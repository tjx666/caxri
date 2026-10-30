import type { McpServerStatus } from '@anthropic-ai/claude-agent-sdk';
import type { AgentChatPatchOperation, AgentChatSnapshot } from '@caxri/protocol';
import { applyAgentChatOperation, emptyAgentChatSnapshot } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

import type { McpServerReport } from '../chat-mcp-servers';
import {
    agentChatMcpServer,
    createChatMcpServerWatch,
    fitInlineIconBudget,
    mcpServerSiteOrigins,
    selectMcpServerIcons,
} from '../chat-mcp-servers';
import { claudeMcpServerReport } from '../providers/claude/mcp-servers';
import { codexMcpServerReport } from '../providers/codex/mcp-servers';

const EXA_ICON = 'https://exa.ai/images/favicon-32x32.png';

const toolCall = (name: string, id = name): AgentChatPatchOperation => ({
    op: 'upsertItem',
    item: { type: 'toolCall', id, name, status: 'completed' },
});

function watchFixture(lookup: (name: string) => Promise<McpServerReport | undefined>) {
    let snapshot: AgentChatSnapshot = emptyAgentChatSnapshot('terminal-1');
    const timers: Array<() => void> = [];
    const apply = (operations: AgentChatPatchOperation[]) => {
        for (const operation of operations) snapshot = applyAgentChatOperation(snapshot, operation);
    };
    const watch = createChatMcpServerWatch({
        read: () => snapshot,
        apply,
        lookup: () => lookup,
        schedule: (run) => timers.push(run),
    });
    return {
        observe: (...operations: AgentChatPatchOperation[]) => {
            apply(operations);
            watch.observe(operations);
        },
        servers: () => snapshot.mcpServers,
        /**
         * Fires every retry scheduled so far, standing in for the retry delay elapsing.
         */
        elapse: () => {
            const due = [...timers];
            timers.length = 0;
            for (const run of due) run();
        },
    };
}

describe('selectMcpServerIcons', () => {
    it('keeps the best icon per theme for a small glyph', () => {
        expect(
            selectMcpServerIcons([
                { src: 'https://a.example/512.png', sizes: ['512x512'] },
                { src: 'https://a.example/32.png', sizes: ['32x32'] },
                { src: 'https://a.example/16.png', sizes: ['16x16'] },
                { src: 'https://a.example/dark.svg', mimeType: 'image/svg+xml', theme: 'dark' },
            ]),
        ).toEqual([
            { src: 'https://a.example/32.png' },
            { src: 'https://a.example/dark.svg', theme: 'dark' },
        ]);
    });

    it('drops sources a Client must not load', () => {
        expect(
            selectMcpServerIcons([
                // eslint-disable-next-line unicorn/prefer-https -- a plain-HTTP icon is the case under test
                { src: 'http://a.example/icon.png' },
                { src: 'file:///etc/icon.png' },
                { src: 'https://user:secret@a.example/icon.png' },
                { src: 'javascript:alert(1)' },
                { src: `data:image/png;base64,${'A'.repeat(30 * 1024)}` },
                'not an icon',
            ]),
        ).toEqual([]);
        expect(selectMcpServerIcons([{ src: 'data:image/png;base64,AQID' }])).toEqual([
            { src: 'data:image/png;base64,AQID' },
        ]);
    });
});

describe('mcpServerSiteOrigins', () => {
    it('falls back from the website to the endpoint and its parent domain', () => {
        expect(mcpServerSiteOrigins('https://exa.ai/docs', 'https://mcp.exa.ai/mcp')).toEqual([
            'https://exa.ai',
            'https://mcp.exa.ai',
        ]);
        expect(mcpServerSiteOrigins(undefined, 'https://mcp.linear.app/sse')).toEqual([
            'https://mcp.linear.app',
            'https://linear.app',
        ]);
    });

    it('offers no plain-HTTP site, and no parent domain for an IP or ported endpoint', () => {
        // eslint-disable-next-line unicorn/prefer-https -- a plain-HTTP website is the case under test
        expect(mcpServerSiteOrigins('http://a.example', 'https://203.0.113.7/mcp')).toEqual([
            'https://203.0.113.7',
        ]);
        expect(mcpServerSiteOrigins(undefined, 'https://mcp.a.example:8443/mcp')).toEqual([
            'https://mcp.a.example:8443',
        ]);
    });

    it("does not take a hosting platform's or public suffix's icon for a server hosted under it", () => {
        expect(mcpServerSiteOrigins(undefined, 'https://tool.example.vercel.app/mcp')).toEqual([
            'https://tool.example.vercel.app',
        ]);
        expect(mcpServerSiteOrigins(undefined, 'https://tools.example.co.uk/mcp')).toEqual([
            'https://tools.example.co.uk',
        ]);
    });
});

describe('inline icon budget', () => {
    const inline = (seed: number) => ({
        src: `data:image/png;base64,${'A'.repeat(24 * 1024 - 30 - seed)}`,
    });

    it('keeps the serialized mcpServers within the budget however many large inline icons arrive', async () => {
        const lookup = (name: string) =>
            Promise.resolve<McpServerReport>({
                icons: [
                    { ...inline(0), sizes: ['any'] },
                    { ...inline(1), theme: 'light' },
                    { ...inline(2), theme: 'dark' },
                ],
                endpointUrl: `https://mcp.${name}.example/mcp`,
                isConnected: true,
            });
        const fixture = watchFixture(lookup);
        for (let index = 0; index < 50; index += 1)
            fixture.observe(toolCall(`mcp__server${index}__tool`, `call-${index}`));
        await vi.waitFor(() => expect(fixture.servers()).toHaveLength(20));

        const servers = fixture.servers() ?? [];
        // 64 KiB of inline icons plus names and site origins for the 20 servers.
        expect(JSON.stringify(servers).length).toBeLessThanOrEqual(80 * 1024);
        // A server without room for an inline icon still has its site origins to fall back to.
        expect(servers.at(-1)?.icons).toBeUndefined();
        expect(servers.at(-1)?.siteOrigins?.length).toBeGreaterThan(0);
    });

    it('drops only the inline icons that do not fit and keeps HTTPS icons in order', () => {
        const server = (name: string, icons: Array<{ src: string }>) => ({ name, icons });
        const fitted = fitInlineIconBudget([
            server('a', [inline(0), inline(1)]),
            server('b', [{ src: EXA_ICON }, inline(2)]),
            server('c', [inline(3)]),
        ]);

        // 24 KiB each: two fit in the first server, the third (server b) and fourth (server c) do not fit.
        expect(fitted[0]?.icons).toHaveLength(2);
        expect(fitted[1]?.icons).toEqual([{ src: EXA_ICON }]);
        expect(fitted[2]).toEqual({ name: 'c' });
    });

    it('drops an HTTPS icon URL that is implausibly long', () => {
        expect(
            selectMcpServerIcons([{ src: `https://a.example/${'x'.repeat(3_000)}.png` }]),
        ).toEqual([]);
    });
});

describe('createChatMcpServerWatch', () => {
    it('looks a server up once and publishes its title and icon', async () => {
        const lookup = vi.fn(() =>
            Promise.resolve<McpServerReport>({
                title: 'Exa',
                icons: [{ src: EXA_ICON, sizes: ['32x32'] }],
                endpointUrl: 'https://mcp.exa.ai/mcp',
                isConnected: true,
            }),
        );
        const fixture = watchFixture(lookup);
        fixture.observe(toolCall('mcp__exa__web_search_exa', 'a'), toolCall('Read', 'b'));
        fixture.observe(toolCall('mcp__exa__web_fetch_exa', 'c'));
        await vi.waitFor(() => expect(fixture.servers()).toHaveLength(1));
        fixture.observe(toolCall('mcp__exa__web_fetch_exa', 'd'));
        expect(lookup).toHaveBeenCalledOnce();
        expect(lookup).toHaveBeenCalledWith('exa');
        expect(fixture.servers()).toEqual([
            {
                name: 'exa',
                title: 'Exa',
                icons: [{ src: EXA_ICON }],
                siteOrigins: ['https://mcp.exa.ai', 'https://exa.ai'],
            },
        ]);
    });

    it('asks again after a delay while the server was still connecting, with no further call', async () => {
        const lookup = vi
            .fn<(name: string) => Promise<McpServerReport | undefined>>()
            .mockResolvedValueOnce({ isConnected: false })
            .mockResolvedValueOnce({ icons: [{ src: EXA_ICON }], isConnected: true });
        const fixture = watchFixture(lookup);
        // A resumed Chat replays an old call while the server is still connecting.
        fixture.observe(toolCall('exa/web_search_exa', 'a'));
        await vi.waitFor(() => expect(fixture.servers()).toEqual([{ name: 'exa' }]));
        fixture.observe(toolCall('exa/web_search_exa', 'b'));
        expect(lookup).toHaveBeenCalledOnce();
        fixture.elapse();
        await vi.waitFor(() =>
            expect(fixture.servers()).toEqual([{ name: 'exa', icons: [{ src: EXA_ICON }] }]),
        );
        expect(lookup).toHaveBeenCalledTimes(2);
        fixture.elapse();
        expect(lookup).toHaveBeenCalledTimes(2);
    });

    it('stops retrying a server that never connects', async () => {
        const lookup = vi.fn(() => Promise.resolve<McpServerReport>({ isConnected: false }));
        const fixture = watchFixture(lookup);
        fixture.observe(toolCall('exa/web_search_exa'));
        const settle = async (attempts: number) => {
            await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(attempts));
            await Promise.resolve();
        };
        await settle(1);
        fixture.elapse();
        await settle(2);
        fixture.elapse();
        await settle(3);
        fixture.elapse();
        fixture.observe(toolCall('exa/web_search_exa', 'later'));
        await Promise.resolve();
        expect(lookup).toHaveBeenCalledTimes(3);
    });

    it('survives a failed lookup', async () => {
        const lookup = vi.fn(() => Promise.reject(new Error('timed out')));
        const fixture = watchFixture(lookup);
        fixture.observe(toolCall('exa/web_search_exa'));
        await vi.waitFor(() => expect(lookup).toHaveBeenCalledOnce());
        expect(fixture.servers()).toBeUndefined();
    });
});

describe('provider reports', () => {
    it('matches a Claude tool server name against the configured name', () => {
        const statuses = [
            {
                name: 'claude.ai Exa',
                status: 'connected',
                serverInfo: { name: 'exa', version: '1', title: 'Exa', icons: [{ src: EXA_ICON }] },
                config: { type: 'claudeai-proxy', url: 'https://proxy.example/x', id: 'x' },
            },
            {
                name: 'linear',
                status: 'pending',
                config: { type: 'http', url: 'https://mcp.linear.app/mcp' },
            },
        ] as McpServerStatus[];
        expect(
            agentChatMcpServer('claude_ai_Exa', claudeMcpServerReport(statuses, 'claude_ai_Exa')!),
        ).toEqual({ name: 'claude_ai_Exa', title: 'Exa', icons: [{ src: EXA_ICON }] });
        expect(claudeMcpServerReport(statuses, 'linear')).toEqual({
            endpointUrl: 'https://mcp.linear.app/mcp',
            isConnected: false,
        });
        expect(claudeMcpServerReport(statuses, 'missing')).toBeUndefined();
    });

    it('reads a Codex status answer', () => {
        const result = {
            data: [
                {
                    name: 'exa',
                    runtimeStatus: 'connected',
                    httpOrigin: 'https://mcp.exa.ai',
                    serverInfo: {
                        name: 'exa-search-server',
                        title: 'Exa',
                        version: '3.4.2',
                        websiteUrl: 'https://exa.ai',
                        icons: [{ src: EXA_ICON, mimeType: 'image/png', sizes: ['32x32'] }],
                    },
                },
            ],
            nextCursor: null,
        };
        expect(agentChatMcpServer('exa', codexMcpServerReport(result, 'exa')!)).toEqual({
            name: 'exa',
            title: 'Exa',
            icons: [{ src: EXA_ICON }],
            siteOrigins: ['https://exa.ai', 'https://mcp.exa.ai'],
        });
        expect(codexMcpServerReport({ data: [] }, 'exa')).toBeUndefined();
    });
});
