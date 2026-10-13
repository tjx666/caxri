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

type Surface = 'browserUse' | 'computerUse';

/**
 * A step reports the surface it drove in `_meta` (`codex/toolSurface.kind` is `browserUse` for the Chrome extension).
 * Returns `undefined` when the step carries no surface, which is every step still running.
 */
function reportedSurface(meta: Json | undefined): Surface | undefined {
    if (!meta) return undefined;
    const surface = meta['codex/toolSurface'];
    if (meta['codex/browserUse'] === true || (isRecord(surface) && surface.kind === 'browserUse'))
        return 'browserUse';
    return isRecord(surface) ? 'computerUse' : undefined;
}

/**
 * Calls only the browser API has: opening or binding a tab, the extension's browser session, and tab-only navigation.
 * Checked against real Codex transcripts, where `cua.getState()` alone reported either surface, so it is not a signal.
 */
const BROWSER_CALL =
    /\bcua\.(?:createBrowserTab|getTab|listTabs|getBrowser)\s*\(|\bagent\.browsers\b|\bbrowser\.user\b|\.playwright\b|\.(?:goto|reload)\s*\(/u;
const DESKTOP_CALL = /\bcua\.(?:getApp|listApps)\s*\(|\bcua\.computer\b/u;
const BROWSER_BINDING =
    /([A-Za-z_$][\w$]*)\s*=\s*await\s+(?:cua\.(?:getTab|createBrowserTab|getBrowser)|agent\.browsers\.get)\s*\(/gu;
const DESKTOP_BINDING = /([A-Za-z_$][\w$]*)\s*=\s*await\s+cua\.getApp\s*\(/gu;
const MEMBER_ACCESS = /([A-Za-z_$][\w$]*)\s*\./gu;
const MAX_BINDINGS = 200;

/**
 * The surface a script names through the API it calls, browser first because a script that binds a tab and an app in
 * one step reported the browser in recorded transcripts.
 */
function expectedSurface(code: string): Surface | undefined {
    if (BROWSER_CALL.test(code)) return 'browserUse';
    if (DESKTOP_CALL.test(code)) return 'computerUse';
    return undefined;
}

/**
 * Variables a Chat's Computer Use steps bound to a browser tab or a desktop app. The `cua_repl` REPL keeps variables
 * across calls, so a step such as `await routerTab.click(12)` names no API at all; remembering that `routerTab` came
 * from `cua.getTab` lets a running step show the globe it settles with instead of switching icons once its result
 * arrives (#1945). Bindings live as long as the Chat session; a resumed Chat starts without them.
 */
export class CodexComputerUseBindings {
    private readonly surfaces = new Map<string, Surface>();

    private bind(code: string, pattern: RegExp, surface: Surface): void {
        for (const [, name] of code.matchAll(pattern)) {
            if (!name) continue;
            this.surfaces.delete(name);
            this.surfaces.set(name, surface);
            if (this.surfaces.size > MAX_BINDINGS) {
                const oldest = this.surfaces.keys().next().value;
                if (oldest !== undefined) this.surfaces.delete(oldest);
            }
        }
    }

    private surfaceOf(code: string): Surface | undefined {
        const direct = expectedSurface(code);
        if (direct) return direct;
        for (const [, name] of code.matchAll(MEMBER_ACCESS)) {
            const surface = name && this.surfaces.get(name);
            if (surface) return surface;
        }
        return undefined;
    }

    /**
     * Records the variables the script binds, then names the surface it is expected to drive.
     */
    observe(code: string): Surface | undefined {
        this.bind(code, BROWSER_BINDING, 'browserUse');
        this.bind(code, DESKTOP_BINDING, 'computerUse');
        return this.surfaceOf(code);
    }
}

/**
 * The Chat fields of a Computer Use step, or `undefined` for any other MCP call. `name` is `browserUse` or
 * `computerUse`, which the shared tool table in `@caxri/protocol` titles by `summary`, the step's `title`; `input` is
 * the script the expanded row shows. The surface Codex reported decides a settled step; until then the script's own
 * browser or desktop calls (and the variables `bindings` saw earlier steps bind) decide it, so the icon does not change
 * when the result arrives. A script that names neither keeps the Computer Use default.
 */
export function codexComputerUseCall(
    item: Json,
    bindings?: CodexComputerUseBindings,
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
    const expected = bindings ? bindings.observe(code) : expectedSurface(code);
    return {
        name: reportedSurface(result?.meta) ?? expected ?? 'computerUse',
        ...(title && { summary: clip(title, 1_000) }),
        ...(code && { input: clip(code, 1_000) }),
        ...(output && { output: tail(output, MAX_AGENT_CHAT_OUTPUT_LENGTH) }),
    };
}
