import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../i18n';
import { describePdfFailure, pdfPasswordPrompt } from '../pdf-failure';

/**
 * Stands in for pdf.js's exception classes, which the preview tells apart by `name` alone.
 */
class NamedError extends Error {
    constructor(
        name: string,
        readonly code?: number,
    ) {
        super('pdf.js detail');
        this.name = name;
    }
}

function namedError(name: string, code?: number): Error {
    return new NamedError(name, code);
}

describe('describePdfFailure', () => {
    it('names a damaged document', () => {
        expect(describePdfFailure(namedError('InvalidPDFException'), translate)).toEqual({
            reason: 'This file is not a valid PDF, or it is damaged.',
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        });
    });

    it('states the size ceiling in megabytes', () => {
        expect(
            describePdfFailure(
                new CaxriError('CAPACITY', 'Asset exceeds the 33554432 byte limit'),
                translate,
            ),
        ).toEqual({
            reason: 'This PDF is larger than the 32.0 MB preview limit.',
            tone: 'failed',
            recovery: 'openWithDefaultApp',
        });
    });

    it('keeps the editor wording for an ordinary read failure', () => {
        const failure = describePdfFailure(
            new CaxriError('NOT_FOUND', 'File not found'),
            translate,
        );

        expect(failure.tone).toBe('failed');
        expect(failure.reason).toMatch(/^Couldn't open this file/);
        // A missing file can come back, so a read failure keeps Retry.
        expect(failure.recovery).toBe('retry');
    });
});

describe('pdfPasswordPrompt', () => {
    const needPassword = namedError('PasswordException', 1);
    const incorrectPassword = namedError('PasswordException', 2);

    it('asks for a password instead of failing', () => {
        expect(pdfPasswordPrompt(needPassword, 'open', 1)).toEqual({
            status: 'password',
            isIncorrect: false,
            attempt: 1,
        });
        expect(pdfPasswordPrompt(needPassword, 'disk', 2)?.isIncorrect).toBe(false);
    });

    it('reports a wrong password only for the attempt the reader just made', () => {
        expect(pdfPasswordPrompt(incorrectPassword, 'password', 3)).toEqual({
            status: 'password',
            isIncorrect: true,
            attempt: 3,
        });
        // The file was rewritten with another password: the remembered one is stale, not mistyped.
        expect(pdfPasswordPrompt(incorrectPassword, 'disk', 4)?.isIncorrect).toBe(false);
    });

    it('leaves every other error to describePdfFailure', () => {
        expect(pdfPasswordPrompt(namedError('InvalidPDFException'), 'password', 1)).toBeUndefined();
        expect(pdfPasswordPrompt(undefined, 'open', 1)).toBeUndefined();
    });
});
