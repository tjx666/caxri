import { Square } from 'lucide-react';

import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';

/**
 * Interrupts the running turn. While the turn works, an arc circles the stop square so the one control that ends the
 * turn also shows it is still going; once a Stop was requested it is disabled with a spinner until the turn ends.
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
                {isStopping ? (
                    <Spinner className="size-3.5" />
                ) : (
                    <span className="relative flex size-5 items-center justify-center">
                        <svg
                            aria-hidden="true"
                            className="absolute inset-0 size-5 motion-safe:animate-spin"
                            fill="none"
                            viewBox="0 0 20 20"
                        >
                            <circle
                                className="opacity-25"
                                cx="10"
                                cy="10"
                                r="8.5"
                                stroke="currentColor"
                                strokeWidth="1.5"
                            />
                            <circle
                                cx="10"
                                cy="10"
                                r="8.5"
                                stroke="currentColor"
                                strokeDasharray="13 41"
                                strokeLinecap="round"
                                strokeWidth="1.5"
                            />
                        </svg>
                        <Square className="size-2 fill-current" />
                    </span>
                )}
            </Button>
        </Tooltip>
    );
}
