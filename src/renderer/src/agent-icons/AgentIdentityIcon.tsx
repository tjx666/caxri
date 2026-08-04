import { Bot, TerminalSquare } from 'lucide-react';
import type { CSSProperties } from 'react';

import { resolveAgentIcon } from './agent-icon-registry';

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
    if (icon.kind === 'color-asset')
        return (
            <img
                alt=""
                aria-hidden="true"
                className="agent-identity-icon"
                data-agent-icon={icon.id}
                draggable={false}
                height={size}
                src={icon.src}
                width={size}
            />
        );
    const style = {
        '--agent-icon-mask': `url("${icon.src}")`,
        'height': size,
        'width': size,
    } as CSSProperties;
    return (
        <span
            aria-hidden="true"
            className="agent-identity-icon agent-identity-icon-mask"
            data-agent-icon={icon.id}
            style={style}
        />
    );
}
