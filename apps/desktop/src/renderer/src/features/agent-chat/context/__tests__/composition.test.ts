import { describe, expect, it } from 'vitest';

import {
    autoCompactAt,
    contextTileFigures,
    contextWindowSegments,
    inRequestOrder,
    mcpServerUsage,
    messageTokens,
    messageToolUsage,
    promptSegmentAt,
} from '../composition';
import { composition } from './fixtures';

describe('context composition', () => {
    it('orders rows as the request sends them, closing with the free space and the reserve', () => {
        expect(
            inRequestOrder([
                { label: 'Messages' },
                { label: 'Free space', kind: 'free' as const },
                { label: 'Autocompact buffer' },
                { label: 'Something new' },
                { label: 'System tools' },
            ]).map((row) => row.label),
        ).toEqual([
            'System tools',
            'Something new',
            'Messages',
            'Free space',
            'Autocompact buffer',
        ]);
    });

    it('lays segments end to end and leaves deferred schemas out of the window', () => {
        const segments = contextWindowSegments(composition());
        expect(segments.map((segment) => [segment.label, segment.offset])).toEqual([
            ['System tools', 0],
            ['MCP tools', 12_000],
            ['System prompt', 27_000],
            ['Messages', 30_000],
            ['Free space', 60_000],
            ['Autocompact buffer', 167_000],
        ]);
    });

    it('names the part of the prompt where a kept prefix ends', () => {
        const segments = contextWindowSegments(composition());
        expect(promptSegmentAt(segments, 13_500)).toEqual({ label: 'MCP tools', progress: 0.1 });
        expect(promptSegmentAt(segments, 90_000)).toEqual({ label: 'Messages', progress: 1 });
        expect(promptSegmentAt([], 10)).toBeUndefined();
    });

    it('groups MCP tools by server, heaviest in-window server first, without the name prefix', () => {
        const servers = mcpServerUsage(composition());
        expect(
            servers.map((server) => [server.server, server.tokens, server.deferredTokens]),
        ).toEqual([
            ['github', 11_000, 0],
            ['linear', 4_000, 0],
            ['docs', 0, 9_000],
        ]);
        expect(servers[0].tools.map((tool) => tool.name)).toEqual(['create_pr', 'search']);
        expect(servers[2].loadedCount).toBe(0);
    });

    it('sums the conversation and ranks its tools', () => {
        const messages = {
            toolCalls: 1_000,
            toolResults: 20_000,
            attachments: 0,
            assistant: 5_000,
            user: 3_000,
            other: 1_000,
            tools: [
                { name: 'Read', callTokens: 400, resultTokens: 15_000 },
                { name: 'Bash', callTokens: 600, resultTokens: 5_000 },
                { name: 'Idle', callTokens: 0, resultTokens: 0 },
            ],
            attachmentKinds: [],
        };
        expect(messageTokens(messages)).toBe(30_000);
        expect(messageTokens(undefined)).toBe(0);
        expect(messageToolUsage(composition({ messages })).map((tool) => tool.name)).toEqual([
            'Read',
            'Bash',
        ]);
    });
});

describe('autoCompactAt', () => {
    it('names the threshold, falls back to the window, and is absent while auto-compact is off', () => {
        expect(autoCompactAt(composition())).toBe(167_000);
        expect(autoCompactAt(composition({ autoCompactThreshold: undefined }))).toBe(200_000);
        expect(autoCompactAt(composition({ isAutoCompactEnabled: false }))).toBeUndefined();
    });

    it('measures the Context tile against the auto-compact threshold, falling back to the window', () => {
        expect(contextTileFigures(composition(), undefined)).toEqual({
            value: '60k / 167k',
            percent: 36,
            threshold: 167_000,
        });
        expect(contextTileFigures(composition({ isAutoCompactEnabled: false }), undefined)).toEqual(
            { value: '60k / 200k', percent: 30 },
        );
        expect(
            contextTileFigures(undefined, {
                totalTokens: 50_000,
                compactWindow: 200_000,
                autoCompactThreshold: 100_000,
            }),
        ).toEqual({ value: '50k / 100k', percent: 50, threshold: 100_000 });
        expect(contextTileFigures(undefined, undefined)).toEqual({});
    });
});
