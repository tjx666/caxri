import { Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { useTranslation } from '../../i18n';

/**
 * The composer's one primary action, Send or Stop: a filled `--foreground` circle with a `--background` glyph, the way
 * the Codex app draws it, so the slot reads as the same control in both states.
 */
export const AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME =
    'rounded-full border-foreground bg-foreground text-background enabled:not-aria-disabled:hover:bg-foreground enabled:not-aria-disabled:hover:opacity-85';

/**
 * Interrupts the running turn. Once a Stop was requested it shows a spinner and refuses clicks until the turn ends.
 * That pending state is `aria-disabled` rather than `disabled`: Chromium evicts focus from a natively disabled button,
 * which would drop a keyboard user's focus to the document body mid-interrupt.
 */
export function AgentChatStopButton({
    isStopping,
    onStop,
}: {
    isStopping: boolean;
    onStop: () => void;
}) {
    const { t } = useTranslation();
    return (
        <Tooltip
            content={t(
                isStopping
                    ? 'agentChat.composer.stoppingTooltip'
                    : 'agentChat.composer.stopTooltip',
            )}
            // Escape interrupts a running turn from the composer; it is not a remappable command, so the key is fixed.
            shortcut={isStopping ? undefined : 'escape'}
        >
            <Button
                aria-label={t(
                    isStopping ? 'agentChat.composer.stopping' : 'agentChat.composer.stop',
                )}
                aria-disabled={isStopping || undefined}
                className={AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME}
                size="icon"
                variant="ghost"
                onClick={() => {
                    if (!isStopping) onStop();
                }}
            >
                {isStopping ? (
                    <Spinner className="size-3.5" />
                ) : (
                    <Square aria-hidden="true" className="size-2.5 fill-current" />
                )}
            </Button>
        </Tooltip>
    );
}
