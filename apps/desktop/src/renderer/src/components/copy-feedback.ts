/**
 * Pure helpers behind the crash-screen "Copy details" button (`error-boundary.tsx`). The toast system is unmounted
 * inside the crash fallback (it lives in the tree the error boundary just replaced), so the button must acknowledge
 * success/failure itself instead of firing a toast. Extracted from the class component so the status transitions are
 * unit-testable without rendering React.
 */

import type { Translate } from '../i18n';
import type { ClipboardContent } from '../lib/clipboard';

export type CopyFeedbackStatus = 'idle' | 'copied' | 'failed';

/**
 * How long the "Copied" / "Copy failed" label stays before reverting to the idle label.
 */
export const COPY_FEEDBACK_RESET_MS = 2000;

/**
 * Writes `text` to the clipboard and resolves to the resulting feedback status instead of rejecting, so callers can
 * drive UI state with a single `.then` instead of a try/catch at each call site.
 */
export async function writeToClipboardWithFeedback(
    clipboard: Pick<Clipboard, 'writeText'>,
    text: string,
): Promise<CopyFeedbackStatus> {
    try {
        await clipboard.writeText(text);
        return 'copied';
    } catch {
        return 'failed';
    }
}

/**
 * Writes both a plain-text and an HTML flavor in one clipboard item, so the paste target picks the richer one it
 * understands: a spreadsheet takes the HTML table, a code editor or a Chat composer takes the text. Resolves to a
 * status like {@link writeToClipboardWithFeedback}.
 */
export async function writeRichToClipboardWithFeedback(
    write: (content: ClipboardContent) => Promise<void>,
    content: Required<ClipboardContent>,
): Promise<CopyFeedbackStatus> {
    try {
        await write(content);
        return 'copied';
    } catch {
        return 'failed';
    }
}

/**
 * Resolves the button's visible label for the current feedback status, falling back to the caller's idle-state label
 * (e.g. "Copy details"). A component passes its own `t`; the `translate` default serves the class-based crash screen
 * and DOM code outside React.
 */
export function copyButtonLabel(
    status: CopyFeedbackStatus,
    idleLabel: string,
    t: Translate,
): string {
    switch (status) {
        case 'copied':
            return t('common.copied');
        case 'failed':
            return t('core.copy.failed');
        case 'idle':
            return idleLabel;
    }
}
