import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    showConfirm: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.showConfirm } },
}));

import { stopCommanderFromWorkbench } from '../commander-stop-commands';

function answerStatus(state: string): void {
    mocks.request.mockImplementation((method: string) =>
        Promise.resolve(method === 'commander.status' ? { state } : null),
    );
}

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('stopCommanderFromWorkbench', () => {
    it('stops an idle Commander without asking', async () => {
        answerStatus('idle');

        await stopCommanderFromWorkbench();

        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.request).toHaveBeenCalledWith('agentCommander.stop');
    });

    it('asks before ending a running Commander turn and stops only once confirmed', async () => {
        answerStatus('working');
        mocks.showConfirm.mockResolvedValue(true);

        await stopCommanderFromWorkbench();

        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Stop the running turn?',
                confirmLabel: 'Stop and Close',
            }),
        );
        expect(mocks.request).toHaveBeenCalledWith('agentCommander.stop');
    });

    it('keeps a running Commander when the question is cancelled', async () => {
        answerStatus('working');
        mocks.showConfirm.mockResolvedValue(false);

        await stopCommanderFromWorkbench();

        expect(mocks.request).not.toHaveBeenCalledWith('agentCommander.stop');
    });
});
