import type {
    AgentChatMcpIcon,
    AgentChatMcpServer,
    AgentChatPatchOperation,
    AgentChatSnapshot,
} from '@caxri/protocol';
import {
    MAX_AGENT_CHAT_MCP_HTTPS_ICON_LENGTH,
    MAX_AGENT_CHAT_MCP_ICON_SRC_LENGTH,
    MAX_AGENT_CHAT_MCP_INLINE_ICON_CHARS,
    MAX_AGENT_CHAT_MCP_SERVERS,
    parseAgentMcpToolName,
} from '@caxri/protocol';

import { clip } from './chat-items';

/**
 * What a provider reports about one MCP server, before Server Core narrows it to what a Chat shows. Fields come from
 * the provider's own status read and are untrusted: each is validated here.
 */
export interface McpServerReport {
    /**
     * The `serverInfo.title` the server sent in its MCP `initialize` result.
     */
    title?: unknown;
    /**
     * The `serverInfo.icons` the server sent (MCP 2025-11-25): `{ src, mimeType?, sizes?, theme? }` entries.
     */
    icons?: unknown;
    websiteUrl?: unknown;
    /**
     * The configured endpoint URL or origin for an HTTP server; absent for a stdio server.
     */
    endpointUrl?: unknown;
    /**
     * False while the provider has not finished connecting the server, so its `serverInfo` may still be missing; the
     * server is looked up again later.
     */
    isConnected: boolean;
}

/**
 * A provider's lookup of one server by the name its tool calls carry. `undefined` when the provider does not know the
 * server or is not running.
 */
export type McpServerLookup = (name: string) => Promise<McpServerReport | undefined>;

/**
 * A server that was not connected yet is asked again after this long, at most `MAX_LOOKUPS` times per process. The
 * retry runs on its own timer: a resumed Chat replays its history while HTTP servers are still connecting, and a server
 * the user does not call again would otherwise keep the generic glyph on every replayed row.
 */
const RETRY_AFTER_MS = 60_000;
const MAX_LOOKUPS = 3;

/**
 * The icon size a 14px row glyph reads best from on a 2x display; a larger raster is downscaled cleanly.
 */
const PREFERRED_ICON_SIZE = 32;

const record = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;

const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * An icon source a Client may load: a public HTTPS URL without credentials (read through Main's icon fetch), or an
 * inline image within the snapshot bound. Anything else (`http:`, `file:`, a script URL) is dropped.
 */
function iconSource(value: unknown): string | undefined {
    const source = text(value);
    if (!source || source.length > MAX_AGENT_CHAT_MCP_ICON_SRC_LENGTH) return undefined;
    if (/^data:image\/[\w.+-]+;base64,[\w+/=]+$/u.test(source)) return source;
    try {
        const url = new URL(source);
        if (url.protocol !== 'https:' || url.username || url.password) return undefined;
        url.hash = '';
        return url.href.length > MAX_AGENT_CHAT_MCP_HTTPS_ICON_LENGTH ? undefined : url.href;
    } catch {
        return undefined;
    }
}

const isInlineIcon = (icon: AgentChatMcpIcon): boolean => icon.src.startsWith('data:');

/**
 * Keeps the inline icons of `servers` within `MAX_AGENT_CHAT_MCP_INLINE_ICON_CHARS` in total. Servers are taken in
 * order, so a server already shown keeps its icon and the newest one yields; an inline icon that does not fit is
 * dropped while the server's HTTPS icons and `siteOrigins` stay, so it falls back the way an icon that failed to load
 * does.
 */
export function fitInlineIconBudget(servers: readonly AgentChatMcpServer[]): AgentChatMcpServer[] {
    let remaining = MAX_AGENT_CHAT_MCP_INLINE_ICON_CHARS;
    return servers.map((server) => {
        if (!server.icons?.some((icon) => isInlineIcon(icon))) return server;
        const icons = server.icons.filter((icon) => {
            if (!isInlineIcon(icon)) return true;
            if (icon.src.length > remaining) return false;
            remaining -= icon.src.length;
            return true;
        });
        if (icons.length === server.icons.length) return server;
        const { name, title, siteOrigins } = server;
        return {
            name,
            ...(title !== undefined && { title }),
            ...(icons.length > 0 && { icons }),
            ...(siteOrigins && { siteOrigins }),
        };
    });
}

/**
 * How well an icon suits a 14px glyph; lower is better. A vector or `any`-sized icon fits every size, then the smallest
 * raster at or above `PREFERRED_ICON_SIZE`, then the largest below it, then an icon that declares no size.
 */
function iconRank(icon: Record<string, unknown>): number {
    const mimeType = text(icon.mimeType)?.toLowerCase();
    const sizes = Array.isArray(icon.sizes)
        ? icon.sizes.filter((size): size is string => typeof size === 'string')
        : [];
    if (mimeType === 'image/svg+xml' || sizes.includes('any')) return 0;
    const widths = sizes
        .map((size) => Math.trunc(Number(size.toLowerCase().split('x', 1)[0])))
        .filter((width) => Number.isFinite(width) && width > 0);
    if (widths.length === 0) return 50_000;
    return Math.min(
        ...widths.map((width) => (width >= PREFERRED_ICON_SIZE ? width : 100_000 - width)),
    );
}

/**
 * The best icon per theme (unthemed, light, dark) from a server's `serverInfo.icons`, in declaration order among
 * equals.
 */
export function selectMcpServerIcons(icons: unknown): AgentChatMcpIcon[] {
    if (!Array.isArray(icons)) return [];
    const best = new Map<string, { icon: AgentChatMcpIcon; rank: number }>();
    for (const entry of icons) {
        const icon = record(entry);
        const source = icon && iconSource(icon.src);
        if (!icon || !source) continue;
        const theme = icon.theme === 'light' || icon.theme === 'dark' ? icon.theme : undefined;
        const rank = iconRank(icon);
        const key = theme ?? '';
        const current = best.get(key);
        if (!current || rank < current.rank)
            best.set(key, { icon: { src: source, ...(theme && { theme }) }, rank });
    }
    return best
        .values()
        .map(({ icon }) => icon)
        .toArray();
}

function httpsOrigin(value: unknown): URL | undefined {
    const source = text(value);
    if (!source) return undefined;
    try {
        const url = new URL(source);
        return url.protocol === 'https:' && !url.username && !url.password ? url : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Host labels that name a service under the vendor's own domain (`mcp.exa.ai`), so the parent domain is that vendor's
 * site. Any other first label (`tool.example.vercel.app`, `foo.co.uk`) may sit under a hosting platform or a public
 * suffix, whose icon is not the server's.
 */
const SERVICE_HOST_LABELS = new Set(['api', 'mcp', 'server']);

/**
 * Sites whose `/favicon.ico` stands in for a server without a usable icon: its declared website, its endpoint, and, for
 * a service host such as `mcp.exa.ai` (which serves no icon), the vendor's domain `exa.ai`. An IP endpoint has no
 * parent domain.
 */
export function mcpServerSiteOrigins(websiteUrl: unknown, endpointUrl: unknown): string[] {
    const origins: string[] = [];
    const website = httpsOrigin(websiteUrl);
    if (website) origins.push(website.origin);
    const endpoint = httpsOrigin(endpointUrl);
    if (endpoint) {
        origins.push(endpoint.origin);
        const labels = endpoint.hostname.split('.');
        if (
            labels.length > 2 &&
            SERVICE_HOST_LABELS.has(labels[0] ?? '') &&
            !/^[\d.]+$/u.test(endpoint.hostname) &&
            !endpoint.port
        )
            origins.push(`https://${labels.slice(1).join('.')}`);
    }
    return [...new Set(origins)].slice(0, 3);
}

export function agentChatMcpServer(name: string, report: McpServerReport): AgentChatMcpServer {
    const title = text(report.title);
    const icons = selectMcpServerIcons(report.icons);
    const siteOrigins = mcpServerSiteOrigins(report.websiteUrl, report.endpointUrl);
    return {
        name: clip(name, 200),
        ...(title && { title: clip(title, 200) }),
        ...(icons.length > 0 && { icons }),
        ...(siteOrigins.length > 0 && { siteOrigins }),
    };
}

/**
 * The server name a tool call names, for Claude Code (`mcp__exa__web_search_exa`) and Codex (`exa/web_search_exa`).
 */
function calledMcpServers(operations: readonly AgentChatPatchOperation[]): Set<string> {
    const servers = new Set<string>();
    for (const operation of operations) {
        if (operation.op !== 'upsertItem' || operation.item.type !== 'toolCall') continue;
        const server = parseAgentMcpToolName(operation.item.name)?.server;
        if (server) servers.add(server);
    }
    return servers;
}

interface LookupState {
    attempts: number;
    /**
     * A lookup is running or a retry is scheduled, so a tool call naming the server starts nothing.
     */
    isBusy: boolean;
    isSettled: boolean;
}

/**
 * Looks up each MCP server the first time a tool call in the Chat names it, and publishes what the provider reports as
 * the snapshot's `mcpServers`, so the timeline can show the server's own icon. A lookup runs off the provider's message
 * path and never delays the item that triggered it. One instance lives as long as one provider process.
 */
export function createChatMcpServerWatch(options: {
    read: () => AgentChatSnapshot;
    apply: (operations: AgentChatPatchOperation[]) => void;
    lookup: () => McpServerLookup | undefined;
    /**
     * Runs a retry later; the default timer never keeps Server Core alive.
     */
    schedule?: (run: () => void, delayMs: number) => void;
}) {
    const { schedule = (run, delayMs) => setTimeout(run, delayMs).unref() } = options;
    const lookups = new Map<string, LookupState>();

    const shouldLookUp = (name: string): boolean => {
        const known = options.read().mcpServers?.find((server) => server.name === name);
        if (known?.icons) return false;
        const state = lookups.get(name);
        return !state || (!state.isBusy && !state.isSettled && state.attempts < MAX_LOOKUPS);
    };

    const publish = (server: AgentChatMcpServer): void => {
        const current = options.read().mcpServers ?? [];
        const mcpServers = fitInlineIconBudget(
            [...current.filter((entry) => entry.name !== server.name), server].slice(
                -MAX_AGENT_CHAT_MCP_SERVERS,
            ),
        );
        if (JSON.stringify(mcpServers) === JSON.stringify(current)) return;
        options.apply([{ op: 'state', state: { mcpServers } }]);
    };

    const lookUp = async (name: string, lookup: McpServerLookup): Promise<void> => {
        const state = lookups.get(name) ?? { attempts: 0, isBusy: false, isSettled: false };
        state.attempts += 1;
        state.isBusy = true;
        lookups.set(name, state);
        try {
            const report = await lookup(name);
            if (report) {
                state.isSettled = report.isConnected;
                publish(agentChatMcpServer(name, report));
            }
        } catch {
            // A failed status read leaves the row on its generic glyph; the next call names the server again.
            state.isBusy = false;
            return;
        }
        if (state.isSettled || state.attempts >= MAX_LOOKUPS) {
            state.isBusy = false;
            return;
        }
        schedule(() => {
            state.isBusy = false;
            const current = options.lookup();
            if (current && shouldLookUp(name)) void lookUp(name, current);
        }, RETRY_AFTER_MS);
    };

    return {
        observe(operations: readonly AgentChatPatchOperation[]): void {
            const lookup = options.lookup();
            if (!lookup) return;
            for (const name of calledMcpServers(operations))
                if (shouldLookUp(name)) void lookUp(name, lookup);
        },
    };
}
