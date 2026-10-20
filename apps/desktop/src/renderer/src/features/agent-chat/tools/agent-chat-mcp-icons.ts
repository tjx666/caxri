import type { AgentChatMcpServer } from '@caxri/protocol';
import { relativeLuminance } from '@caxri/utils';

/**
 * One place an MCP server's icon may come from, tried in order: an inline image the server shipped, or an icon Main
 * reads from an HTTPS origin (`path`, else the origin's `/favicon.ico`; see `links.favicon`).
 */
export type AgentChatMcpIconCandidate =
    { kind: 'inline'; src: string } | { kind: 'remote'; origin: string; path?: string };

/**
 * Below this a theme background is dark, matching how the editor picks Monaco's base theme.
 */
const DARK_LUMINANCE_THRESHOLD = 0.5;

export const isDarkBackground = (background: string | undefined): boolean =>
    background === undefined || relativeLuminance(background) < DARK_LUMINANCE_THRESHOLD;

/**
 * Where to look for a server's icon on the current theme: the advertised icon drawn for this background first, then an
 * unthemed one, then the one drawn for the other background, and finally the server's sites' favicons.
 */
export function agentChatMcpIconCandidates(
    server: AgentChatMcpServer | undefined,
    isDark: boolean,
): AgentChatMcpIconCandidate[] {
    if (!server) return [];
    const order = isDark ? ['dark', undefined, 'light'] : ['light', undefined, 'dark'];
    const icons = (server.icons ?? []).toSorted(
        (a, b) => order.indexOf(a.theme) - order.indexOf(b.theme),
    );
    const candidates: AgentChatMcpIconCandidate[] = [];
    const seen = new Set<string>();
    const add = (candidate: AgentChatMcpIconCandidate): void => {
        const key =
            candidate.kind === 'inline'
                ? candidate.src
                : `${candidate.origin}${candidate.path ?? '/favicon.ico'}`;
        if (seen.has(key)) return;
        seen.add(key);
        candidates.push(candidate);
    };
    for (const { src } of icons) {
        if (src.startsWith('data:')) {
            add({ kind: 'inline', src });
            continue;
        }
        const url = URL.parse(src);
        if (url?.protocol === 'https:')
            add({ kind: 'remote', origin: url.origin, path: `${url.pathname}${url.search}` });
    }
    const siteOrigins = server.siteOrigins ?? [];
    for (const origin of siteOrigins) add({ kind: 'remote', origin });
    return candidates;
}
