import type { IBase64, IClipboardProvider } from '@xterm/addon-clipboard';

export const MAX_OSC52_ENCODED_LENGTH = 87_384;
export const MAX_OSC52_TEXT_CHARACTERS = 32_768;
export const OSC52_MIN_WRITE_INTERVAL_MS = 1_000;
/**
 * Minimum gap between `onBlocked` notifications for one reason, so a chatty or hostile program hammering OSC 52 cannot
 * turn one blocked category into a wall of toasts.
 */
export const OSC52_NOTIFICATION_THROTTLE_MS = 5_000;

/**
 * Distinct, user-facing categories for a write that never reached the system clipboard.
 */
export type Osc52BlockReason = 'disabled' | 'malformed' | 'oversized' | 'rate-limited';

interface ControlledOsc52ClipboardOptions {
    enabled: () => boolean;
    now?: () => number;
    /**
     * Fires (throttled) when a write is deliberately blocked by policy rather than failing.
     */
    onBlocked: (reason: Osc52BlockReason) => void;
    onWriteFailure: (error: unknown) => void;
    writeClipboard: (text: string) => Promise<void>;
}

const strictBase64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

/**
 * Implements xterm's OSC 52 codec and provider as one fail-closed boundary. The addon otherwise converts invalid base64
 * to an empty string and still calls `writeText`, which could silently clear the system clipboard. Sharing one pending
 * decoded value lets the provider distinguish a valid empty-ish callback from any disabled, malformed, oversized,
 * stale, or directly invoked write.
 */
export class ControlledOsc52Clipboard implements IBase64, IClipboardProvider {
    private failureReported = false;
    private lastBlockNotifiedAt = new Map<Osc52BlockReason, number>();
    private lastWriteAt = -Infinity;
    private pendingText: string | undefined;
    private readonly now: () => number;

    constructor(private readonly options: ControlledOsc52ClipboardOptions) {
        this.now = options.now ?? Date.now;
    }

    /**
     * Throttled per reason, not globally: a burst of one kind still collapses to a single notice, which is the actual
     * anti-spam goal, but four genuinely different explanations are not merged into whichever happened to fire first.
     * That matters most for `disabled`, the only reason with a concrete next step ("turn the setting on"): a global
     * throttle could let a chatty program's oversized writes suppress it until the program stopped, at which point it
     * never appeared.
     */
    private notifyBlocked(reason: Osc52BlockReason): void {
        const now = this.now();
        const previous = this.lastBlockNotifiedAt.get(reason) ?? -Infinity;
        if (now - previous < OSC52_NOTIFICATION_THROTTLE_MS) return;
        this.lastBlockNotifiedAt.set(reason, now);
        this.options.onBlocked(reason);
    }

    encodeText(data: string): string {
        const bytes = new TextEncoder().encode(data);
        let binary = '';
        for (const byte of bytes) binary += String.fromCodePoint(byte);
        return btoa(binary);
    }

    decodeText(data: string): string {
        this.pendingText = undefined;
        if (!this.options.enabled()) {
            /**
             * A zero-length request is a frequent no-op ping from some shells; only a genuine payload while disabled is
             * worth telling the user about.
             */
            if (data.length > 0) this.notifyBlocked('disabled');
            return '';
        }
        if (data.length === 0) return '';
        if (data.length > MAX_OSC52_ENCODED_LENGTH) {
            this.notifyBlocked('oversized');
            return '';
        }
        if (data.length % 4 !== 0 || !strictBase64.test(data)) {
            this.notifyBlocked('malformed');
            return '';
        }
        try {
            const binary = atob(data);
            const bytes = Uint8Array.from(binary, (character) => character.codePointAt(0) ?? 0);
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!text) return '';
            if (text.length > MAX_OSC52_TEXT_CHARACTERS) {
                this.notifyBlocked('oversized');
                return '';
            }
            this.pendingText = text;
            return text;
        } catch {
            this.notifyBlocked('malformed');
            return '';
        }
    }

    /**
     * OSC 52 report requests always receive an empty response without accessing the clipboard.
     */
    readText(): string {
        return '';
    }

    async writeText(selection: string, text: string): Promise<void> {
        const isAccepted = this.pendingText !== undefined && this.pendingText === text;
        this.pendingText = undefined;
        if (selection !== 'c' || !isAccepted || !this.options.enabled()) return;
        const now = this.now();
        if (now - this.lastWriteAt < OSC52_MIN_WRITE_INTERVAL_MS) {
            this.notifyBlocked('rate-limited');
            return;
        }
        this.lastWriteAt = now;
        try {
            await this.options.writeClipboard(text);
        } catch (error) {
            if (this.failureReported) return;
            this.failureReported = true;
            this.options.onWriteFailure(error);
        }
    }
}
