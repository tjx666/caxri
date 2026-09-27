import type { CSSProperties } from 'react';

import { Bot, TerminalSquare } from 'lucide-react';

import type { AgentIconTone } from './agent-icon-registry';
import { resolveAgentIcon, resolveAgentIconRenderSource } from './agent-icon-registry';

export function AgentIdentityIcon({
    identity,
    size = 14,
    tone = 'brand',
}: {
    identity?: string | null;
    size?: number;
    /**
     * See {@link AgentIconTone}. Defaults to `'brand'`, today's behavior: a `color-asset` identity (Claude Code, Codex)
     * keeps its full-color mark. Pass `'state'` in a context that tints the icon by the Session/Terminal's own
     * running/waiting/idle/failed state or its tab/row selection state (Session rows, Activity rows, Terminal tab
     * icons), so every identity tints alike.
     */
    tone?: AgentIconTone;
}) {
    const icon = resolveAgentIcon(identity);
    if (icon.kind === 'shell')
        return <TerminalSquare aria-hidden="true" data-agent-icon="shell" size={size} />;
    if (icon.kind === 'unknown')
        return <Bot aria-hidden="true" data-agent-icon="unknown" size={size} />;
    const resolved = resolveAgentIconRenderSource(icon, tone);
    if (!resolved) return null;
    if (resolved.kind === 'image')
        return (
            <img
                alt=""
                aria-hidden="true"
                className="agent-identity-icon inline-block flex-none object-contain"
                data-agent-icon={icon.id}
                draggable={false}
                height={size}
                src={resolved.src}
                width={size}
            />
        );
    const style = {
        '--agent-icon-mask': `url("${resolved.src}")`,
        'height': size,
        'mask': 'var(--agent-icon-mask) center / contain no-repeat',
        'width': size,
    } as CSSProperties;
    return (
        <span
            aria-hidden="true"
            className="agent-identity-icon agent-identity-icon-mask inline-block flex-none bg-current object-contain"
            data-agent-icon={icon.id}
            style={style}
        />
    );
}
