import type { MouseEventHandler, ReactElement } from 'react';
import { cloneElement, useEffect } from 'react';

import type { ProjectRecord } from '@caxri/protocol';
import { SquareDashed, SquarePen } from 'lucide-react';

import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';
import type { CreateSessionAnchor } from '../../stores/dialogs';
import { closeCreateSessionMenu, useDialogStore } from '../../stores/dialogs';
import { useSettings } from '../../stores/selectors';
import { sessionRowActionButton } from '../primary-sidebar/session-row-actions';
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
 * The Project heading's button opens the list on hover, so picking an Agent needs no extra click. With a configured
 * default Agent it splits: a press creates the default and the tooltip names it; without one a press opens the same
 * list.
 */
function SessionCreationMenu({
    anchor,
    project,
    trigger,
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
}) {
    const open = useDialogStore(
        (state) =>
            state.createSessionMenu?.projectId === project.id &&
            state.createSessionMenu.anchor === anchor,
    );
    const { t } = useTranslation();
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
        ? newSessionActionLabel(splitTarget, resolveAgentIcon(splitTarget.kind).label, t)
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
            // The empty-Project row is a keyboard-reached tree row, not a hover target (see the early return above).
            openOnHover={anchor === 'heading'}
            delay={100}
            closeDelay={150}
            render={
                splitLabel
                    ? cloneElement(trigger, {
                          'aria-label': t('session.create.actionInProject', {
                              action: splitLabel,
                              project: project.displayTitle,
                          }),
                      })
                    : trigger
            }
        />
    );
    /**
     * Only the split names its press in a tooltip. Without a default Agent, hover already opens the list the press
     * would open, so a tooltip would only cover its first row, the same reason the tab strip's `+` shows none in that
     * case. The Tooltip wraps the trigger element here rather than this component, because Base UI's tooltip trigger
     * reaches its child through `render` and a plain function component drops the props it injects.
     */
    const triggerWithTooltip = splitLabel ? (
        <Tooltip content={splitLabel} shortcut={sessionCreateShortcut}>
            {menuTrigger}
        </Tooltip>
    ) : (
        menuTrigger
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
                /**
                 * Hover already opened the heading's list, so a press that follows is the user reaching for it, not
                 * asking to dismiss it. Base UI would toggle the menu closed under the pointer; Escape, an outside
                 * press, or leaving the trigger still close it.
                 */
                if (!nextOpen && anchor === 'heading' && details.reason === 'trigger-press') {
                    details.cancel();
                    return;
                }
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
            <MenuContent
                aria-label={t('session.create.newInProject', { project: project.displayTitle })}
            >
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
                 * Set apart by its separator and a muted icon: skipping the Terminal is an escape hatch, not a peer of the real
                 * options. Its label keeps the normal foreground, since muted text on an enabled item reads as disabled.
                 */}
                <MenuItem onClick={() => chooseSessionTerminalKind(project.id, null)}>
                    <SquareDashed className="text-muted" size={14} />
                    <span className="flex-1 truncate">{t('session.create.withoutTerminal')}</span>
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
    const { t } = useTranslation();
    return (
        <SessionCreationMenu
            anchor="heading"
            project={project}
            trigger={
                <button
                    type="button"
                    /**
                     * Base UI moves focus into the portalled popup, so the row loses `:focus-within` while the menu is
                     * open. Without the open-state override the trigger would fade out from under its own menu the
                     * moment it was used.
                     */
                    className={cn(
                        sessionRowActionButton,
                        'pointer-events-none opacity-0 transition-opacity group-focus-within/project-heading:pointer-events-auto group-focus-within/project-heading:opacity-100 group-hover/project-heading:pointer-events-auto group-hover/project-heading:opacity-100',
                        open && 'pointer-events-auto opacity-100',
                    )}
                    aria-label={t('session.create.newInProject', {
                        project: project.displayTitle,
                    })}
                    tabIndex={-1}
                >
                    <SquarePen size={12} />
                </button>
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
    const { t } = useTranslation();
    return (
        <SessionCreationMenu
            anchor="emptyProject"
            project={project}
            trigger={
                <button
                    className="empty-project flex h-7 w-full cursor-pointer items-center gap-2 rounded-md border-0 bg-transparent px-2 text-muted hover:bg-state-hover hover:text-foreground focus-visible:ring-1 focus-visible:ring-foreground focus-visible:outline-none"
                    /**
                     * Named after the Project because several empty Projects can show this row at once, and "New
                     * Session" alone would read identically for every one of them.
                     */
                    aria-label={t('session.create.newInProject', {
                        project: project.displayTitle,
                    })}
                    aria-level={2}
                    aria-selected={false}
                    data-row-id={rowId}
                    role="treeitem"
                    tabIndex={roving ? 0 : -1}
                >
                    <SquarePen size={13} /> {t('session.create.newSession')}
                </button>
            }
        />
    );
}
