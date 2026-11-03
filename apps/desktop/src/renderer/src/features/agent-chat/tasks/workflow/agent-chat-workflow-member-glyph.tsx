import type { AgentChatWorkflowAgentKind } from '@caxri/protocol';
import { Bot, Map as MapIcon, Telescope, UserCog } from 'lucide-react';

import { cn } from '../../../../lib/utilities';

const MEMBER_ICONS = {
    ordinary: Bot,
    explore: Telescope,
    plan: MapIcon,
    builtIn: Bot,
    custom: UserCog,
} as const;

/**
 * A workflow member's glyph by the kind of agent that ran it, so a built-in Explore or a custom agent reads apart from
 * an ordinary subagent at a glance. The row's tooltip names the type.
 */
export function AgentChatWorkflowMemberGlyph({
    className,
    kind,
}: {
    className?: string;
    kind: AgentChatWorkflowAgentKind;
}) {
    const Icon = MEMBER_ICONS[kind];
    return <Icon aria-hidden="true" className={cn('size-3.5 shrink-0', className)} />;
}
