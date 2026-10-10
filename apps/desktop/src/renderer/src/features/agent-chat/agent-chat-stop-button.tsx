import { Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';

/**
 * The composer's one primary action, Send or Stop: a filled `--foreground` circle with a `--background` glyph, the way
 * the Codex app draws it, so the slot reads as the same control in both states.
 */
export const AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME =
    'rounded-full border-foreground bg-foreground text-background enabled:not-aria-disabled:hover:bg-foreground enabled:not-aria-disabled:hover:opacity-85';

/**
 * Interrupts the running turn. Once a Stop was requested it is disabled with a spinner until the turn ends.
 */
export function AgentChatStopButton({
    isStopping,
    onStop,
}: {
    isStopping: boolean;
    onStop: () => void;
}) {
    return (
        <Tooltip content={isStopping ? 'Stopping…' : 'Stop (Esc)'}>
            <Button
                aria-label={isStopping ? 'Stopping' : 'Stop'}
                className={AGENT_CHAT_PRIMARY_ACTION_CLASS_NAME}
                disabled={isStopping}
                size="icon"
                variant="ghost"
                onClick={onStop}
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
