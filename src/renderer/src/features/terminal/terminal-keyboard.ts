import { agentProviderCatalog } from '@shared/agents';

export const CODEX_IMAGE_PASTE_INPUT = agentProviderCatalog.codex.imageInput.terminalInput;

interface ClipboardDataLike {
    files: ArrayLike<{ type: string }>;
    items: ArrayLike<{ type: string }>;
    types: readonly string[];
}

/** Detects an image-only browser paste before xterm discards its non-text clipboard payload. */
export function clipboardContainsImage(data: ClipboardDataLike): boolean {
    return (
        data.types.some((type) => type.toLowerCase().startsWith('image/')) ||
        Array.from(data.files).some((file) => file.type.toLowerCase().startsWith('image/')) ||
        Array.from(data.items).some((item) => item.type.toLowerCase().startsWith('image/'))
    );
}

/**
 * Maps macOS editing gestures onto the control bytes supported by shells and Codex. Codex binds
 * Alt+Enter to newline by default, so Shift+Enter uses ESC+CR without depending on a terminal's
 * optional enhanced-keyboard protocol.
 */
export function terminalKeyboardInput(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'>,
    isCodex: boolean,
): string | undefined {
    if (event.type !== 'keydown') return undefined;
    if (
        isCodex &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
    )
        return '\x1b\r';
    if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return undefined;
    if (event.key === 'ArrowLeft') return '\x01';
    if (event.key === 'ArrowRight') return '\x05';
    return undefined;
}
