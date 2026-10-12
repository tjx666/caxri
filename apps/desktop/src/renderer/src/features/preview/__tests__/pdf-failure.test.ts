import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { describePdfFailure } from '../pdf-failure';

/**
 * Stands in for pdf.js's exception classes, which the preview tells apart by `name` alone.
 */
class NamedError extends Error {
    constructor(name: string) {
        super('pdf.js detail');
        this.name = name;
    }
}

function namedError(name: string): Error {
    return new NamedError(name);
}

describe('describePdfFailure', () => {
    it('names the document problems a reader can act on', () => {
        expect(describePdfFailure(namedError('PasswordException'))).toEqual({
            reason: 'This PDF is password-protected, and protected PDFs cannot be previewed yet.',
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        });
        expect(describePdfFailure(namedError('InvalidPDFException'))).toEqual({
            reason: 'This file is not a valid PDF, or it is damaged.',
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        });
    });

    it('states the size ceiling in megabytes', () => {
        expect(
            describePdfFailure(new CaxriError('CAPACITY', 'Asset exceeds the 33554432 byte limit')),
        ).toEqual({
            reason: 'This PDF is larger than the 32.0 MB preview limit.',
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        });
    });

    it('keeps the editor wording for an ordinary read failure', () => {
        const failure = describePdfFailure(new CaxriError('NOT_FOUND', 'File not found'));

        expect(failure.tone).toBe('failed');
        expect(failure.reason).toMatch(/^Couldn't open this file/);
        // A missing file can come back, so a read failure keeps Retry.
        expect(failure.recovery).toBe('retry');
    });
});
