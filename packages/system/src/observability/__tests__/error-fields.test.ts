import { describe, expect, it } from 'vitest';

import { errorLogFields } from '../error-fields';

describe('errorLogFields', () => {
    it('describes an error by class, code, and size without its text', () => {
        const error = Object.assign(new TypeError('no such file /opt/example/owner/example'), {
            code: 'ENOENT',
        });

        const fields = errorLogFields(error);

        expect(fields).toMatchObject({
            errorName: 'TypeError',
            errorCode: 'ENOENT',
            errorMessageLength: error.message.length,
        });
        expect(JSON.stringify(fields)).not.toContain('example');
    });

    it('gives equal messages one id and drops codes and names that are not identifiers', () => {
        const first = errorLogFields({ code: 'see feature/example', message: 'same', name: 'a b' });

        expect(first.errorMessageId).toBe(errorLogFields(new Error('same')).errorMessageId);
        expect(first).toMatchObject({ errorCode: 'none', errorName: 'Unknown' });
        expect(errorLogFields('owner/example')).toMatchObject({
            errorName: 'Unknown',
            errorMessageLength: 13,
        });
    });
});
