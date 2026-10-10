import { Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';

/**
 * Interrupts the running turn. Disabled with a spinner once a Stop was requested, until the turn ends.
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
                disabled={isStopping}
                size="icon"
                variant="secondary"
                onClick={onStop}
            >
                {isStopping ? <Spinner className="size-3.5" /> : <Square className="size-3.5" />}
            </Button>
        </Tooltip>
    );
}
