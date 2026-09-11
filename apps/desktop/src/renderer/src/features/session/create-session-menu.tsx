import { useEffect } from 'react';

import type { ProjectRecord } from '@caxri/protocol';
import { SquareDashed, SquarePen } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import { closeCreateSessionMenu, useDialogStore } from '../../stores/dialogs';
import { beginSessionCreation, chooseSessionTerminalKind } from './session-actions';
import { useTerminalKindRecencyStore } from './terminal-kind-recency';

/**
 * The Project row's New Session control: the button plus the Terminal-choice menu it anchors.
 *
 * The menu replaces a centered modal so the choice lands where the pointer already is. Its open state lives in the
 * dialog store rather than locally so the `session.create` command reaches this same menu — a keyboard path that opened
 * a different picker would be the "two ways to do one thing" this repository forbids.
 */
export function CreateSessionMenu({ project }: { project: ProjectRecord }) {
    const open = useDialogStore((state) => state.createSessionMenuProjectId === project.id);
    const order = useTerminalKindRecencyStore((state) => state.order);
    /**
     * A Project can leave the bootstrap while its menu is open — removed from another window, or dropped by a Server
     * state change. React then unmounts the only component that renders this id, so Base UI never reports a close and
     * the store would keep a claim that silently re-opens the menu, stealing focus, the next time that row mounts.
     */
    useEffect(
        () => () => {
            if (useDialogStore.getState().createSessionMenuProjectId === project.id)
                closeCreateSessionMenu();
        },
        [project.id],
    );
    return (
        <Menu
            open={open}
            /**
             * The trigger only _requests_ an open; `beginSessionCreation` decides. With a configured
             * `session.defaultAgent` it creates the Session outright and never sets the store's menu Project, so the
             * fully controlled `open` stays false and the button keeps its one-click behavior.
             */
            onOpenChange={(nextOpen) =>
                nextOpen ? beginSessionCreation(project.id) : closeCreateSessionMenu()
            }
        >
            <CommandTooltip commandId="session.create">
                <MenuTrigger
                    render={
                        <Button
                            /**
                             * Base UI moves focus into the portalled popup, so the row loses `:focus-within` while the
                             * menu is open. Without the open-state override the trigger would fade out from under its
                             * own menu the moment it was used.
                             */
                            className={cn(
                                'pointer-events-none opacity-0 transition-opacity group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100 group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100',
                                open && 'pointer-events-auto opacity-100',
                            )}
                            size="icon"
                            variant="ghost"
                            aria-label={`New Session in ${project.displayTitle}`}
                            tabIndex={-1}
                        />
                    }
                >
                    <SquarePen size={13} />
                </MenuTrigger>
            </CommandTooltip>
            <MenuContent aria-label={`New Session in ${project.displayTitle}`}>
                {order.map((kind) => (
                    <MenuItem
                        key={kind}
                        onClick={() => chooseSessionTerminalKind(project.id, kind)}
                    >
                        <AgentIdentityIcon identity={kind} size={14} />
                        <span className="flex-1 truncate">{resolveAgentIcon(kind).label}</span>
                    </MenuItem>
                ))}
                <MenuSeparator />
                {/**
                 * Deliberately quieter than the Terminal choices above: skipping the Terminal is an escape hatch, not a peer of the
                 * real options.
                 */}
                <MenuItem
                    className="text-muted"
                    onClick={() => chooseSessionTerminalKind(project.id, null)}
                >
                    <SquareDashed size={14} />
                    <span className="flex-1 truncate">Start without a Terminal</span>
                </MenuItem>
            </MenuContent>
        </Menu>
    );
}
