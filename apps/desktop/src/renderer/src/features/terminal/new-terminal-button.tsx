import { useState } from 'react';

import type { TerminalKind } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuTrigger } from '../../components/ui/menu';
import {
    SplitButton,
    SplitButtonAction,
    SplitButtonTrigger,
} from '../../components/ui/split-button';
import { resolveAgentIcon } from '../../icons/agents/agent-icon-registry';
import { AgentIdentityIcon } from '../../icons/agents/agent-identity-icon';
import { useSettings } from '../../stores/selectors';
import { newTerminalAgentChoices, resolveNewTerminalAgent } from './new-terminal-agent';
import { createTerminal } from './terminal-commands';

const MENU_LABEL = 'Select a different agent';

/**
 * The in-Session New Terminal control. The tab strip's + opens the Agent list on hover or press; the empty pane's
 * labelled control uses a split button when a default Agent is configured.
 *
 * With no default Agent configured there is nothing for the labelled control's leading half to create, so it collapses
 * to a single button that opens the list — that state of the setting reads "Ask each time". Splitting it there would
 * put two buttons that both open the same menu next to each other: a screen reader would hear two controls claiming the
 * same popup, and Base UI returns focus to whichever one owns the menu rather than the one that was pressed. A
 * configured default turns the labelled leading half into a real action and keeps the chevron as the override; the
 * tab-strip + always opens the list so starting another Agent stays one choice away.
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
    const defaultAgent = resolveNewTerminalAgent(useSettings()?.['session.defaultAgent']);
    const isIcon = appearance === 'icon';
    const [iconMenuOpen, setIconMenuOpen] = useState(false);
    const create = (kind: TerminalKind): void => {
        // eslint-disable-next-line no-void -- intentional floating-promise discard, createTerminal() reports its own errors via tryCommand
        void createTerminal(kind, paneId ? { paneId } : {});
    };
    /**
     * Unlabelled on purpose: Base UI points the popup's `aria-labelledby` at whichever trigger opened it (`MenuRoot`),
     * and `aria-labelledby` outranks `aria-label`, so naming the popup here would be inert. Both triggers already say
     * what the list is for — `New Terminal` when the control is collapsed, `MENU_LABEL` on the split button's chevron.
     */
    const menu = (
        <MenuContent align="end">
            {newTerminalAgentChoices(defaultAgent).map(({ isDefault, kind }) => (
                <MenuItem key={kind} onClick={() => create(kind)}>
                    <AgentIdentityIcon identity={kind} size={14} />
                    <span className="flex-1 truncate">{resolveAgentIcon(kind).label}</span>
                    {/* A text twin rather than a color or a check glyph: the marker has to survive a screen reader. */}
                    {isDefault && <span className="text-muted">Default</span>}
                </MenuItem>
            ))}
        </MenuContent>
    );

    if (isIcon || !defaultAgent)
        /**
         * No `CommandTooltip` here: the button asks which Agent to start, while `terminal.new` has no menu to open from
         * a shortcut and falls back to a shell when no default is configured.
         */
        return (
            <Menu
                open={isIcon ? iconMenuOpen : undefined}
                onOpenChange={isIcon ? setIconMenuOpen : undefined}
            >
                <MenuTrigger
                    openOnHover={isIcon}
                    delay={100}
                    closeDelay={150}
                    render={
                        <Button
                            aria-label="New Terminal"
                            size={isIcon ? 'icon' : 'default'}
                            variant={isIcon ? 'ghost' : 'default'}
                        >
                            {isIcon ? <Plus size={14} /> : 'New Terminal'}
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
    const action = (
        <SplitButtonAction
            aria-label={`New Terminal (${resolveAgentIcon(defaultAgent).label})`}
            onClick={() => create(defaultAgent)}
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
