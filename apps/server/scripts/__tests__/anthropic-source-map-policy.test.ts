import { describe, expect, it } from 'vitest';

import { anthropicSourceMapPolicy, scrubAnthropicSourceMap } from '../anthropic-source-map-policy';

interface AssetOutput {
    fileName: string;
    source: string | Uint8Array;
    type: 'asset';
}

interface ChunkOutput {
    code: string;
    fileName: string;
    type: 'chunk';
}

type PolicyBundle = Record<string, AssetOutput | ChunkOutput>;

function sourceMap(
    sources: string[],
    sourcesContent?: Array<null | string>,
): Record<string, unknown> {
    return {
        mappings: 'AAAA',
        names: ['example'],
        sources,
        ...(sourcesContent !== undefined && { sourcesContent }),
        version: 3,
    };
}

function scrub(document: Record<string, unknown>): Record<string, unknown> {
    return JSON.parse(
        scrubAnthropicSourceMap('server-core.js.map', JSON.stringify(document)) as string,
    ) as Record<string, unknown>;
}

describe('Anthropic source map policy', () => {
    it('clears only Anthropic SDK source content and preserves mapping metadata', () => {
        expect(
            scrub(
                sourceMap(
                    [
                        '../../src/core/bootstrap.ts',
                        '../../node_modules/@anthropic-ai/claude-agent-sdk/core.mjs',
                        '../../node_modules/@anthropic-ai/sdk/index.mjs',
                        '../../node_modules/example/index.js',
                    ],
                    [
                        'caxri source',
                        'Claude Agent SDK source',
                        'Anthropic API SDK source',
                        'licensed dependency source',
                    ],
                ),
            ),
        ).toEqual({
            mappings: 'AAAA',
            names: ['example'],
            sources: [
                '../../src/core/bootstrap.ts',
                '../../node_modules/@anthropic-ai/claude-agent-sdk/core.mjs',
                '../../node_modules/@anthropic-ai/sdk/index.mjs',
                '../../node_modules/example/index.js',
            ],
            sourcesContent: [
                'caxri source',
                null,
                'Anthropic API SDK source',
                'licensed dependency source',
            ],
            version: 3,
        });
    });

    it.each([
        '@anthropic-ai/claude-agent-sdk/sdk.mjs',
        '@anthropic-ai/claude-agent-sdk/core.mjs',
        '@anthropic-ai/claude-agent-sdk/core-BuY1d3.mjs',
        '@anthropic-ai/claude-agent-sdk/chunks/runtime.mjs',
        '../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.296/node_modules/@anthropic-ai/claude-agent-sdk/core.mjs',
        '../../node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.3.296/core-BuY1d3.mjs',
        String.raw`C:\workspace\node_modules\@anthropic-ai\claude-agent-sdk\chunks\runtime.mjs`,
    ])('matches the SDK path variant %s', (sdkPath) => {
        expect(scrub(sourceMap([sdkPath], ['anthropic source'])).sourcesContent).toEqual([null]);
    });

    it('leaves a map byte-for-byte unchanged when it has no matching source', () => {
        const encoded = JSON.stringify(
            sourceMap(
                [
                    '../../src/core/bootstrap.ts',
                    '@anthropic-ai/sdk/index.mjs',
                    '@anthropic-ai/claude-agent-sdk-extra/sdk.mjs',
                ],
                ['caxri source', 'different Anthropic package source', 'different package source'],
            ),
            null,
            2,
        );

        expect(scrubAnthropicSourceMap('server-core.js.map', encoded)).toBe(encoded);
    });

    it('accepts an already-cleared matching source without rewriting the map', () => {
        const encoded = JSON.stringify(
            sourceMap(['@anthropic-ai/claude-agent-sdk/sdk.mjs'], [null]),
            null,
            2,
        );

        expect(scrubAnthropicSourceMap('server-core.js.map', encoded)).toBe(encoded);
    });

    it('fails closed when a matching source has no sourcesContent to inspect', () => {
        expect(() =>
            scrubAnthropicSourceMap(
                'server-core.js.map',
                JSON.stringify(sourceMap(['@anthropic-ai/claude-agent-sdk/sdk.mjs'])),
            ),
        ).toThrow(
            'server-core.js.map: Anthropic SDK sources exist without sourcesContent to inspect; refusing to emit a potentially unsafe source map',
        );
    });

    it('fails closed when sources and sourcesContent have different lengths', () => {
        expect(() =>
            scrubAnthropicSourceMap(
                'server-core.js.map',
                JSON.stringify(sourceMap(['one.ts', 'two.ts'], ['one source'])),
            ),
        ).toThrow(
            'server-core.js.map: source map sourcesContent must align one-to-one with sources; refusing to emit a potentially unsafe source map',
        );
    });

    it('fails closed on malformed JSON', () => {
        expect(() => scrubAnthropicSourceMap('server-core.js.map', '{invalid')).toThrow(
            'server-core.js.map: source map is not valid JSON; refusing to emit a potentially unsafe source map',
        );
    });

    it('processes emitted map assets without modifying JavaScript assets', () => {
        const map = JSON.stringify(
            sourceMap(['@anthropic-ai/claude-agent-sdk/sdk.mjs'], ['anthropic source']),
        );
        const bundle: PolicyBundle = {
            'server-core.js': {
                code: 'console.log("unchanged")',
                fileName: 'server-core.js',
                type: 'chunk',
            },
            'server-core.js.map': {
                fileName: 'server-core.js.map',
                source: map,
                type: 'asset',
            },
        };
        const hook = anthropicSourceMapPolicy({ required: true }).generateBundle as (
            options: unknown,
            output: PolicyBundle,
        ) => void;

        hook({}, bundle);

        expect(bundle['server-core.js']).toMatchObject({ code: 'console.log("unchanged")' });
        const mapOutput = bundle['server-core.js.map'];
        if (mapOutput.type !== 'asset' || typeof mapOutput.source !== 'string') {
            throw new TypeError('expected a string source map asset');
        }
        const parsed = JSON.parse(mapOutput.source) as unknown;
        expect(parsed).toMatchObject({ sourcesContent: [null] });
    });

    it('fails an include build when no Anthropic SDK source path is found', () => {
        const bundle: PolicyBundle = {
            'server-core.js.map': {
                fileName: 'server-core.js.map',
                source: JSON.stringify(
                    sourceMap(['../../src/core/bootstrap.ts'], ['caxri source']),
                ),
                type: 'asset',
            },
        };
        const hook = anthropicSourceMapPolicy({ required: true }).generateBundle as (
            options: unknown,
            output: PolicyBundle,
        ) => void;

        expect(() => hook({}, bundle)).toThrow(
            'Server build: no Anthropic Agent SDK source was found in emitted source maps; refusing to emit a potentially unsafe source map',
        );
    });

    it('allows an omit build with no emitted source maps', () => {
        const bundle: PolicyBundle = {
            'server-core.js': {
                code: 'console.log("unchanged")',
                fileName: 'server-core.js',
                type: 'chunk',
            },
        };
        const hook = anthropicSourceMapPolicy({ required: false }).generateBundle as (
            options: unknown,
            output: PolicyBundle,
        ) => void;

        expect(() => hook({}, bundle)).not.toThrow();
    });
});
