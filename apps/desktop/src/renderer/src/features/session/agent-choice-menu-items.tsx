import type { TerminalKind, TerminalSurface } from '@caxri/protocol';

import { MenuItem } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useAgentAvailability } from '../terminal/hooks/use-agent-availability';
import { agentInstallHint, newTerminalAgentChoices } from '../terminal/new-terminal-agent';
import { AgentChoiceMarker } from './open-in-chat-menu-item';

/**
 * The Agent rows of the New Session and New Terminal menus, shared so both annotate availability the same way. It
 * mounts with the open menu and so reads availability only then. An Agent whose CLI is missing stays in its catalog
 * position and stays selectable (choosing it surfaces the recovery bar with the Settings action); it gains a muted "Not
 * installed" suffix and a tooltip with the install hint. Keyboard order is the catalog order, unchanged.
 */
export function AgentChoiceMenuItems({
    defaultAgent,
    openInChat,
    onChoose,
}: {
    defaultAgent: Parameters<typeof newTerminalAgentChoices>[0];
    openInChat: Parameters<typeof newTerminalAgentChoices>[1];
    onChoose: (kind: TerminalKind, surface: TerminalSurface) => void;
}) {
    const { t } = useTranslation();
    const unavailable = useAgentAvailability();
    return newTerminalAgentChoices(defaultAgent, openInChat, unavailable).map(
        ({ isDefault, isUnavailable, kind, surface }) => {
            const item = (
                <MenuItem key={kind} onClick={() => onChoose(kind, surface)}>
                    <AgentIdentityIcon identity={kind} size={14} />
                    <span className="flex-1 truncate">{resolveAgentIcon(kind).label}</span>
                    {/* A text twin rather than a color or a check glyph: the marker has to survive a screen reader. */}
                    <AgentChoiceMarker
                        isDefault={isDefault}
                        isUnavailable={isUnavailable}
                        surface={surface}
                    />
                </MenuItem>
            );
            const hint = isUnavailable ? agentInstallHint(kind, t) : undefined;
            return hint ? (
                <Tooltip key={kind} content={hint} side="right">
                    {item}
                </Tooltip>
            ) : (
                item
            );
        },
    );
}
