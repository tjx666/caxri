import { CaxriError } from '@caxri/protocol';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ request: vi.fn<() => Promise<unknown>>() }));
vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.request } }));

import { isReopenableFile } from '../reopen-client';

describe('isReopenableFile', () => {
    it('reopens a file and rules out a folder', async () => {
        mocks.request.mockResolvedValueOnce('file');
        expect(await isReopenableFile('s', '/p/a.md')).toBe(true);
        mocks.request.mockResolvedValueOnce('directory');
        expect(await isReopenableFile('s', '/p/a.md')).toBe(false);
    });

    it('rules out only a missing file and leaves other refusals to the open', async () => {
        mocks.request.mockRejectedValueOnce(new CaxriError('NOT_FOUND', 'Gone'));
        expect(await isReopenableFile('s', '/p/a.md')).toBe(false);
        // A hard-linked dependency file: refused here, but `files.read` still opens it.
        mocks.request.mockRejectedValueOnce(new CaxriError('PATH_DENIED', 'Hard link'));
        expect(await isReopenableFile('s', '/p/node_modules/x/index.js')).toBe(true);
    });
});
