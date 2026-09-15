import type { TerminalKind } from '@caxri/protocol';
import { Plus } from 'lucide-react';

import { CommandTooltip } from '../../components/command-tooltip';
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
 * The in-Session New Terminal control: a split button whose leading half creates the Session's default Agent straight
 * away and whose chevron lists every Agent plus the plain shell.
 *
 * With no default Agent configured there is nothing for a leading half to create, so the control collapses to a single
 * button that opens the list — that state of the setting reads "Ask each time", so this is the entry point asking.
 * Splitting it there would put two buttons that both open the same menu next to each other: a screen reader would hear
 * two controls claiming the same popup, and Base UI returns focus to whichever one owns the menu rather than the one
 * that was pressed. A configured default turns the leading half into a real action and keeps the chevron as the
 * override, which is what makes "Default" a pre-selection rather than a switch that takes the choice away.
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

    if (!defaultAgent)
        /**
         * No `CommandTooltip` here: `terminal.new` has no menu to open from a shortcut, so it falls back to a shell
         * (`newTerminalCommandKind`). Advertising ⌘T on a button that asks instead would promise the two do the same
         * thing.
         */
        return (
            <Menu>
                <MenuTrigger
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
     * Names what this button will actually create. The leading half never shows the list once a default is configured,
     * so "New Terminal" alone would leave a screen reader user guessing which Agent starts.
     */
    const action = (
        <SplitButtonAction
            aria-label={`New Terminal (${resolveAgentIcon(defaultAgent).label})`}
            onClick={() => create(defaultAgent)}
            size={isIcon ? 'icon' : 'default'}
            variant={isIcon ? 'ghost' : 'default'}
        >
            {isIcon ? (
                <Plus size={14} />
            ) : (
                <>
                    <AgentIdentityIcon identity={defaultAgent} size={15} />
                    New Terminal
                </>
            )}
        </SplitButtonAction>
    );
    return (
        <SplitButton>
            {isIcon ? <CommandTooltip commandId="terminal.new">{action}</CommandTooltip> : action}
            <Menu>
                <MenuTrigger
                    render={
                        <SplitButtonTrigger
                            aria-label={MENU_LABEL}
                            size={isIcon ? 'sm' : 'default'}
                            variant={isIcon ? 'ghost' : 'default'}
                        />
                    }
                />
                {menu}
            </Menu>
        </SplitButton>
    );
}
