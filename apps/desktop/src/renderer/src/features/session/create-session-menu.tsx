import type { ReactElement } from 'react';
import { useEffect } from 'react';

import type { CommandId, ProjectRecord } from '@caxri/protocol';
import { terminalKindSchema } from '@caxri/protocol';
import { SquareDashed, SquarePen } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { cn } from '../../lib/utilities';
import type { CreateSessionAnchor } from '../../stores/dialogs';
import { closeCreateSessionMenu, useDialogStore } from '../../stores/dialogs';
import { beginSessionCreation, chooseSessionTerminalKind } from './session-commands';

/**
 * The Terminal-choice menu for a new Session, hung from whichever control opened it.
 *
 * The menu replaces a centered modal so the choice lands where the pointer already is. Its open state lives in the
 * dialog store rather than locally so the `session.create` command reaches this same menu — a keyboard path that opened
 * a different picker would be the "two ways to do one thing" this repository forbids. That store entry names the
 * trigger as well as the Project, because one Project can render more than one of these at a time.
 */
function SessionCreationMenu({
    anchor,
    project,
    trigger,
    tooltipCommandId,
}: {
    anchor: CreateSessionAnchor;
    project: ProjectRecord;
    trigger: ReactElement;
    /**
     * Renders the trigger inside a `CommandTooltip`. It has to be resolved here rather than by the caller wrapping this
     * component, because Base UI's tooltip trigger reaches its child through `render` and a plain function component
     * drops the props it injects — the tooltip then has nothing to attach to and never opens.
     */
    tooltipCommandId?: CommandId;
}) {
    const open = useDialogStore(
        (state) =>
            state.createSessionMenu?.projectId === project.id &&
            state.createSessionMenu.anchor === anchor,
    );
    const menuTrigger = (
        <MenuTrigger
            /**
             * Base UI opens a root menu on ArrowUp/ArrowDown and stops the event there. That is the right default for
             * the heading's pencil, but the empty-Project row is also a row of the PrimarySidebar's ARIA tree, where
             * those two keys are how the user walks to the rows above and below it. Suppressing Base UI's own handler
             * lets the key bubble to the tree's handler instead, so the row can be left the same way it was reached
             * (github.com/tjx666/caxri/issues/608).
             */
            onKeyDown={
                anchor === 'emptyProject'
                    ? (event) => {
                          if (event.key === 'ArrowDown' || event.key === 'ArrowUp')
                              event.preventBaseUIHandler();
                      }
                    : undefined
            }
            render={trigger}
        />
    );
    /**
     * A Project can leave the bootstrap while its menu is open — removed from another window, or dropped by a Server
     * state change. React then unmounts the only component that renders this claim, so Base UI never reports a close
     * and the store would keep a claim that silently re-opens the menu, stealing focus, the next time that row mounts.
     */
    useEffect(
        () => () => {
            const claim = useDialogStore.getState().createSessionMenu;
            if (claim?.projectId === project.id && claim.anchor === anchor)
                closeCreateSessionMenu();
        },
        [anchor, project.id],
    );
    return (
        <Menu
            open={open}
            /**
             * The trigger only _requests_ an open; `beginSessionCreation` decides. With a configured
             * `session.defaultAgent` it creates the Session outright and never sets the store's menu claim, so the
             * fully controlled `open` stays false and the button keeps its one-click behavior.
             */
            onOpenChange={(nextOpen) =>
                nextOpen ? beginSessionCreation(project.id, anchor) : closeCreateSessionMenu()
            }
        >
            {tooltipCommandId ? (
                <CommandTooltip commandId={tooltipCommandId}>{menuTrigger}</CommandTooltip>
            ) : (
                menuTrigger
            )}
            <MenuContent aria-label={`New Session in ${project.displayTitle}`}>
                {terminalKindSchema.options.map((kind) => (
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

/**
 * The Project heading's New Session control: the pencil button plus the menu it anchors.
 */
export function CreateSessionMenu({ project }: { project: ProjectRecord }) {
    const open = useDialogStore(
        (state) =>
            state.createSessionMenu?.projectId === project.id &&
            state.createSessionMenu.anchor === 'heading',
    );
    return (
        <SessionCreationMenu
            anchor="heading"
            project={project}
            tooltipCommandId="session.create"
            trigger={
                <Button
                    /**
                     * Base UI moves focus into the portalled popup, so the row loses `:focus-within` while the menu is
                     * open. Without the open-state override the trigger would fade out from under its own menu the
                     * moment it was used.
                     */
                    className={cn(
                        'pointer-events-none opacity-0 transition-opacity group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100 group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100',
                        open && 'pointer-events-auto opacity-100',
                    )}
                    size="icon"
                    variant="ghost"
                    aria-label={`New Session in ${project.displayTitle}`}
                    tabIndex={-1}
                >
                    <SquarePen size={13} />
                </Button>
            }
        />
    );
}

/**
 * The row a Project with no Sessions shows in its place, and the menu it anchors.
 *
 * It renders its own menu rather than reusing the heading's so the choice opens under the button the user clicked;
 * before that, this button borrowed the heading's menu and the popup appeared several rows above the pointer.
 *
 * It is also a row of the PrimarySidebar's ARIA tree: `rowId` is how arrow-key navigation finds and focuses it, and
 * `roving` is true while it owns the tree's single Tab stop.
 */
export function EmptyProjectSessionMenu({
    project,
    roving,
    rowId,
}: {
    project: ProjectRecord;
    roving: boolean;
    rowId: string;
}) {
    return (
        <SessionCreationMenu
            anchor="emptyProject"
            project={project}
            trigger={
                <button
                    className="empty-project flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-muted hover:bg-[color-mix(in_srgb,var(--elevated)_60%,transparent)] hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    /**
                     * Named after the Project because several empty Projects can show this row at once, and "New
                     * Session" alone would read identically for every one of them.
                     */
                    aria-label={`New Session in ${project.displayTitle}`}
                    data-row-id={rowId}
                    tabIndex={roving ? 0 : -1}
                >
                    <SquarePen size={13} /> New Session
                </button>
            }
        />
    );
}
