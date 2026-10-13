import { Ellipsis, Eraser, Power, SquareTerminal } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { stopCommander } from './commander-commands';
import { openCommanderClearData, requestCommanderPalette } from './commander-dialogs-store';

/**
 * The window's less frequent actions. The Command Palette heads the menu with its shortcut, so a pointer user learns
 * the keyboard path to everything else; Stop sits last and apart, since it ends the Commander's run.
 */
export function CommanderMoreMenu() {
    const { t } = useTranslation();
    const paletteShortcut = useCommandShortcut('commandPalette.open');
    return (
        <Menu>
            <Tooltip content={t('agentCommander.window.more')}>
                <MenuTrigger
                    render={
                        <Button
                            aria-label={t('agentCommander.window.more')}
                            className="agent-commander-more text-muted"
                            size="icon"
                            variant="ghost"
                        >
                            <Ellipsis size={14} />
                        </Button>
                    }
                />
            </Tooltip>
            <MenuContent align="end" className="min-w-60">
                <MenuItem onClick={requestCommanderPalette}>
                    <SquareTerminal aria-hidden="true" size={14} className="text-muted" />
                    {t('agentCommander.window.commandPalette')}
                    {paletteShortcut && (
                        <ShortcutBadge compact className="ml-auto" shortcut={paletteShortcut} />
                    )}
                </MenuItem>
                <MenuItem onClick={openCommanderClearData}>
                    <Eraser aria-hidden="true" size={14} className="text-muted" />
                    {t('agentCommander.palette.clearData')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem className="agent-commander-stop" onClick={stopCommander}>
                    <Power aria-hidden="true" size={14} className="text-muted" />
                    {t('agentCommander.window.stop')}
                </MenuItem>
            </MenuContent>
        </Menu>
    );
}
