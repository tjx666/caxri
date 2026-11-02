import type { CSSProperties } from 'react';

import { Bot, TerminalSquare } from 'lucide-react';

import { resolveAgentIcon, resolveAgentIconRenderSource } from './agent-icon-registry';

export function AgentIdentityIcon({
    identity,
    size = 14,
}: {
    identity?: string | null;
    size?: number;
}) {
    const icon = resolveAgentIcon(identity);
    if (icon.kind === 'shell')
        return <TerminalSquare aria-hidden="true" data-agent-icon="shell" size={size} />;
    if (icon.kind === 'unknown')
        return <Bot aria-hidden="true" data-agent-icon="unknown" size={size} />;
    const resolved = resolveAgentIconRenderSource(icon);
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
