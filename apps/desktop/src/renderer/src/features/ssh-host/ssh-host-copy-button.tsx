import { useEffect, useState } from 'react';

import type { CopyFeedbackStatus } from '../../components/copy-feedback';
import {
    COPY_FEEDBACK_RESET_MS,
    copyButtonLabel,
    writeToClipboardWithFeedback,
} from '../../components/copy-feedback';
import { Button } from '../../components/ui/button';
import { useTranslation } from '../../i18n';

/**
 * A secondary button that copies `text` and says "Copied" (or that copying failed) in its own label for a moment. The
 * connection overlay covers the Workbench whose toasts would otherwise acknowledge the copy.
 */
export function SshHostCopyButton({ label, text }: { label: string; text: string }) {
    const { t } = useTranslation();
    const [status, setStatus] = useState<CopyFeedbackStatus>('idle');
    useEffect(() => {
        if (status === 'idle') return;
        const timer = setTimeout(() => setStatus('idle'), COPY_FEEDBACK_RESET_MS);
        return () => clearTimeout(timer);
    }, [status]);
    return (
        <Button
            variant="secondary"
            onClick={async () => {
                // Resolves to a status and never rejects.
                setStatus(await writeToClipboardWithFeedback(navigator.clipboard, text));
            }}
        >
            {copyButtonLabel(status, label, t)}
        </Button>
    );
}
