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
    canAcceptAgentInput(): boolean;
    container: HTMLElement;
    document: Document;
    getSelection(): string;
    imagePasteInput(): string | undefined;
    pasteImage(input: string): void;
    pasteText(text: string): boolean;
}

/**
 * Supplies xterm's internal selection to the browser's standard copy event. xterm renders text into a canvas-backed
 * surface rather than a native DOM selection, so Electron's Edit > Copy role needs this bridge to preserve Terminal
 * copying while sharing `Cmd+C` with Monaco and ordinary inputs.
 *
 * An empty xterm selection must still `preventDefault`. The focused helper textarea is empty, and Chromium's default
 * copy would write that empty string over the system clipboard — including a copy an Agent TUI just made through OSC 52
 * or the native pasteboard, whose highlight is not an xterm selection.
 */
export function writeTerminalSelectionToCopyEvent(
    event: ClipboardCopyEventLike,
    selection: string,
): void {
    if (selection) {
        if (!event.clipboardData) return;
        event.clipboardData.setData('text/plain', selection);
    }
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
 * Resolves image paste only while the Agent child is running and its provider catalog declares an input capability. An
 * idle Agent-associated Terminal leaves the native xterm paste path untouched for its surrounding shell.
 */
export function terminalImagePasteInput(
    data: ClipboardDataLike,
    capabilityInput: string | undefined,
    canAcceptAgentInput: boolean,
): string | undefined {
    return canAcceptAgentInput && capabilityInput && isClipboardContainingImage(data)
        ? capabilityInput
        : undefined;
}

/**
 * Registers the native copy bridge and provider-capability image-paste interception at their required DOM boundaries.
 * Electron's Edit
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
        const input = event.clipboardData
            ? terminalImagePasteInput(
                  event.clipboardData,
                  options.imagePasteInput(),
                  options.canAcceptAgentInput(),
              )
            : undefined;
        const text = event.clipboardData?.getData('text/plain') ?? '';
        if (!input && (!text || !options.pasteText(text))) return;
        /**
         * The provider owns image encoding and temp-file lifecycle; Caxri sends only its catalogued paste binding.
         */
        event.preventDefault();
        event.stopImmediatePropagation();
        if (input) options.pasteImage(input);
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
 * train users on — is translated to ESC+CR without depending on a terminal's optional enhanced-keyboard protocol. A
 * durable Agent association is insufficient: after its Agent child exits, the surrounding shell must receive ordinary
 * shell input because line editors treat a stray ESC as a mode/meta prefix, not a newline.
 */
export function terminalKeyboardInput(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'>,
    canAcceptAgentInput: boolean,
): string | undefined {
    if (event.type !== 'keydown') return undefined;
    if (
        canAcceptAgentInput &&
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

/**
 * Who handles a Command chord that reached the focused Terminal.
 *
 * - `caxri`: xterm never sees the key, so native menu roles (`Cmd+V` paste) and accelerators still fire.
 * - `select-all`: Caxri selects the Terminal buffer itself.
 * - `xterm`: xterm encodes the key as usual.
 */
export type TerminalCommandKeyOwner = 'caxri' | 'select-all' | 'xterm';

/**
 * Keeps Command chords with Caxri once an app enables the kitty keyboard protocol. Under that protocol xterm encodes
 * `Cmd+<character>` for the app and calls `preventDefault`, which would stop Electron's menu from pasting on `Cmd+V` or
 * running the other Command accelerators; a lone `Cmd` press would also be stopped before the link-hint modifier
 * listener sees it. The one exception follows Ghostty: `Cmd+C` without an xterm selection goes to the app, so a TUI
 * with its own selection (Codex's transcript) can copy it. `Cmd+A` keeps selecting the Terminal buffer, which xterm's
 * legacy encoding did and kitty encoding would forward instead. Command chords on non-character keys (Enter, Backspace,
 * arrows) keep their existing xterm handling.
 */
export function terminalCommandKeyOwner(
    event: Pick<KeyboardEvent, 'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey' | 'type'>,
    hasSelection: boolean,
): TerminalCommandKeyOwner {
    if (!event.metaKey) return 'xterm';
    if (event.key === 'Meta') return 'caxri';
    if (event.key.length !== 1) return 'xterm';
    const isPlainCommand = !event.altKey && !event.ctrlKey && !event.shiftKey;
    /**
     * Caps Lock reports the plain chord with an upper-case key.
     */
    const key = event.key.toLowerCase();
    if (!hasSelection && isPlainCommand && key === 'c') return 'xterm';
    if (isPlainCommand && key === 'a' && event.type === 'keydown') return 'select-all';
    return 'caxri';
}
