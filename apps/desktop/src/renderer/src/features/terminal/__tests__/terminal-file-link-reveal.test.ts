import { CaxriError } from '@caxri/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    caxriRequest: vi.fn((): Promise<unknown> => Promise.resolve({ revealed: true })),
    pushToast: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({ caxri: { request: mocks.caxriRequest } }));
vi.mock('../../../stores/toasts', () => ({
    describeFailureKey: (error: unknown) => `failed: ${String(error)}`,
    pushToast: mocks.pushToast,
}));

import { revealTerminalFileTarget } from '../terminal-file-link-reveal';

const notFound = () => Promise.reject(new CaxriError('NOT_FOUND', 'missing'));

beforeEach(() => {
    mocks.caxriRequest.mockReset();
    mocks.caxriRequest.mockResolvedValue({ revealed: true });
    mocks.pushToast.mockClear();
});

describe('revealTerminalFileTarget', () => {
    it('asks Main to reveal the cited path and reports nothing on success', async () => {
        await revealTerminalFileTarget('terminal-1', 'src/app.ts');

        expect(mocks.caxriRequest).toHaveBeenCalledWith('terminal.revealFileLink', {
            terminalId: 'terminal-1',
            target: 'src/app.ts',
        });
        expect(mocks.pushToast).not.toHaveBeenCalled();
    });

    it('says why nothing was revealed when several Projects match', async () => {
        mocks.caxriRequest.mockResolvedValueOnce({
            status: 'ambiguous',
            candidates: [],
            truncated: false,
        });

        await revealTerminalFileTarget('terminal-1', 'app.ts');

        expect(mocks.pushToast).toHaveBeenCalledWith('error', expect.stringContaining('app.ts'));
    });

    it('retries once with the file the conversation touched when the citation resolves nowhere', async () => {
        mocks.caxriRequest.mockImplementationOnce(notFound);

        await revealTerminalFileTarget('terminal-1', 'plan.md', {
            fallbackTarget: () => ({ path: '/tmp/work/plan.md' }),
        });

        expect(mocks.caxriRequest).toHaveBeenLastCalledWith('terminal.revealFileLink', {
            terminalId: 'terminal-1',
            target: '/tmp/work/plan.md',
        });
        expect(mocks.pushToast).not.toHaveBeenCalled();
    });

    it('reports a miss instead of revealing a guess among several touched files', async () => {
        mocks.caxriRequest.mockImplementationOnce(notFound);

        await revealTerminalFileTarget('terminal-1', 'plan.md', {
            fallbackTarget: () => ({ candidates: ['/a/plan.md', '/b/plan.md'] }),
        });

        expect(mocks.caxriRequest).toHaveBeenCalledTimes(1);
        expect(mocks.pushToast).toHaveBeenCalledWith('error', expect.stringContaining('plan.md'));
    });

    it('reports a path that resolves nowhere and has no fallback', async () => {
        mocks.caxriRequest.mockImplementationOnce(notFound);

        await revealTerminalFileTarget('terminal-1', 'missing.ts');

        expect(mocks.pushToast).toHaveBeenCalledWith(
            'error',
            expect.stringContaining('missing.ts'),
        );
    });
});
