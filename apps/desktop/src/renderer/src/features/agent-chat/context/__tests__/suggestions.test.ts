import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import { analyzeContextCache } from '../cache-analysis';
import {
    cacheBreakReason,
    contextChangeText,
    contextSuggestions,
    fileName,
    rewriteCost,
} from '../suggestions';
import { composition, MINUTE, request } from './fixtures';

const noCache = analyzeContextCache([], [], 5);

describe('contextSuggestions', () => {
    it('flags heavy MCP servers and large memory files', () => {
        expect(
            contextSuggestions(translate, composition(), noCache).map((item) => item.id),
        ).toEqual(['mcp:github', 'memory:/repo/AGENTS.md']);
    });

    it('leads with cache misses from a changed prefix, then a nearly full window', () => {
        const analysis = analyzeContextCache(
            [
                request(0, { cacheWrite: 50_000 }),
                request(MINUTE, { cacheRead: 12_000, cacheWrite: 38_000 }),
            ],
            [],
            5,
        );
        const suggestions = contextSuggestions(
            translate,
            composition({ totalTokens: 150_000, mcpTools: [], memoryFiles: [] }),
            analysis,
        );
        expect(suggestions.map((item) => item.id)).toEqual(['prefix-misses', 'context-high']);
        expect(suggestions[0].text).toContain('38k');
    });

    it('points at the tool whose results dominate the conversation and at truncated skills', () => {
        const suggestions = contextSuggestions(
            translate,
            composition({
                mcpTools: [],
                memoryFiles: [],
                skills: { total: 40, included: 30, tokens: 3_000, items: [] },
                messages: {
                    toolCalls: 2_000,
                    toolResults: 40_000,
                    attachments: 0,
                    assistant: 4_000,
                    user: 2_000,
                    other: 0,
                    tools: [
                        { name: 'Edit', callTokens: 9_000, resultTokens: 1_000 },
                        { name: 'Read', callTokens: 500, resultTokens: 30_000 },
                    ],
                    attachmentKinds: [],
                },
            }),
            noCache,
        );
        expect(suggestions.map((item) => item.id)).toEqual(['tool-results', 'skills-truncated']);
        expect(suggestions[0].text).toContain('Read');
    });

    it('says nothing without a composition or a miss', () => {
        expect(contextSuggestions(translate, undefined, noCache)).toEqual([]);
    });
});

describe('cache break wording', () => {
    it('names the likely change behind a prefix break', () => {
        const [item] = analyzeContextCache(
            [
                request(0, { cacheWrite: 50_000 }),
                request(MINUTE, { cacheRead: 12_000, cacheWrite: 38_000 }),
            ],
            [{ at: MINUTE, kind: 'mcpToolsAdded', names: ['a', 'b', 'c', 'd'], tokenDelta: 4_200 }],
            5,
        ).breaks;
        expect(cacheBreakReason(translate, item)).toBe(
            'Likely cause: MCP tools added (a, b, c and 1 more) +4.2k.',
        );
    });

    it('describes a change without names by its token delta', () => {
        expect(
            contextChangeText(translate, {
                at: 0,
                kind: 'systemPromptChanged',
                names: [],
                tokenDelta: -300,
            }),
        ).toBe('system prompt changed −300');
    });

    it('formats rewrite costs and file names', () => {
        expect(rewriteCost(undefined)).toBeUndefined();
        expect(rewriteCost(0)).toBeUndefined();
        expect(rewriteCost(0.123)).toMatch(/^~\$/);
        expect(fileName('/repo/docs/AGENTS.md')).toBe('AGENTS.md');
        expect(fileName('plain')).toBe('plain');
    });
});
