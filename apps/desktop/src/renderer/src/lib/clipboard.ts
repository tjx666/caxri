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
 */
export async function writeClipboardContent(content: ClipboardContent): Promise<void> {
    await caxri.request('clipboard.write', content);
}

export function writeClipboardText(text: string): Promise<void> {
    return writeClipboardContent({ text });
}

/**
 * {@link writeClipboardText} in the `Clipboard` shape that `writeToClipboardWithFeedback` takes.
 */
export const textClipboard: Pick<Clipboard, 'writeText'> = { writeText: writeClipboardText };
