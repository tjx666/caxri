import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
const tryCommand = vi.fn<(label: string, run: () => Promise<unknown>) => Promise<unknown>>();

vi.mock('../../../stores/toasts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    tryCommand: (label: string, run: () => Promise<unknown>) => tryCommand(label, run),
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));

const { interruptAgentChat, isAgentChatStopping, useAgentChatStopStore } =
    await import('../agent-chat-commands');

describe('interruptAgentChat', () => {
    beforeEach(() => {
        request.mockReset();
        tryCommand.mockReset();
        useAgentChatStopStore.setState({ stopping: {} });
    });

    it('marks the turn as stopping and keeps it while the request is pending or succeeded', async () => {
        tryCommand.mockImplementation(async (_message, run: () => Promise<unknown>) => run());
        interruptAgentChat('t1', 'turn-1');
        expect(isAgentChatStopping(useAgentChatStopStore.getState().stopping, 't1', 'turn-1')).toBe(
            true,
        );
        await Promise.resolve();
        await Promise.resolve();
        expect(isAgentChatStopping(useAgentChatStopStore.getState().stopping, 't1', 'turn-1')).toBe(
            true,
        );
        expect(isAgentChatStopping(useAgentChatStopStore.getState().stopping, 't1', 'turn-2')).toBe(
            false,
        );
    });

    it('clears the stopping state when the request fails so Stop works again', async () => {
        tryCommand.mockResolvedValue(undefined);
        interruptAgentChat('t1', 'turn-1');
        await vi.waitFor(() =>
            expect(
                isAgentChatStopping(useAgentChatStopStore.getState().stopping, 't1', 'turn-1'),
            ).toBe(false),
        );
    });

    it('ignores a second request for the same turn while one is pending', () => {
        tryCommand.mockReturnValue(new Promise(() => {}));
        interruptAgentChat('t1', 'turn-1');
        interruptAgentChat('t1', 'turn-1');
        expect(tryCommand).toHaveBeenCalledTimes(1);
    });
});
