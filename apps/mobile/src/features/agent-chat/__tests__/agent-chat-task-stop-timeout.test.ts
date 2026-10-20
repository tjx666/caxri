import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    AGENT_CHAT_TASK_STOP_TIMEOUT_MS,
    AgentChatTaskStopTimeouts,
} from '../agent-chat-task-stop-timeout';

describe('AgentChatTaskStopTimeouts', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('fires once after the timeout', () => {
        const onTimeout = vi.fn();
        const timeouts = new AgentChatTaskStopTimeouts(onTimeout);
        timeouts.start('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS - 1);
        expect(onTimeout).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS * 2);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('does not fire after the task settles', () => {
        const onTimeout = vi.fn();
        const timeouts = new AgentChatTaskStopTimeouts(onTimeout);
        timeouts.start('a');
        timeouts.settle('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS * 2);
        expect(onTimeout).not.toHaveBeenCalled();
    });

    it('does not fire after dispose and tracks tasks independently', () => {
        const onTimeout = vi.fn();
        const timeouts = new AgentChatTaskStopTimeouts(onTimeout);
        timeouts.start('a');
        timeouts.start('b');
        timeouts.settle('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS);
        expect(onTimeout).toHaveBeenCalledExactlyOnceWith('b');
        timeouts.start('c');
        timeouts.dispose();
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS);
        expect(onTimeout).toHaveBeenCalledTimes(1);
    });

    it('restarts the timer when a task is stopped again', () => {
        const onTimeout = vi.fn();
        const timeouts = new AgentChatTaskStopTimeouts(onTimeout);
        timeouts.start('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS - 1);
        timeouts.start('a');
        vi.advanceTimersByTime(AGENT_CHAT_TASK_STOP_TIMEOUT_MS - 1);
        expect(onTimeout).not.toHaveBeenCalled();
    });
});
