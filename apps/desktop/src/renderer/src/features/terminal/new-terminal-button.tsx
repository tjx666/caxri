import { useState } from 'react';

import type { TerminalKind, TerminalSurface } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import {
    SplitButton,
    SplitButtonAction,
    SplitButtonTrigger,
} from '../../components/ui/split-button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useCommandShortcut } from '../../lib/keybindings';
import { useSettings, useTerminals } from '../../stores/selectors';
import { AgentChoiceMenuItems } from '../session/agent-choice-menu-items';
import { OpenInChatMenuItem } from '../session/open-in-chat-menu-item';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { usePaneViewSession } from '../workbench/pane-view-session';
import {
    isSameNewTerminalTarget,
    newAgentSurface,
    newTerminalActionLabel,
    newTerminalButtonText,
    newTerminalCommandTarget,
    resolveNewTerminalAgent,
    resolveNewTerminalTarget,
} from './new-terminal-agent';
import { createTerminal } from './terminal-commands';

/**
 * The in-Session New Terminal control. The tab strip's + opens the Agent list on hover; the empty pane's labelled
 * control uses a split button when a default Agent is configured.
 *
 * With no default Agent configured there is nothing for the labelled control's leading half to create, so it collapses
 * to a single button that opens the list: that state of the setting reads "Ask each time". Splitting it there would put
 * two buttons that both open the same menu next to each other: a screen reader would hear two controls claiming the
 * same popup, and Base UI returns focus to whichever one owns the menu rather than the one that was pressed.
 */
export function NewTerminalButton({
    appearance = 'icon',
    paneId,
}: {
    /**
     * `icon` is the tab strip's `+`; `labelled` is the empty pane's full-width call to action.
     */
    appearance?: 'icon' | 'labelled';
    /**
     * Where the Terminal should land; defaults to the active pane.
     */
    paneId?: string;
}) {
    const { t } = useTranslation();
    const session = usePaneViewSession();
    const terminals = useTerminals();
    const primaryTerminal = session ? sessionAgentTerminal(session, terminals) : undefined;
    const settings = useSettings();
    const defaultAgent = resolveNewTerminalAgent(settings?.['session.defaultAgent']);
    const openInChat = settings?.['session.openAgentsInChat'];
    const isIcon = appearance === 'icon';
    const [iconMenuOpen, setIconMenuOpen] = useState(false);
    const newTerminalShortcut = useCommandShortcut('terminal.new');
    const create = (kind: TerminalKind, surface: TerminalSurface): void => {
        void createTerminal(kind, {
            ...(paneId && { paneId }),
            ...(surface === 'chat' && { surface }),
        });
    };
    /**
     * Unlabelled on purpose: Base UI points the popup's `aria-labelledby` at whichever trigger opened it (`MenuRoot`),
     * and `aria-labelledby` outranks `aria-label`, so naming the popup here would be inert. Both triggers already say
     * what the list is for: `New Terminal` when the control is collapsed, `Select a different Agent` on the split
     * button's chevron.
     */
    const menu = (
        <MenuContent align="end">
            <AgentChoiceMenuItems
                defaultAgent={defaultAgent}
                openInChat={openInChat}
                onChoose={create}
            />
            <MenuSeparator />
            <OpenInChatMenuItem />
        </MenuContent>
    );

    if (isIcon) {
        // Fix #1292: a click clones the Session's own primary Agent before falling back to the configured default,
        // so the tab strip keeps a live conversation going instead of always asking or always following a possibly
        // stale setting. See `resolveNewTerminalTarget`.
        const target = resolveNewTerminalTarget(primaryTerminal, defaultAgent, openInChat);
        if (target) {
            const actionLabel = newTerminalActionLabel(
                target,
                resolveAgentIcon(target.kind).label,
                t,
            );
            /**
             * `⌘T` creates the configured default, while a press here may clone the Session's live Agent instead; the
             * chip shows only when both create the same Terminal, so it never promises what the shortcut will not do.
             */
            const isShortcutSameTarget = isSameNewTerminalTarget(
                target,
                newTerminalCommandTarget(settings?.['session.defaultAgent'], openInChat),
            );
            const icon = (
                <MenuTrigger
                    openOnHover
                    delay={100}
                    closeDelay={150}
                    render={
                        /**
                         * Names what a click will actually create, in the same words as the `Tooltip` below, for the
                         * screen reader that never sees the hover preview.
                         */
                        <Button aria-label={actionLabel} size="icon" variant="ghost">
                            <Plus size={14} />
                        </Button>
                    }
                />
            );
            return (
                <Menu
                    open={iconMenuOpen}
                    onOpenChange={(open, details) => {
                        /**
                         * `trigger-press` covers both a pointer click and a keyboard Enter/Space activation: Base UI
                         * reports either the same way for a native `<button>`. Hovering still opens the list (the
                         * `openOnHover` trigger above), which this veto never sees because that request's reason is
                         * `trigger-hover`, not `trigger-press`. Canceling here keeps Base UI from opening the popup at
                         * all, so there is no flash of a list that immediately closes. The keyboard path to the list is
                         * ArrowDown (or ArrowUp) on the focused +: Base UI's menu trigger opens on it with reason
                         * `list-navigation`, which this veto lets through.
                         */
                        if (open && details.reason === 'trigger-press') {
                            details.cancel();
                            create(target.kind, target.surface);
                            return;
                        }
                        setIconMenuOpen(open);
                    }}
                >
                    <Tooltip
                        content={actionLabel}
                        shortcut={isShortcutSameTarget ? newTerminalShortcut : undefined}
                    >
                        {icon}
                    </Tooltip>
                    {menu}
                </Menu>
            );
        }
        /**
         * No tooltip here: with no live primary Agent and no configured default, the button asks which Agent to start,
         * while `terminal.new` has no menu to open from a shortcut and falls back to a shell.
         */
        return (
            <Menu open={iconMenuOpen} onOpenChange={setIconMenuOpen}>
                <MenuTrigger
                    openOnHover
                    delay={100}
                    closeDelay={150}
                    render={
                        <Button aria-label={t('terminal.new.terminal')} size="icon" variant="ghost">
                            <Plus size={14} />
                        </Button>
                    }
                />
                {menu}
            </Menu>
        );
    }

    if (!defaultAgent)
        return (
            <Menu>
                <MenuTrigger
                    render={
                        <Button
                            aria-label={t('terminal.new.terminal')}
                            size="default"
                            variant="default"
                        >
                            {t('terminal.new.terminal')}
                        </Button>
                    }
                />
                {menu}
            </Menu>
        );

    /**
     * Names what this button will actually create. The labelled leading half never shows the list once a default is
     * configured, so "New Terminal" alone would leave a screen reader user guessing which Agent starts.
     */
    const defaultSurface = newAgentSurface(defaultAgent, openInChat);
    const buttonText = newTerminalButtonText(defaultSurface, t);
    const action = (
        <SplitButtonAction
            aria-label={t('terminal.new.buttonWithAgent', {
                action: buttonText,
                agent: resolveAgentIcon(defaultAgent).label,
            })}
            onClick={() => create(defaultAgent, defaultSurface)}
            size="default"
            variant="default"
        >
            <AgentIdentityIcon identity={defaultAgent} size={15} />
            {buttonText}
        </SplitButtonAction>
    );
    return (
        <SplitButton>
            {action}
            <Menu>
                <MenuTrigger
                    render={
                        <SplitButtonTrigger
                            aria-label={t('terminal.new.selectAgent')}
                            size="default"
                            variant="default"
                        />
                    }
                />
                {menu}
            </Menu>
        </SplitButton>
    );
}
