import { describe, expect, it, vi } from 'vitest';

import { isDirectoryEntry, resolveEntryKind } from './file-entry';

const { request } = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock('./caxri', () => ({ caxri: { request } }));

describe('isDirectoryEntry', () => {
    it('resolves an unprobed link at activation instead of treating it as a file', async () => {
        request.mockResolvedValueOnce('directory');
        await expect(
            resolveEntryKind('session-1', { kind: 'symlink', path: '/project/link' }),
        ).resolves.toBe('directory');
        expect(request).toHaveBeenCalledWith('files.resolveKind', {
            sessionId: 'session-1',
            path: '/project/link',
        });
    });
    it('follows known directory links and keeps unresolved and file links as leaves', () => {
        expect(isDirectoryEntry({ kind: 'directory' })).toBe(true);
        expect(isDirectoryEntry({ kind: 'symlink', linkKind: 'directory' })).toBe(true);
        expect(isDirectoryEntry({ kind: 'symlink', linkKind: 'file' })).toBe(false);
        expect(isDirectoryEntry({ kind: 'symlink', linkKind: 'broken' })).toBe(false);
        expect(isDirectoryEntry({ kind: 'symlink' })).toBe(false);
        expect(isDirectoryEntry({ kind: 'file' })).toBe(false);
    });
});
