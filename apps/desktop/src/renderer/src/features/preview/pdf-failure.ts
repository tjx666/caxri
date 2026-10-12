import { isCaxriError, MAX_PREVIEW_DOCUMENT_BYTES } from '@caxri/protocol';
import { formatBytes } from '@caxri/utils';

import { translate } from '../../i18n';
import { describeDocumentReadFailure } from '../../lib/document-read-failure';
import type { DocumentLoadRecovery } from '../editor/document-load-recovery';
import { documentReadRecovery } from '../editor/document-load-recovery';

export interface PdfFailure {
    reason: string;
    tone: 'failed' | 'interrupted';
    /**
     * What the failure screen offers. A protected, damaged, or oversized PDF fails identically on every retry, so it
     * offers the application the operating system registers for PDFs; only a read failure keeps Retry.
     */
    recovery: DocumentLoadRecovery;
}

/**
 * The sentence a PDF preview shows when it cannot display the file, and the action that can still help.
 *
 * Pdf.js reports document problems by exception name rather than by a code, and the two a reader can act on are named
 * here. A read failure keeps the editor's wording, except the size ceiling, which is restated against the limit the
 * reader would compare with the file's size in Finder.
 *
 * Runs when the asynchronous load settles, outside render, so the sentence is translated as a snapshot.
 */
export function describePdfFailure(error: unknown): PdfFailure {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'PasswordException')
        return {
            reason: translate('preview.pdf.passwordProtected'),
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        };
    if (name === 'InvalidPDFException')
        return {
            reason: translate('preview.pdf.invalid'),
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        };
    if (isCaxriError(error) && error.code === 'CAPACITY')
        return {
            reason: translate('preview.pdf.tooLarge', {
                limit: formatBytes(MAX_PREVIEW_DOCUMENT_BYTES),
            }),
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        };
    return { ...describeDocumentReadFailure(error), recovery: documentReadRecovery(error) };
}
