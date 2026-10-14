import { Buffer } from 'node:buffer';

import type { Plugin } from 'vite';

interface SourceMapDocument {
    sources: string[];
    sourcesContent?: Array<null | string>;
    [key: string]: unknown;
}

interface ScrubResult {
    matchingSourceCount: number;
    source: string | Uint8Array;
}

export interface AnthropicSourceMapPolicyOptions {
    /**
     * Require at least one Agent SDK source to be found across emitted maps. Include builds set this so a dependency or
     * bundler path-format change cannot silently restore complete SDK source content.
     */
    required: boolean;
}

const ANTHROPIC_SDK_PATH =
    /(?:^|\/)(?:@anthropic-ai\/claude-agent-sdk|\.pnpm\/@anthropic-ai\+claude-agent-sdk@[^/]+)(?:\/|$)/;

function failSourceMap(fileName: string, reason: string): never {
    throw new Error(`${fileName}: ${reason}; refusing to emit a potentially unsafe source map`);
}

function parseSourceMap(fileName: string, source: string | Uint8Array): SourceMapDocument {
    let parsed: unknown;
    try {
        parsed = JSON.parse(typeof source === 'string' ? source : Buffer.from(source).toString());
    } catch {
        failSourceMap(fileName, 'source map is not valid JSON');
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        failSourceMap(fileName, 'source map must be a JSON object');
    }

    const document = parsed as Record<string, unknown>;
    if (
        !Array.isArray(document.sources) ||
        document.sources.some((item) => typeof item !== 'string')
    ) {
        failSourceMap(fileName, 'source map sources must be an array of strings');
    }
    if (
        document.sourcesContent !== undefined &&
        (!Array.isArray(document.sourcesContent) ||
            document.sourcesContent.length !== document.sources.length)
    ) {
        failSourceMap(fileName, 'source map sourcesContent must align one-to-one with sources');
    }

    return document as unknown as SourceMapDocument;
}

function isAnthropicSdkSource(source: string): boolean {
    return ANTHROPIC_SDK_PATH.test(source.replaceAll('\\', '/'));
}

/**
 * Anthropic's published SDK materials allow using and bundling the SDK in a product, but do not clearly grant the right
 * to republish its complete source verbatim through a public source map. Until legal review confirms that
 * redistribution right, retain the source paths and mapping metadata while removing only the SDK's `sourcesContent`.
 */
function scrubAnthropicSourceMapWithResult(
    fileName: string,
    source: string | Uint8Array,
): ScrubResult {
    const document = parseSourceMap(fileName, source);
    const matchingIndexes = document.sources.flatMap((item, index) =>
        isAnthropicSdkSource(item) ? [index] : [],
    );
    if (matchingIndexes.length === 0) return { matchingSourceCount: 0, source };
    if (document.sourcesContent === undefined) {
        failSourceMap(fileName, 'Anthropic SDK sources exist without sourcesContent to inspect');
    }

    let isChanged = false;
    for (const index of matchingIndexes) {
        const content = document.sourcesContent[index];
        if (content === null) continue;
        if (typeof content !== 'string') {
            failSourceMap(
                fileName,
                `Anthropic SDK source at index ${index} has invalid sourcesContent`,
            );
        }
        document.sourcesContent[index] = null;
        isChanged = true;
    }
    return {
        matchingSourceCount: matchingIndexes.length,
        source: isChanged ? JSON.stringify(document) : source,
    };
}

export function scrubAnthropicSourceMap(
    fileName: string,
    source: string | Uint8Array,
): string | Uint8Array {
    return scrubAnthropicSourceMapWithResult(fileName, source).source;
}

/**
 * Applies the public Source Map redistribution policy to every emitted Server map without modifying JavaScript.
 */
export function anthropicSourceMapPolicy(options: AnthropicSourceMapPolicyOptions): Plugin {
    return {
        name: 'caxri-anthropic-source-map-policy',
        generateBundle(_options, bundle) {
            let matchingSourceCount = 0;
            for (const output of Object.values(bundle)) {
                if (output.type !== 'asset' || !output.fileName.endsWith('.map')) continue;
                const result = scrubAnthropicSourceMapWithResult(output.fileName, output.source);
                matchingSourceCount += result.matchingSourceCount;
                output.source = result.source;
            }
            if (matchingSourceCount === 0 && options.required)
                failSourceMap(
                    'Server build',
                    'no Anthropic Agent SDK source was found in emitted source maps',
                );
        },
    };
}
