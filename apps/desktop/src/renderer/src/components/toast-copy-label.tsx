import { Check } from 'lucide-react';

import { useTranslation } from '../i18n';
import { useCopyFeedback } from '../stores/toast-copy-feedback';
import { copyButtonLabel } from './copy-feedback';

/**
 * The label of a copy follow-up button: its idle word, `Copied` with a check after a successful copy, or `Copy failed`.
 * Shared by the live toast and the notification center so both acknowledge the click in place.
 */
export function ToastCopyLabel({
    feedbackKey,
    idleLabel,
}: {
    feedbackKey: string;
    idleLabel: string;
}) {
    const { t } = useTranslation();
    const status = useCopyFeedback(feedbackKey);
    return (
        <span className="inline-flex items-center gap-1" role="status">
            {status === 'copied' && <Check size={12} aria-hidden />}
            {copyButtonLabel(status, idleLabel, t)}
        </span>
    );
}
