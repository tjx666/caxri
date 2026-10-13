import type { ReactNode } from 'react';
import { useMemo, useState } from 'react';

import type { AgentChatMcpServer } from '@caxri/protocol';

import { McpConnectorIcon } from '../../icons/mcp-connector-icon';
import { cn } from '../../lib/utilities';
import { useCaxriQuery } from '../../queries/client';
import { useTheme } from '../../stores/selectors';
import type { AgentChatMcpIconCandidate } from './agent-chat-mcp-icons';
import { agentChatMcpIconCandidates, isDarkBackground } from './agent-chat-mcp-icons';

const GLYPH_CLASS_NAME = 'size-3.5 shrink-0';

/**
 * An MCP tool call's glyph: the server's own icon, the way the Codex app marks an Exa call with Exa's logo, else the
 * generic connector glyph. Each candidate (see `agentChatMcpIconCandidates`) is tried in turn; the connector glyph
 * stands in while one loads, so a row never leads with a blank gap.
 */
export function AgentChatMcpGlyph({ server }: { server: AgentChatMcpServer | undefined }) {
    const background = useTheme()?.colors.background;
    const isDark = isDarkBackground(background);
    const candidates = useMemo(() => agentChatMcpIconCandidates(server, isDark), [server, isDark]);
    return <McpIconCandidate candidates={candidates} index={0} />;
}

function McpIconCandidate({
    candidates,
    index,
}: {
    candidates: readonly AgentChatMcpIconCandidate[];
    index: number;
}) {
    const candidate = candidates.at(index);
    if (!candidate)
        return <McpConnectorIcon className={GLYPH_CLASS_NAME} data-mcp-icon="generic" />;
    const next = <McpIconCandidate candidates={candidates} index={index + 1} />;
    return candidate.kind === 'inline' ? (
        <McpIconImage fallback={next} src={candidate.src} />
    ) : (
        <RemoteMcpIcon candidate={candidate} fallback={next} />
    );
}

function RemoteMcpIcon({
    candidate,
    fallback,
}: {
    candidate: Extract<AgentChatMcpIconCandidate, { kind: 'remote' }>;
    fallback: ReactNode;
}) {
    const icon = useCaxriQuery(
        'links.favicon',
        { origin: candidate.origin, ...(candidate.path && { path: candidate.path }) },
        { retry: false, staleTime: Infinity },
    );
    if (icon.isPending)
        return <McpConnectorIcon className={GLYPH_CLASS_NAME} data-mcp-icon="generic" />;
    const dataUrl = icon.data?.dataUrl;
    if (!dataUrl) return fallback;
    return <McpIconImage fadeIn={icon.isFetchedAfterMount} fallback={fallback} src={dataUrl} />;
}

/**
 * The icon fades in over the connector glyph it replaces; a cached answer arrives with the first render and skips the
 * fade. An image the browser cannot decode falls through to the next candidate.
 */
function McpIconImage({
    fadeIn = false,
    fallback,
    src,
}: {
    fadeIn?: boolean;
    fallback: ReactNode;
    src: string;
}) {
    const [failedSource, setFailedSource] = useState<string>();
    if (failedSource === src) return fallback;
    return (
        <img
            alt=""
            aria-hidden
            className={cn(
                GLYPH_CLASS_NAME,
                'rounded-xs object-contain',
                fadeIn &&
                    'motion-safe:animate-in motion-safe:fade-in-0 duration-(--motion-overlay-enter) ease-(--motion-ease-enter)',
            )}
            data-mcp-icon="server"
            draggable={false}
            src={src}
            onError={() => setFailedSource(src)}
        />
    );
}
