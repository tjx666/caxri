import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    showConfirm: vi.fn(),
}));

vi.mock('../../../lib/caxri', () => ({
    caxri: { request: mocks.request, window: { showConfirm: mocks.showConfirm } },
}));

import { stopBotFromWorkbench } from '../bot-stop-commands';

function answerStatus(state: string): void {
    mocks.request.mockImplementation((method: string) =>
        Promise.resolve(method === 'bot.status' ? { state } : null),
    );
}

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
});

describe('stopBotFromWorkbench', () => {
    it('stops an idle Caxri Bot without asking', async () => {
        answerStatus('idle');

        await stopBotFromWorkbench();

        expect(mocks.showConfirm).not.toHaveBeenCalled();
        expect(mocks.request).toHaveBeenCalledWith('caxriBot.stop');
    });

    it('asks before ending a running Caxri Bot turn and stops only once confirmed', async () => {
        answerStatus('working');
        mocks.showConfirm.mockResolvedValue(true);

        await stopBotFromWorkbench();

        expect(mocks.showConfirm).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'Stop the running turn?',
                confirmLabel: 'Stop and Close',
            }),
        );
        expect(mocks.request).toHaveBeenCalledWith('caxriBot.stop');
    });

    it('keeps a running Caxri Bot when the question is cancelled', async () => {
        answerStatus('working');
        mocks.showConfirm.mockResolvedValue(false);

        await stopBotFromWorkbench();

        expect(mocks.request).not.toHaveBeenCalledWith('caxriBot.stop');
    });
});
