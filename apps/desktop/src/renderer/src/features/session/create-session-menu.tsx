import type { MouseEventHandler, ReactElement } from 'react';
import { cloneElement, useEffect } from 'react';

import type { CommandId, ProjectRecord } from '@caxri/protocol';
import { SquareDashed, SquarePen } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import type { CreateSessionAnchor } from '../../stores/dialogs';
import { closeCreateSessionMenu, useDialogStore } from '../../stores/dialogs';
import { useSettings } from '../../stores/selectors';
import {
    newAgentSurface,
    newSessionActionLabel,
    newTerminalAgentChoices,
} from '../terminal/new-terminal-agent';
import { AgentChoiceMarker, OpenInChatMenuItem } from './open-in-chat-menu-item';
import {
    beginSessionCreation,
    chooseSessionTerminalKind,
    openSessionCreationMenu,
} from './session-creation-commands';

/**
 * The Terminal-choice menu for a new Session, hung from whichever control opened it.
 *
 * The menu replaces a centered modal so the choice lands where the pointer already is. Its open state lives in the
 * dialog store rather than locally so the `session.create` command reaches this same menu: a keyboard path that opened
 * a different picker would be the "two ways to do one thing" this repository forbids. That store entry names the
 * trigger as well as the Project, because one Project can render more than one of these at a time.
 *
 * With a configured default Agent the Project heading's button splits the way the tab strip's `+` does: a press creates
 * the default, hovering opens the list to pick a different Agent, and the tooltip names what the press creates.
 */
function SessionCreationMenu({
    anchor,
    project,
    trigger,
    tooltipCommandId,
}: {
    anchor: CreateSessionAnchor;
    project: ProjectRecord;
    /**
     * Typed to accept an `onClick` override rather than the looser default `ReactElement` props: the default-Agent
     * branch below clones this element with a direct `onClick` instead of handing the click to Base UI's `Menu`.
     */
    trigger: ReactElement<{
        'aria-label'?: string;
        'onClick'?: MouseEventHandler<HTMLButtonElement>;
    }>;
    /**
     * Renders the trigger inside a `CommandTooltip`. It has to be resolved here rather than by the caller wrapping this
     * component, because Base UI's tooltip trigger reaches its child through `render` and a plain function component
     * drops the props it injects; the tooltip then has nothing to attach to and never opens.
     */
    tooltipCommandId?: CommandId;
}) {
    const open = useDialogStore(
        (state) =>
            state.createSessionMenu?.projectId === project.id &&
            state.createSessionMenu.anchor === anchor,
    );
    const settings = useSettings();
    const defaultAgent = settings?.['session.defaultAgent'];
    const openInChat = settings?.['session.openAgentsInChat'];
    const sessionCreateShortcut = useCommandShortcut('session.create');
    /**
     * A Project can leave the bootstrap while its menu is open: removed from another window, or dropped by a Server
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
    /**
     * The empty-Project row is a tree row the user reaches by keyboard, not a hover target, so with a configured
     * `session.defaultAgent` it stays a plain button that creates the default and never routes the click through Base
     * UI's `Menu`. A controlled `Menu` whose `open` prop never turns `true` after a press loses sync between its
     * internal interaction state and the prop and stops reporting further `onOpenChange(true)` calls, which is why the
     * second click on this trigger used to do nothing (github.com/tjx666/caxri/issues/905).
     */
    if (defaultAgent && anchor === 'emptyProject') {
        return cloneElement(trigger, {
            onClick: () => {
                beginSessionCreation(project.id, anchor);
            },
        });
    }
    /**
     * The heading's split: a press creates the default Agent, hover opens the list. The press is vetoed with
     * `details.cancel()` before Base UI opens anything, the same way the tab strip's `+` does it, so the menu's
     * internal state never diverges from the store claim (the #905 desync above needed an open request that was
     * silently dropped, not a canceled one).
     */
    const splitTarget = defaultAgent
        ? { kind: defaultAgent, surface: newAgentSurface(defaultAgent, openInChat) }
        : undefined;
    const splitLabel = splitTarget
        ? newSessionActionLabel(splitTarget, resolveAgentIcon(splitTarget.kind).label)
        : undefined;
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
            openOnHover={splitTarget !== undefined}
            delay={100}
            closeDelay={150}
            render={
                splitLabel
                    ? cloneElement(trigger, {
                          'aria-label': `${splitLabel} in ${project.displayTitle}`,
                      })
                    : trigger
            }
        />
    );
    let triggerWithTooltip = menuTrigger;
    if (splitLabel)
        triggerWithTooltip = (
            <Tooltip content={splitLabel} shortcut={sessionCreateShortcut}>
                {menuTrigger}
            </Tooltip>
        );
    else if (tooltipCommandId)
        triggerWithTooltip = (
            <CommandTooltip commandId={tooltipCommandId}>{menuTrigger}</CommandTooltip>
        );
    return (
        <Menu
            open={open}
            /**
             * The trigger only _requests_ an open here; the store claim is what opens the menu. `trigger-press` covers
             * a pointer click and a keyboard Enter/Space alike, while a hover reports `trigger-hover` and opens the
             * list.
             */
            onOpenChange={(nextOpen, details) => {
                if (!nextOpen) {
                    closeCreateSessionMenu();
                    return;
                }
                if (splitTarget && details.reason === 'trigger-press') {
                    details.cancel();
                    beginSessionCreation(project.id, anchor);
                    return;
                }
                openSessionCreationMenu(project.id, anchor);
            }}
        >
            {triggerWithTooltip}
            <MenuContent aria-label={`New Session in ${project.displayTitle}`}>
                {newTerminalAgentChoices(defaultAgent, openInChat).map(
                    ({ isDefault, kind, surface }) => (
                        <MenuItem
                            key={kind}
                            onClick={() => chooseSessionTerminalKind(project.id, kind)}
                        >
                            <AgentIdentityIcon identity={kind} size={14} />
                            <span className="flex-1 truncate">{resolveAgentIcon(kind).label}</span>
                            <AgentChoiceMarker isDefault={isDefault} surface={surface} />
                        </MenuItem>
                    ),
                )}
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
                <MenuSeparator />
                <OpenInChatMenuItem />
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
 * It is also a row of the PrimarySidebar's ARIA tree: `rowId` is how arrow-key navigation finds and focuses it,
 * `roving` is true while it owns the tree's single Tab stop, and the button carries the `treeitem` role itself because
 * it is the element focus lands on. The `aria-expanded` Base UI adds here reports this row's menu, which is what its
 * companion `aria-haspopup="menu"` says it is; the row has no children of its own.
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
                    aria-level={2}
                    aria-selected={false}
                    data-row-id={rowId}
                    role="treeitem"
                    tabIndex={roving ? 0 : -1}
                >
                    <SquarePen size={13} /> New Session
                </button>
            }
        />
    );
}
