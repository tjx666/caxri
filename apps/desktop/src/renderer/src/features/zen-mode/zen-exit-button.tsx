import { Minimize2 } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';

/**
 * The mouse exit for Zen Mode, which hides every other control. It stays invisible until the pointer reaches the top
 * right corner (or keyboard focus lands on it), so it adds nothing to look at while the user reads or works. The hot
 * zone opts out of the window drag band, otherwise the band would swallow the hover.
 */
export function ZenExitButton() {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut('view.toggleZenMode');
    return (
        <div className="group/zen-exit fixed top-0 right-0 z-30 flex h-9 w-14 items-center justify-center [-webkit-app-region:no-drag]">
            <Tooltip content={t('workbench.exitZenMode')} shortcut={shortcut} side="left">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('workbench.exitZenMode')}
                    className="opacity-0 transition-opacity group-hover/zen-exit:opacity-100 focus-visible:opacity-100"
                    onClick={() => executeCommand('view.toggleZenMode')}
                >
                    <Minimize2 size={14} />
                </Button>
            </Tooltip>
        </div>
    );
}
