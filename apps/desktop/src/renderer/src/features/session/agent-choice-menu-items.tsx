import { Fragment } from 'react';

import type { TerminalKind, TerminalSurface } from '@caxri/protocol';

import { MenuItem } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useAgentAvailability } from '../terminal/hooks/use-agent-availability';
import {
    agentReadinessHint,
    agentSignInCommand,
    newTerminalAgentChoices,
} from '../terminal/new-terminal-agent';
import { isLastUsedAgentRow } from './last-agent-choice-store';
import { AgentChoiceMarker } from './open-in-chat-menu-item';

/**
 * The Agent rows of the New Session and New Terminal menus, shared so both annotate availability the same way. It
 * mounts with the open menu and so reads availability only then. An Agent whose CLI is missing stays in its catalog
 * position and stays selectable (choosing it surfaces the recovery bar with the Settings action); it gains a muted "Not
 * installed" suffix and a tooltip with the install hint. A signed-out Agent likewise reads "Signed out" with the
 * command that signs it in, and when Caxri knows that command (`agentSignInCommand`) an indented "Sign in…" row follows
 * it: a separate menu item rather than a button inside the row, so the keyboard reaches it and the Agent row keeps
 * creating the Session as before. Keyboard order is the catalog order, unchanged.
 */
export function AgentChoiceMenuItems({
    defaultAgent,
    openInChat,
    repeatedKind,
    onChoose,
    onSignIn,
}: {
    defaultAgent: Parameters<typeof newTerminalAgentChoices>[0];
    openInChat: Parameters<typeof newTerminalAgentChoices>[1];
    /**
     * The Agent a press of the split button repeats, so its row can say so. Omitted where no press repeats a pick.
     */
    repeatedKind?: TerminalKind;
    onChoose: (kind: TerminalKind, surface: TerminalSurface) => void;
    /**
     * Opens a Terminal with `command` typed in. Omitted where the menu has nowhere to open one.
     */
    onSignIn?: (command: string) => void;
}) {
    const { t } = useTranslation();
    const readiness = useAgentAvailability();
    return newTerminalAgentChoices(defaultAgent, openInChat, readiness).map(
        ({ isDefault, issue, kind, surface }) => {
            const hint = agentReadinessHint(kind, issue, t);
            const signInCommand = onSignIn && agentSignInCommand(kind, issue);
            const agentLabel = resolveAgentIcon(kind).label;
            // Always wrapped so availability resolving never remounts the row and drops the menu's keyboard highlight.
            return (
                <Fragment key={kind}>
                    <Tooltip content={hint} disabled={!hint} side="right">
                        <MenuItem onClick={() => onChoose(kind, surface)}>
                            <AgentIdentityIcon identity={kind} size={14} />
                            <span className="flex-1 truncate">{agentLabel}</span>
                            {/* A text twin rather than a color or a check glyph: the marker has to survive a screen reader. */}
                            <AgentChoiceMarker
                                isDefault={isDefault}
                                issue={issue}
                                surface={surface}
                            />
                            {isLastUsedAgentRow(kind, { isDefault, repeatedKind }) && (
                                <span className="text-muted">{t('session.create.lastUsed')}</span>
                            )}
                        </MenuItem>
                    </Tooltip>
                    {signInCommand && (
                        /*
                        Indented under the Agent's name so it reads as that row's action, not another Agent.
                        */
                        <MenuItem
                            aria-label={t('terminal.new.signInAgent', { agent: agentLabel })}
                            className="pl-7.5 text-accent"
                            data-agent-sign-in={kind}
                            onClick={() => onSignIn(signInCommand)}
                        >
                            <span className="flex-1 truncate">{t('terminal.new.signIn')}</span>
                        </MenuItem>
                    )}
                </Fragment>
            );
        },
    );
}
