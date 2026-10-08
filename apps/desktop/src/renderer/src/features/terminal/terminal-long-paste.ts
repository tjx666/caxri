import type { TerminalLongPasteResult } from '@caxri/protocol';
import {
    isLongPasteWithinLimit,
    MAX_LONG_PASTE_BYTES,
    MAX_TERMINAL_INPUT_PAYLOAD_LENGTH,
} from '@caxri/protocol';

type LongPasteFailure = 'too-large' | 'native-too-large';

export function longPasteFailureMessage(reason?: LongPasteFailure): string {
    if (reason === 'too-large')
        return `Pasted text exceeds the ${MAX_LONG_PASTE_BYTES / 1_048_576} MiB limit. Your clipboard is unchanged. Save it to a file and share its path.`;
    if (reason === 'native-too-large')
        return 'This Agent cannot receive a paste this large. Your clipboard is unchanged. Save it to a file and share its path.';
    return 'Long paste could not be saved. Your clipboard is unchanged; try again or save it to a file.';
}

export function shouldPrepareLongPaste(options: {
    canAcceptAgentInput: boolean;
    text: string;
    threshold: number;
}): boolean {
    return options.canAcceptAgentInput && options.text.length > options.threshold;
}

/**
 * What the Agent sees in place of the pasted text.
 *
 * Caxri used to summarize the paste itself with a low-cost model call before the Agent saw anything, which held
 * Terminal input for the length of that call and left nothing behind when it timed out. The Agent is better placed to
 * decide what the text is worth: it can read the file, grep it, or hand it to a small-model subagent. So this says
 * where the file is, how big it is, and names the subagent route, and then gets out of the way.
 */
export function formatLongPasteReference(
    result: Exclude<TerminalLongPasteResult, { status: 'passthrough' }>,
): string {
    const lines = `${result.lineCount} ${result.lineCount === 1 ? 'line' : 'lines'}`;
    const characters = `${result.characterCount} ${result.characterCount === 1 ? 'character' : 'characters'}`;
    return [
        '[Long paste saved locally]',
        `Original file: ${JSON.stringify(result.filePath)}`,
        `Original size: ${lines}, ${characters}`,
        '',
        'Read the original file for the exact content.',
        'If a summary is enough, delegate it to a subagent on a small, fast model so the full text stays out of this conversation.',
    ].join('\n');
}

interface TerminalLongPasteControllerOptions {
    canAcceptAgentInput(): boolean;
    onFailure(reason?: LongPasteFailure): void;
    /**
     * Called when a paste arrives while a previous long paste is still being saved. The controller deliberately drops
     * the new paste instead of queueing it, so this is the caller's only signal that user input was silently discarded;
     * wire it to a toast so the drop is not invisible.
     */
    onDropped(): void;
    onPendingChange(isPending: boolean): void;
    paste(text: string): void;
    pasteAgentExact(text: string, expectedAgentLaunchId: string): void;
    request(content: string): Promise<TerminalLongPasteResult>;
    threshold(): number;
}

/**
 * Tags xterm's synchronous paste emission with the Agent generation that requested it.
 */
export class TerminalLongPasteInputRoute {
    private expectedLaunchId: string | undefined;

    readonly expectedAgentLaunchId = (): string | undefined => this.expectedLaunchId;

    readonly paste = (text: string, expectedLaunchId: string): void => {
        this.expectedLaunchId = expectedLaunchId;
        try {
            this.pasteText(text);
        } finally {
            this.expectedLaunchId = undefined;
        }
    };

    constructor(private readonly pasteText: (text: string) => void) {}
}

/**
 * Claims an eligible paste synchronously so xterm cannot send the original before the Server saves it. Pending work
 * owns the Terminal input gate until the file reference has been pasted in the same position.
 */
export class TerminalLongPasteController {
    private isDisposed = false;
    private isPendingValue = false;

    constructor(private readonly options: TerminalLongPasteControllerOptions) {}

    private releaseInput(): void {
        if (!this.isPendingValue) return;
        this.isPendingValue = false;
        if (!this.isDisposed) this.options.onPendingChange(false);
    }

    private async prepare(text: string): Promise<void> {
        try {
            if (!isLongPasteWithinLimit(text)) {
                if (!this.isDisposed) this.options.onFailure('too-large');
                return;
            }
            const result = await this.options.request(text);
            if (!this.isDisposed) {
                /**
                 * Release synchronously before `xterm.paste`: its `onData` callback consults this gate and would drop
                 * the replacement if it still looked pending. No browser input can interleave within this task.
                 */
                this.releaseInput();
                if (result.status === 'passthrough') {
                    /**
                     * Native paste is allowed only for a live, unsupported Agent, never after a preparation failure.
                     */
                    if (this.options.canAcceptAgentInput()) {
                        /**
                         * Reserve both six-character bracketed-paste markers emitted by xterm.
                         */
                        if (text.length > MAX_TERMINAL_INPUT_PAYLOAD_LENGTH - 12)
                            this.options.onFailure('native-too-large');
                        else this.options.paste(text);
                    }
                    return;
                }
                this.options.pasteAgentExact(
                    formatLongPasteReference(result),
                    result.agentLaunchId,
                );
            }
        } catch {
            if (!this.isDisposed) this.options.onFailure();
        } finally {
            this.releaseInput();
        }
    }

    isPending(): boolean {
        return this.isPendingValue;
    }

    intercept(text: string): boolean {
        if (this.isPendingValue) {
            this.options.onDropped();
            return true;
        }
        if (
            !shouldPrepareLongPaste({
                canAcceptAgentInput: this.options.canAcceptAgentInput(),
                text,
                threshold: this.options.threshold(),
            })
        )
            return false;
        this.isPendingValue = true;
        this.options.onPendingChange(true);
        // The DOM paste listener must return synchronously after claiming the event; this method owns both outcomes.
        // eslint-disable-next-line no-void -- `prepare` reports failures and releases the input gate
        void this.prepare(text);
        return true;
    }

    async pasteFromClipboard(readText: () => Promise<string>): Promise<void> {
        if (this.isPendingValue) {
            this.options.onDropped();
            return;
        }
        const shouldClaimInput = this.options.canAcceptAgentInput();
        if (!shouldClaimInput) {
            const text = await readText();
            if (text && !this.isDisposed) this.options.paste(text);
            return;
        }
        /**
         * Clipboard reads are asynchronous in Electron. Claim the input position before the await so a keypress cannot
         * overtake either an ordinary short paste or the long-paste replacement selected from the context menu.
         */
        this.isPendingValue = true;
        this.options.onPendingChange(true);
        try {
            const text = await readText();
            if (!text || this.isDisposed || !this.options.canAcceptAgentInput()) return;
            if (text.length > this.options.threshold()) {
                await this.prepare(text);
                return;
            }
            this.releaseInput();
            this.options.paste(text);
        } finally {
            this.releaseInput();
        }
    }

    dispose(): void {
        /**
         * Clear the Terminal-scoped UI state before disposal can suppress pending-change callbacks.
         */
        this.releaseInput();
        this.isDisposed = true;
    }
}

interface TerminalLongPasteRuntimeSnapshot {
    canAcceptAgentInput: boolean;
    longPasteThreshold: number;
    processState: string;
}

/**
 * Wires one controller to live pane state while keeping its Agent generation tag synchronous.
 */
export function createTerminalLongPasteRuntime(options: {
    latest: () => TerminalLongPasteRuntimeSnapshot;
    onDropped: () => void;
    onFailure: TerminalLongPasteControllerOptions['onFailure'];
    onPendingChange: (isPending: boolean, shouldDisableStdin: boolean) => void;
    paste: (text: string) => void;
    request: (content: string) => Promise<TerminalLongPasteResult>;
}): {
    controller: TerminalLongPasteController;
    expectedAgentLaunchId: () => string | undefined;
} {
    const input = new TerminalLongPasteInputRoute(options.paste);
    return {
        controller: new TerminalLongPasteController({
            canAcceptAgentInput: () => options.latest().canAcceptAgentInput,
            onDropped: options.onDropped,
            onFailure: options.onFailure,
            onPendingChange: (pending) =>
                options.onPendingChange(
                    pending,
                    pending || options.latest().processState !== 'running',
                ),
            paste: options.paste,
            pasteAgentExact: input.paste,
            request: options.request,
            threshold: () => options.latest().longPasteThreshold,
        }),
        expectedAgentLaunchId: input.expectedAgentLaunchId,
    };
}
