import { useEffect, useState } from 'react';

import { Minimize2 } from 'lucide-react';

import { executeCommand } from '../../commands/execute';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';
import { useCommandShortcut } from '../../lib/keybindings';
import { cn } from '../../lib/utilities';

/**
 * How long the exit button stays visible after Zen Mode starts, so a user who just pressed the shortcut (or restored
 * Zen at launch) sees how to leave before the chrome-free window gives no hint. Long enough to read, short enough not
 * to linger over the content.
 */
const ENTRY_CUE_MS = 1500;

/**
 * The mouse exit for Zen Mode, which hides every other control. It stays invisible until the pointer reaches the top
 * right corner (or keyboard focus lands on it), so it adds nothing to look at while the user reads or works. The hot
 * zone opts out of the window drag band, otherwise the band would swallow the hover. The one exception is a brief cue
 * on entry: the button shows for {@link ENTRY_CUE_MS}, then fades out on the feedback token (instantly under reduced
 * motion).
 */
export function ZenExitButton() {
    const { t } = useTranslation();
    const shortcut = useCommandShortcut('view.toggleZenMode');
    const [isCueVisible, setIsCueVisible] = useState(true);
    useEffect(() => {
        const timer = setTimeout(() => setIsCueVisible(false), ENTRY_CUE_MS);
        return () => clearTimeout(timer);
    }, []);
    return (
        <div className="group/zen-exit fixed top-0 right-0 z-30 flex h-9 w-14 items-center justify-center [-webkit-app-region:no-drag]">
            <Tooltip content={t('workbench.exitZenMode')} shortcut={shortcut} side="left">
                <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t('workbench.exitZenMode')}
                    className={cn(
                        'transition-opacity group-hover/zen-exit:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none',
                        isCueVisible ? 'opacity-100' : 'opacity-0',
                    )}
                    onClick={() => executeCommand('view.toggleZenMode')}
                >
                    <Minimize2 size={14} />
                </Button>
            </Tooltip>
        </div>
    );
}
