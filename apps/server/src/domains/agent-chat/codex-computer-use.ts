import { MAX_AGENT_CHAT_OUTPUT_LENGTH } from '@caxri/protocol';

import { clip, isRecord, tail } from './chat-items';

/**
 * Codex's bundled Computer Use plugin drives Chrome and desktop apps through one MCP tool, `cua_repl/js`. Its arguments
 * carry the script (`code`) and a short `title` the model writes for the step, such as `Open the router settings`. The
 * Codex app titles each step by that `title` and marks a browser step with a globe, so the raw `cua_repl js` name and
 * JSON arguments never reach the reader; the Chat does the same by naming the call after the surface it drove.
 */
const COMPUTER_USE_SERVER = 'cua_repl';
const COMPUTER_USE_TOOL = 'js';

type Json = Record<string, unknown>;

interface McpContent {
    content: unknown[];
    meta: Json | undefined;
}

/**
 * The result's content and `_meta`. Some steps return the whole MCP result again as the only text part (the Codex app
 * then shows that JSON as plain text), so a text part that is itself a result is read through once.
 */
function mcpContent(result: unknown): McpContent | undefined {
    if (!isRecord(result) || !Array.isArray(result.content)) return undefined;
    const content: unknown[] = result.content;
    const outer = { content, meta: isRecord(result._meta) ? result._meta : undefined };
    const only = content.at(0);
    if (content.length !== 1 || !isRecord(only) || typeof only.text !== 'string') return outer;
    if (!only.text.startsWith('{')) return outer;
    try {
        const inner: unknown = JSON.parse(only.text);
        if (isRecord(inner) && Array.isArray(inner.content))
            return {
                content: inner.content,
                meta: isRecord(inner._meta) ? inner._meta : outer.meta,
            };
    } catch {
        // Not a nested result: the text is the step's own output.
    }
    return outer;
}

/**
 * A step reports the surface it drove in `_meta` (`codex/toolSurface.kind` is `browserUse` for the Chrome extension). A
 * step still running has no result yet and reads as Computer Use until it settles.
 */
function isBrowserStep(meta: Json | undefined): boolean {
    if (!meta) return false;
    const surface = meta['codex/toolSurface'];
    return (
        meta['codex/browserUse'] === true || (isRecord(surface) && surface.kind === 'browserUse')
    );
}

/**
 * The Chat fields of a Computer Use step, or `undefined` for any other MCP call. `name` is `browserUse` or
 * `computerUse`, which the shared tool table in `@caxri/protocol` titles by `summary`, the step's `title`; `input` is
 * the script the expanded row shows.
 */
export function codexComputerUseCall(
    item: Json,
): { name: string; summary?: string; input?: string; output?: string } | undefined {
    if (item.server !== COMPUTER_USE_SERVER || item.tool !== COMPUTER_USE_TOOL) return undefined;
    const arguments_ = isRecord(item.arguments) ? item.arguments : {};
    const title = typeof arguments_.title === 'string' ? arguments_.title.trim() : '';
    const code = typeof arguments_.code === 'string' ? arguments_.code : '';
    const result = mcpContent(item.result);
    const parts = (result?.content ?? []).flatMap((part) =>
        isRecord(part) && typeof part.text === 'string' ? [part.text] : [],
    );
    const errorMessage =
        isRecord(item.error) && typeof item.error.message === 'string' ? item.error.message : '';
    const output = errorMessage || parts.join('\n');
    return {
        name: isBrowserStep(result?.meta) ? 'browserUse' : 'computerUse',
        ...(title && { summary: clip(title, 1_000) }),
        ...(code && { input: clip(code, 1_000) }),
        ...(output && { output: tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH) }),
    };
}
