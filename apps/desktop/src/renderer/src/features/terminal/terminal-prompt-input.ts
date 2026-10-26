import { sendTerminalInput } from './terminal-commands';

/**
 * How long a queued line waits for the shell's first prompt before it is typed anyway. Shell integration only covers
 * zsh and bash, so another shell never reports a prompt; a slower rc file than this still loses the line.
 */
export const PROMPT_INPUT_FALLBACK_MS = 5000;

interface PendingInput {
    data: string;
    reject: (error: unknown) => void;
    resolve: () => void;
    timer: ReturnType<typeof setTimeout>;
}

const pendingInputs = new Map<string, PendingInput>();

/**
 * Types `data` into a Terminal that has just been created, once its shell first shows a prompt (`OSC 133;A`, see
 * {@link notifyTerminalPrompt}). Writing right after `terminal.create` resolves is lost: the shell's rc files run in the
 * meantime and the line editor discards what arrived before it started. Resolves once the input is written.
 */
export function sendTerminalInputAtPrompt(terminalId: string, data: string): Promise<void> {
    pendingInputs.get(terminalId)?.reject(new Error('Superseded by newer prompt input'));
    return new Promise((resolve, reject) => {
        pendingInputs.set(terminalId, {
            data,
            reject,
            resolve,
            timer: setTimeout(() => flush(terminalId), PROMPT_INPUT_FALLBACK_MS),
        });
    });
}

/**
 * Called by a Terminal pane each time its shell starts a prompt; writes the line queued for that Terminal, if any.
 */
export function notifyTerminalPrompt(terminalId: string): void {
    flush(terminalId);
}

function flush(terminalId: string): void {
    const pending = pendingInputs.get(terminalId);
    if (!pending) return;
    pendingInputs.delete(terminalId);
    clearTimeout(pending.timer);
    void write(terminalId, pending);
}

async function write(terminalId: string, pending: PendingInput): Promise<void> {
    try {
        await sendTerminalInput(terminalId, pending.data);
        pending.resolve();
    } catch (error) {
        pending.reject(error);
    }
}
