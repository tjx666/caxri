import { useEffect, useState } from 'react';

import { Check, Copy } from 'lucide-react';

import { cn } from '../../lib/utilities';
import type { CopyFeedbackStatus } from '../copy-feedback';
import { COPY_FEEDBACK_RESET_MS, copyButtonLabel } from '../copy-feedback';
import { Tooltip } from '../ui/tooltip';

/**
 * A ghost icon button that copies and then confirms with a check for a moment. `copy` resolves to the feedback status
 * and never rejects (see `writeToClipboardWithFeedback`). Its shared tooltip says the same as its accessible name.
 */
export function CopyIconButton({
    className,
    copy,
    label,
}: {
    className?: string;
    copy: () => Promise<CopyFeedbackStatus>;
    label: string;
}) {
    const [status, setStatus] = useState<CopyFeedbackStatus>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timer = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [status]);
    const accessibleLabel = copyButtonLabel(status, label);
    return (
        <Tooltip content={accessibleLabel}>
            <button
                aria-label={accessibleLabel}
                className={cn(
                    'flex size-6 cursor-pointer items-center justify-center rounded border-0 bg-transparent text-muted hover:bg-[var(--selection)] hover:text-foreground focus-visible:outline focus-visible:outline-accent',
                    status === 'failed' && 'text-danger',
                    className,
                )}
                type="button"
                onClick={async () => {
                    setStatus(await copy());
                }}
            >
                {status === 'copied' ? (
                    <Check className="size-3.5" />
                ) : (
                    <Copy className="size-3.5" />
                )}
            </button>
        </Tooltip>
    );
}
