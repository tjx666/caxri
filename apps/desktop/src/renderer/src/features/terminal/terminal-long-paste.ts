import type { AgentProvider, AppSettings, TerminalLongPasteResult } from '@caxri/protocol';
import { agentProviderCatalog } from '@caxri/protocol';

/**
 * User settings cannot enable a summary integration that the provider does not implement.
 */
export function isProviderLongPasteEnabled(
    provider: AgentProvider | undefined,
    providers: AppSettings['agents.providers'],
): boolean {
    return provider
        ? agentProviderCatalog[provider].capabilities.pasteSummary &&
              providers[provider].pasteSummary.enabled
        : false;
}

export function shouldPrepareLongPaste(options: {
    canAcceptAgentInput: boolean;
    enabled: boolean;
    text: string;
    threshold: number;
}): boolean {
    return (
        options.canAcceptAgentInput && options.enabled && options.text.length > options.threshold
    );
}

export function formatLongPasteReference(
    result: Exclude<TerminalLongPasteResult, { status: 'passthrough' }>,
): string {
    const filePath = JSON.stringify(result.filePath);
    const lines = `${result.lineCount} ${result.lineCount === 1 ? 'line' : 'lines'}`;
    const characters = `${result.characterCount} ${result.characterCount === 1 ? 'character' : 'characters'}`;
    const header = [
        result.status === 'unavailable'
            ? '[Long paste saved locally; summary unavailable]'
            : '[Long paste saved locally]',
        `Original file: ${filePath}`,
        `Original size: ${lines}, ${characters}`,
    ];
    if (result.status === 'unavailable')
        return [...header, '', 'Read the original file for the exact content.'].join('\n');
    const summary = result.summary.replaceAll(/\r\n?/gu, '\n').trim();
    return [
        ...header,
        '',
        'Summary:',
        summary,
        '',
        'Read the original file for exact details.',
    ].join('\n');
}

interface TerminalLongPasteControllerOptions {
    canAcceptAgentInput(): boolean;
    enabled(): boolean;
    onFailure(): void;
    /**
     * Called when a paste arrives while a previous long paste is still being summarized. The controller deliberately
     * drops the new paste instead of queueing it, so this is the caller's only signal that user input was silently
     * discarded; wire it to a toast so the drop is not invisible.
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
 * owns the Terminal input gate until the summary or path-only fallback has been pasted in the same position.
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
                    if (this.options.canAcceptAgentInput()) this.options.paste(text);
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
                enabled: this.options.enabled(),
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
        const shouldClaimInput = this.options.canAcceptAgentInput() && this.options.enabled();
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
            if (this.options.enabled() && text.length > this.options.threshold()) {
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
    longPasteEnabled: boolean;
    longPasteThreshold: number;
    processState: string;
}

/**
 * Wires one controller to live pane state while keeping its Agent generation tag synchronous.
 */
export function createTerminalLongPasteRuntime(options: {
    latest: () => TerminalLongPasteRuntimeSnapshot;
    onDropped: () => void;
    onFailure: () => void;
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
            enabled: () => options.latest().longPasteEnabled,
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
