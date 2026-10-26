import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sendTerminalInput: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('../terminal-commands', () => ({ sendTerminalInput: mocks.sendTerminalInput }));

import {
    notifyTerminalPrompt,
    PROMPT_INPUT_FALLBACK_MS,
    sendTerminalInputAtPrompt,
} from '../terminal-prompt-input';

describe('sendTerminalInputAtPrompt', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        mocks.sendTerminalInput.mockClear();
    });
    afterEach(() => vi.useRealTimers());

    it('holds the input until the shell first shows a prompt, then writes it once', async () => {
        const sent = sendTerminalInputAtPrompt('terminal-1', 'ls\r');
        notifyTerminalPrompt('terminal-other');
        expect(mocks.sendTerminalInput).not.toHaveBeenCalled();

        notifyTerminalPrompt('terminal-1');
        await sent;
        notifyTerminalPrompt('terminal-1');

        expect(mocks.sendTerminalInput).toHaveBeenCalledTimes(1);
        expect(mocks.sendTerminalInput).toHaveBeenCalledWith('terminal-1', 'ls\r');
    });

    it('writes anyway when a shell without integration never reports a prompt', async () => {
        const sent = sendTerminalInputAtPrompt('terminal-2', 'pwd\r');
        vi.advanceTimersByTime(PROMPT_INPUT_FALLBACK_MS - 1);
        expect(mocks.sendTerminalInput).not.toHaveBeenCalled();

        vi.advanceTimersByTime(1);
        await sent;

        expect(mocks.sendTerminalInput).toHaveBeenCalledWith('terminal-2', 'pwd\r');
    });
});
