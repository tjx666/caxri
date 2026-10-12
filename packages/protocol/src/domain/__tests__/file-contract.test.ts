import { describe, expect, it } from 'vitest';

import { CaxriError, fromWireError, toWireError } from '../../transport/errors.js';
import { binaryFileReadError, isBinaryFileReadError } from '../file-contract.js';

describe('binary file read errors', () => {
    it('keeps the binary reason across the wire', () => {
        const received = fromWireError(toWireError(binaryFileReadError()));

        expect(received.code).toBe('IO');
        expect(isBinaryFileReadError(received)).toBe(true);
    });

    it('does not classify another IO failure as binary, whatever its message says', () => {
        expect(
            isBinaryFileReadError(
                new CaxriError('IO', 'Binary files cannot be opened in the editor'),
            ),
        ).toBe(false);
        expect(isBinaryFileReadError(new CaxriError('PATH_DENIED', 'denied'))).toBe(false);
        expect(isBinaryFileReadError(new Error('binary'))).toBe(false);
    });
});
