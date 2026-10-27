import { beforeEach, describe, expect, it, vi } from 'vitest';

const request = vi.fn();
const tryCommand = vi.fn<(label: string, run: () => Promise<unknown>) => Promise<unknown>>();

vi.mock('../../../stores/toasts', async (importOriginal) => ({
    ...(await importOriginal<object>()),
    tryCommand: (label: string, run: () => Promise<unknown>) => tryCommand(label, run),
}));
vi.mock('../../../lib/caxri', () => ({ caxri: { request } }));

const {
    agentChatTaskKey,
    interruptAgentChat,
    isAgentChatStopping,
    stopAgentChatTasks,
    useAgentChatStopStore,
    useAgentChatTaskStopStore,
} = await import('../agent-chat-commands');

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

describe('stopAgentChatTasks', () => {
    beforeEach(() => {
        request.mockReset();
        tryCommand.mockReset();
        useAgentChatTaskStopStore.setState({ stopping: new Set() });
    });

    it('requests a stop for every task and marks each one stopping', async () => {
        tryCommand.mockImplementation(async (_message, run: () => Promise<unknown>) => run());
        stopAgentChatTasks('t1', ['shell', 'helper']);
        expect(request.mock.calls).toEqual([
            ['agentChat.stopTask', { terminalId: 't1', taskId: 'shell' }],
            ['agentChat.stopTask', { terminalId: 't1', taskId: 'helper' }],
        ]);
        await Promise.resolve();
        expect(useAgentChatTaskStopStore.getState().stopping).toEqual(
            new Set([agentChatTaskKey('t1', 'shell'), agentChatTaskKey('t1', 'helper')]),
        );
    });

    it('skips a task whose stop is already pending', () => {
        tryCommand.mockReturnValue(new Promise(() => {}));
        useAgentChatTaskStopStore.setState({
            stopping: new Set([agentChatTaskKey('t1', 'shell')]),
        });
        stopAgentChatTasks('t1', ['shell', 'helper']);
        expect(tryCommand).toHaveBeenCalledTimes(1);
    });

    it('keeps the other tasks stopping when one request fails', async () => {
        tryCommand.mockImplementation(async (_message, run: () => Promise<unknown>) => {
            try {
                return await run();
            } catch {
                return;
            }
        });
        request.mockImplementation((_method: string, { taskId }: { taskId: string }) =>
            taskId === 'shell' ? Promise.reject(new Error('gone')) : Promise.resolve(),
        );
        stopAgentChatTasks('t1', ['shell', 'helper']);
        await vi.waitFor(() =>
            expect(useAgentChatTaskStopStore.getState().stopping).toEqual(
                new Set([agentChatTaskKey('t1', 'helper')]),
            ),
        );
    });
});
