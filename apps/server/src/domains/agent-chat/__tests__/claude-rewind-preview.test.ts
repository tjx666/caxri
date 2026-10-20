import { describe, expect, it, vi } from 'vitest';

import { previewClaudeRestore } from '../claude-rewind';

describe('previewClaudeRestore', () => {
    it('asks the SDK for a dry run and returns its files and totals', async () => {
        const rewindFiles = vi.fn().mockResolvedValue({
            canRewind: true,
            filesChanged: ['a.ts', 'b.ts'],
            insertions: 3,
            deletions: 2,
        });
        await expect(previewClaudeRestore({ rewindFiles }, 'u1')).resolves.toEqual({
            files: ['a.ts', 'b.ts'],
            insertions: 3,
            deletions: 2,
        });
        expect(rewindFiles).toHaveBeenCalledWith('u1', { dryRun: true });
    });

    it('omits totals the SDK did not report', async () => {
        const rewindFiles = vi.fn().mockResolvedValue({ canRewind: true });
        await expect(previewClaudeRestore({ rewindFiles }, 'u1')).resolves.toEqual({ files: [] });
    });

    it('fails with CONFLICT when the SDK has no checkpoint for the message', async () => {
        const rewindFiles = vi.fn().mockResolvedValue({ canRewind: false, error: 'No checkpoint' });
        await expect(previewClaudeRestore({ rewindFiles }, 'u1')).rejects.toMatchObject({
            code: 'CONFLICT',
        });
    });
});
