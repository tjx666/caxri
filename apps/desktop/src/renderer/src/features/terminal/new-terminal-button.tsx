import { useState } from 'react';

import type { TerminalKind, TerminalSurface } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import {
    SplitButton,
    SplitButtonAction,
    SplitButtonTrigger,
} from '../../components/ui/split-button';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useSettings, useTerminals } from '../../stores/selectors';
import { ChatSurfaceMarker, OpenInChatMenuItem } from '../session/open-in-chat-menu-item';
import { sessionAgentTerminal } from '../session/session-agent-terminal';
import { usePaneViewSession } from '../workbench/pane-view-session';
import {
    newAgentSurface,
    newTerminalAgentChoices,
    resolveNewTerminalAgent,
    resolveNewTerminalTarget,
} from './new-terminal-agent';
import { createTerminal } from './terminal-commands';

const MENU_LABEL = 'Select a different agent';

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
    const session = usePaneViewSession();
    const terminals = useTerminals();
    const primaryTerminal = session ? sessionAgentTerminal(session, terminals) : undefined;
    const settings = useSettings();
    const defaultAgent = resolveNewTerminalAgent(settings?.['session.defaultAgent']);
    const openInChat = settings?.['session.openAgentsInChat'];
    const isIcon = appearance === 'icon';
    const [iconMenuOpen, setIconMenuOpen] = useState(false);
    const create = (kind: TerminalKind, surface: TerminalSurface): void => {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, createTerminal() reports its own errors via tryCommand
        void createTerminal(kind, {
            ...(paneId && { paneId }),
            ...(surface === 'chat' && { surface }),
        });
    };
    /**
     * Unlabelled on purpose: Base UI points the popup's `aria-labelledby` at whichever trigger opened it (`MenuRoot`),
     * and `aria-labelledby` outranks `aria-label`, so naming the popup here would be inert. Both triggers already say
     * what the list is for: `New Terminal` when the control is collapsed, `MENU_LABEL` on the split button's chevron.
     */
    const menu = (
        <MenuContent align="end">
            {newTerminalAgentChoices(defaultAgent, openInChat).map(
                ({ isDefault, kind, surface }) => (
                    <MenuItem key={kind} onClick={() => create(kind, surface)}>
                        <AgentIdentityIcon identity={kind} size={14} />
                        <span className="flex-1 truncate">{resolveAgentIcon(kind).label}</span>
                        {surface === 'chat' && <ChatSurfaceMarker />}
                        {/* A text twin rather than a color or a check glyph: the marker has to survive a screen reader. */}
                        {isDefault && <span className="text-muted">Default</span>}
                    </MenuItem>
                ),
            )}
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
            const icon = (
                <MenuTrigger
                    openOnHover
                    delay={100}
                    closeDelay={150}
                    render={
                        /**
                         * Names what a click will actually create, for the screen reader that never sees the hover
                         * preview. `CommandTooltip` below covers the sighted hint plus the ⌘T shortcut it shares.
                         */
                        <Button
                            aria-label={`New Terminal (${resolveAgentIcon(target.kind).label}${target.surface === 'chat' ? ' Chat' : ''})`}
                            size="icon"
                            variant="ghost"
                        >
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
                         * all, so there is no flash of a list that immediately closes.
                         */
                        if (open && details.reason === 'trigger-press') {
                            details.cancel();
                            create(target.kind, target.surface);
                            return;
                        }
                        setIconMenuOpen(open);
                    }}
                >
                    <CommandTooltip commandId="terminal.new">{icon}</CommandTooltip>
                    {menu}
                </Menu>
            );
        }
        /**
         * No `CommandTooltip` here: with no live primary Agent and no configured default, the button asks which Agent
         * to start, while `terminal.new` has no menu to open from a shortcut and falls back to a shell.
         */
        return (
            <Menu open={iconMenuOpen} onOpenChange={setIconMenuOpen}>
                <MenuTrigger
                    openOnHover
                    delay={100}
                    closeDelay={150}
                    render={
                        <Button aria-label="New Terminal" size="icon" variant="ghost">
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
                        <Button aria-label="New Terminal" size="default" variant="default">
                            New Terminal
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
    const action = (
        <SplitButtonAction
            aria-label={`New Terminal (${resolveAgentIcon(defaultAgent).label}${defaultSurface === 'chat' ? ' Chat' : ''})`}
            onClick={() => create(defaultAgent, defaultSurface)}
            size="default"
            variant="default"
        >
            <AgentIdentityIcon identity={defaultAgent} size={15} />
            New Terminal
        </SplitButtonAction>
    );
    return (
        <SplitButton>
            {action}
            <Menu>
                <MenuTrigger
                    render={
                        <SplitButtonTrigger
                            aria-label={MENU_LABEL}
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
