import { Ellipsis, Eraser, Power, SquareTerminal } from 'lucide-react';

import { ShortcutBadge } from '../../components/shortcut-badge';
import { Button } from '../../components/ui/button';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '../../components/ui/menu';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { stopBot } from './bot-commands';
import { openBotClearData, requestBotPalette } from './bot-dialogs-store';

/**
 * The window's less frequent actions. The Command Palette heads the menu with its shortcut, so a pointer user learns
 * the keyboard path to everything else; Stop sits last and apart, since it ends Caxri Bot's run.
 */
export function BotMoreMenu() {
    const { t } = useTranslation();
    const paletteShortcut = useCommandShortcut('commandPalette.open');
    return (
        <Menu>
            <Tooltip content={t('caxriBot.window.more')}>
                <MenuTrigger
                    render={
                        <Button
                            aria-label={t('caxriBot.window.more')}
                            className="caxri-bot-more text-muted"
                            size="icon"
                            variant="ghost"
                        >
                            <Ellipsis size={14} />
                        </Button>
                    }
                />
            </Tooltip>
            <MenuContent align="end" className="min-w-60">
                <MenuItem onClick={requestBotPalette}>
                    <SquareTerminal aria-hidden="true" size={14} className="text-muted" />
                    {t('caxriBot.window.commandPalette')}
                    {paletteShortcut && (
                        <ShortcutBadge compact className="ml-auto" shortcut={paletteShortcut} />
                    )}
                </MenuItem>
                <MenuItem onClick={openBotClearData}>
                    <Eraser aria-hidden="true" size={14} className="text-muted" />
                    {t('caxriBot.palette.clearData')}
                </MenuItem>
                <MenuSeparator />
                <MenuItem className="caxri-bot-stop" onClick={stopBot}>
                    <Power aria-hidden="true" size={14} className="text-muted" />
                    {t('caxriBot.window.stop')}
                </MenuItem>
            </MenuContent>
        </Menu>
    );
}
