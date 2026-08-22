import { describe, expect, it } from 'vitest';

import { readFileForPoll } from './result-file-polling.ts';

function fileError(code: string): NodeJS.ErrnoException {
    return Object.assign(new Error(`read failed with ${code}`), { code });
}

describe('result file polling', () => {
    it('treats only a not-yet-created result file as pending', async () => {
        await expect(
            readFileForPoll(() => Promise.reject(fileError('ENOENT'))),
        ).resolves.toBeUndefined();
    });

    it.each(['EACCES', 'EISDIR', 'ERR_INVALID_ARG_VALUE', 'EIO'])(
        'propagates %s without turning the read failure into pending state',
        async (code) => {
            const error = fileError(code);

            await expect(readFileForPoll(() => Promise.reject(error))).rejects.toBe(error);
        },
    );

    it('returns the completed result without changing its contents', async () => {
        await expect(readFileForPoll(() => Promise.resolve('/project/file'))).resolves.toBe(
            '/project/file',
        );
    });
});
