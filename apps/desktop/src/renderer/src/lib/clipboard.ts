import { caxri } from './caxri';

export interface ClipboardContent {
    text: string;
    /**
     * An HTML flavor written in the same clipboard item, so a spreadsheet pastes a table while an editor takes the
     * text.
     */
    html?: string;
}

/**
 * Writes to the system clipboard through Main. `navigator.clipboard` rejects with `NotAllowedError` whenever the
 * document lacks focus: a native context menu closes before the window hands focus back, and an OSC 52 copy can arrive
 * while another app is in front. Main's clipboard has no such requirement, so every Renderer copy goes through here
 * (see `clipboard.write`).
 *
 * The Process Explorer and Performance Monitor windows load their own preload without the `caxri` bridge. Their only
 * copy is the crash screen's button, clicked inside the focused document, so they keep the browser clipboard.
 */
export async function writeClipboardContent(content: ClipboardContent): Promise<void> {
    if (!hasCaxriBridge()) {
        /* eslint-disable no-restricted-syntax -- the bridgeless windows' only clipboard; see above */
        await (content.html === undefined
            ? navigator.clipboard.writeText(content.text)
            : navigator.clipboard.write([
                  new ClipboardItem({
                      'text/plain': new Blob([content.text], { type: 'text/plain' }),
                      'text/html': new Blob([content.html], { type: 'text/html' }),
                  }),
              ]));
        /* eslint-enable no-restricted-syntax */
        return;
    }
    await caxri.request('clipboard.write', content);
}

function hasCaxriBridge(): boolean {
    return (globalThis as { caxri?: unknown }).caxri !== undefined;
}

export function writeClipboardText(text: string): Promise<void> {
    return writeClipboardContent({ text });
}

/**
 * {@link writeClipboardText} in the `Clipboard` shape that `writeToClipboardWithFeedback` takes.
 */
export const textClipboard: Pick<Clipboard, 'writeText'> = { writeText: writeClipboardText };
