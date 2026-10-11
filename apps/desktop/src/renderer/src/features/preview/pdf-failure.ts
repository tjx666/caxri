import { isCaxriError, MAX_PREVIEW_DOCUMENT_BYTES } from '@caxri/protocol';

import { describeDocumentReadFailure } from '../../lib/document-read-failure';

export interface PdfFailure {
    reason: string;
    tone: 'failed' | 'interrupted';
}

/**
 * The sentence a PDF preview shows when it cannot display the file.
 *
 * Pdf.js reports document problems by exception name rather than by a code, and the two a reader can act on are named
 * here. A read failure keeps the editor's wording, except the size ceiling, whose Server message is phrased in bytes:
 * it is restated in the units a reader would compare against the file's size in Finder.
 */
export function describePdfFailure(error: unknown): PdfFailure {
    const name = (error as { name?: unknown } | null)?.name;
    if (name === 'PasswordException')
        return {
            reason: 'This PDF is password-protected, and protected PDFs cannot be previewed yet.',
            tone: 'failed',
        };
    if (name === 'InvalidPDFException')
        return { reason: 'This file is not a valid PDF, or it is damaged.', tone: 'failed' };
    if (isCaxriError(error) && error.code === 'CAPACITY')
        return {
            reason: `This PDF is larger than the ${MAX_PREVIEW_DOCUMENT_BYTES / 1_048_576} MB preview limit.`,
            tone: 'failed',
        };
    return describeDocumentReadFailure(error);
}
