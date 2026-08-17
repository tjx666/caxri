import { agentProviderCatalog } from '@shared/agents';

export const CODEX_IMAGE_PASTE_INPUT = agentProviderCatalog.codex.imageInput.terminalInput;

interface ClipboardDataLike {
    files: ArrayLike<{ type: string }>;
    items: ArrayLike<{ type: string }>;
    types: readonly string[];
}

/**
 * Detects an image-only browser paste before xterm discards its non-text clipboard payload.
 */
export function isClipboardContainingImage(data: ClipboardDataLike): boolean {
    return (
        data.types.some((type) => type.toLowerCase().startsWith('image/')) ||
        Array.from(data.files).some((file) => file.type.toLowerCase().startsWith('image/')) ||
        Array.from(data.items).some((item) => item.type.toLowerCase().startsWith('image/'))
    );
}

/**
 * Maps macOS editing gestures onto the control bytes supported by shells and Agent CLIs. Claude Code and Codex both
 * accept Meta+Enter (ESC+CR) as "insert newline" by default, so Shift+Enter — the chord VS Code and most chat inputs
 * train users on — is translated to ESC+CR without depending on a terminal's optional enhanced-keyboard protocol. Shell
 * Terminals are excluded: line editors treat a stray ESC as a mode/meta prefix, not a newline.
 */
export function terminalKeyboardInput(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'>,
    isAgent: boolean,
): string | undefined {
    if (event.type !== 'keydown') return undefined;
    if (
        isAgent &&
        event.key === 'Enter' &&
        event.shiftKey &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
    )
        return '\u{1B}\r';
    if (!event.metaKey || event.altKey || event.ctrlKey || event.shiftKey) return undefined;
    if (event.key === 'ArrowLeft') return '\u{1}';
    if (event.key === 'ArrowRight') return '\u{5}';
    return undefined;
}
