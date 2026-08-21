import { agentProviderCatalog } from '@shared/agents';

export const CODEX_IMAGE_PASTE_INPUT = agentProviderCatalog.codex.imageInput.terminalInput;

interface ClipboardDataLike {
    files: ArrayLike<{ type: string }>;
    items: ArrayLike<{ type: string }>;
    types: readonly string[];
}

interface ClipboardCopyEventLike {
    clipboardData: Pick<DataTransfer, 'setData'> | null;
    preventDefault(): void;
}

interface TerminalClipboardHandlerOptions {
    container: HTMLElement;
    document: Document;
    getSelection(): string;
    isCodex(): boolean;
    pasteCodexImage(input: string): void;
}

/**
 * Supplies xterm's internal selection to the browser's standard copy event. xterm renders text into a canvas-backed
 * surface rather than a native DOM selection, so Electron's Edit > Copy role needs this bridge to preserve Terminal
 * copying while sharing `Cmd+C` with Monaco and ordinary inputs.
 */
export function writeTerminalSelectionToCopyEvent(
    event: ClipboardCopyEventLike,
    selection: string,
): void {
    if (!selection || !event.clipboardData) return;
    event.clipboardData.setData('text/plain', selection);
    event.preventDefault();
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
 * Registers the native copy bridge and Codex image-paste interception at their required DOM boundaries. Electron's Edit
 *
 * > Copy role targets `document`, while xterm's paste event targets its container; keeping both listeners here makes
 * > their focus and disposal rules a single lifecycle contract.
 */
export function registerTerminalClipboardHandlers(
    options: TerminalClipboardHandlerOptions,
): () => void {
    const { container, document } = options;
    const handleCopy = (event: ClipboardEvent): void => {
        if (!container.contains(document.activeElement)) return;
        writeTerminalSelectionToCopyEvent(event, options.getSelection());
    };
    const handlePaste = (event: ClipboardEvent): void => {
        if (
            !options.isCodex() ||
            !event.clipboardData ||
            !isClipboardContainingImage(event.clipboardData)
        )
            return;
        /**
         * Codex owns image encoding and temp-file lifecycle; it only needs its Ctrl+V binding.
         */
        event.preventDefault();
        event.stopImmediatePropagation();
        options.pasteCodexImage(CODEX_IMAGE_PASTE_INPUT);
    };
    document.addEventListener('copy', handleCopy, { capture: true });
    container.addEventListener('paste', handlePaste, { capture: true });
    return () => {
        document.removeEventListener('copy', handleCopy, true);
        container.removeEventListener('paste', handlePaste, true);
    };
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
