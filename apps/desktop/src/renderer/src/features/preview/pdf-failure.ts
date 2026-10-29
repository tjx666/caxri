import { isCaxriError, MAX_PREVIEW_DOCUMENT_BYTES } from '@caxri/protocol';
import { formatBytes } from '@caxri/utils';

import type { Translate } from '../../i18n';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import type { DocumentLoadRecovery } from '../editor/document-load-recovery';
import { documentReadRecovery } from '../editor/document-load-recovery';
import type { PdfReadCause } from './pdf-reload';

export interface PdfFailure {
    reason: string;
    tone: 'failed' | 'interrupted';
    /**
     * What the failure screen offers. A damaged or oversized PDF fails identically on every retry, so it offers the
     * application the operating system registers for PDFs; only a read failure keeps Retry.
     */
    recovery: DocumentLoadRecovery;
}

/**
 * The sentence a PDF preview shows when it cannot display the file, and the action that can still help.
 *
 * Pdf.js reports document problems by exception name rather than by a code. A password-protected PDF is not a failure
 * (see {@link pdfPasswordPrompt}); a damaged one is named here. A read failure keeps the editor's wording, except the
 * size ceiling, which is restated against the limit the reader would compare with the file's size in Finder.
 *
 * Runs during render from the stored error, so the sentence follows a runtime language switch.
 */
export function describePdfFailure(error: unknown, t: Translate): PdfFailure {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'InvalidPDFException')
        return {
            reason: t('preview.pdf.invalid'),
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        };
    if (isCaxriError(error) && error.code === 'CAPACITY')
        return {
            reason: t('preview.pdf.tooLarge', {
                limit: formatBytes(MAX_PREVIEW_DOCUMENT_BYTES),
            }),
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        };
    return { ...describeDocumentReadFailure(error, t), recovery: documentReadRecovery(error) };
}

/**
 * Pdf.js's `PasswordResponses.INCORRECT_PASSWORD`, the `code` of a `PasswordException` raised for a wrong password
 * rather than a missing one (`NEED_PASSWORD`, 1). Restated so this module stays free of the pdf.js runtime.
 */
const INCORRECT_PASSWORD = 2;

/**
 * The password form a protected PDF shows instead of a failure. `attempt` identifies the read that asked, so the form
 * refocuses its field after each rejected password.
 */
export interface PdfPasswordPrompt {
    status: 'password';
    /**
     * The password the reader just entered was wrong. A remembered password that no longer opens the file (it was
     * rewritten on disk with another one) asks again without the error, because the reader typed nothing wrong.
     */
    isIncorrect: boolean;
    attempt: number;
}

/**
 * The password form for a read that pdf.js refused for want of the right password, or `undefined` for any other error.
 */
export function pdfPasswordPrompt(
    error: unknown,
    cause: PdfReadCause,
    attempt: number,
): PdfPasswordPrompt | undefined {
    const exception = error as { name?: unknown; code?: unknown } | null;
    if (exception?.name !== 'PasswordException') return undefined;
    return {
        status: 'password',
        isIncorrect: cause === 'password' && exception.code === INCORRECT_PASSWORD,
        attempt,
    };
}
