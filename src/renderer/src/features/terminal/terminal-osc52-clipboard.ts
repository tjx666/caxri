import type { IBase64, IClipboardProvider } from '@xterm/addon-clipboard';

export const MAX_OSC52_ENCODED_LENGTH = 87_384;
export const MAX_OSC52_TEXT_CHARACTERS = 32_768;
export const OSC52_MIN_WRITE_INTERVAL_MS = 1_000;

interface ControlledOsc52ClipboardOptions {
    enabled: () => boolean;
    now?: () => number;
    onWriteFailure: () => void;
    writeClipboard: (text: string) => Promise<void>;
}

const strictBase64 = /^(?:[A-Za-z\d+/]{4})*(?:[A-Za-z\d+/]{2}==|[A-Za-z\d+/]{3}=)?$/u;

/**
 * Implements xterm's OSC 52 codec and provider as one fail-closed boundary. The addon otherwise
 * converts invalid base64 to an empty string and still calls `writeText`, which could silently clear
 * the system clipboard. Sharing one pending decoded value lets the provider distinguish a valid
 * empty-ish callback from any disabled, malformed, oversized, stale, or directly invoked write.
 */
export class ControlledOsc52Clipboard implements IBase64, IClipboardProvider {
    private failureReported = false;
    private lastWriteAt = Number.NEGATIVE_INFINITY;
    private pendingText: string | undefined;
    private readonly now: () => number;

    constructor(private readonly options: ControlledOsc52ClipboardOptions) {
        this.now = options.now ?? Date.now;
    }

    encodeText(data: string): string {
        const bytes = new TextEncoder().encode(data);
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        return btoa(binary);
    }

    decodeText(data: string): string {
        this.pendingText = undefined;
        if (
            !this.options.enabled() ||
            data.length === 0 ||
            data.length > MAX_OSC52_ENCODED_LENGTH ||
            data.length % 4 !== 0 ||
            !strictBase64.test(data)
        )
            return '';
        try {
            const binary = atob(data);
            const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
            const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            if (!text || text.length > MAX_OSC52_TEXT_CHARACTERS) return '';
            this.pendingText = text;
            return text;
        } catch {
            return '';
        }
    }

    /** OSC 52 report requests always receive an empty response without accessing the clipboard. */
    readText(): string {
        return '';
    }

    async writeText(selection: string, text: string): Promise<void> {
        const accepted = this.pendingText !== undefined && this.pendingText === text;
        this.pendingText = undefined;
        if (!accepted || !this.options.enabled() || selection !== 'c') return;
        const now = this.now();
        if (now - this.lastWriteAt < OSC52_MIN_WRITE_INTERVAL_MS) return;
        this.lastWriteAt = now;
        try {
            await this.options.writeClipboard(text);
        } catch {
            if (this.failureReported) return;
            this.failureReported = true;
            this.options.onWriteFailure();
        }
    }
}
