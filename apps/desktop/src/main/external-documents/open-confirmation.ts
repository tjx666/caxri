import { isHtmlPreviewPath } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { clipboard, dialog } from 'electron';

import { translateMain } from '../locale';

/**
 * The button the user chose in the external-file confirmation.
 */
export type ExternalOpenDecision = 'cancel' | 'copy' | 'open' | 'trust';

/**
 * Asks before reading a file outside every Project. Copy Path answers the click that only wanted the address, to paste
 * into a Terminal or another tool: it puts the absolute path on the clipboard and opens nothing, like Cancel.
 */
export async function confirmExternalOpen(
    window: BrowserWindow | undefined,
    path: string,
): Promise<ExternalOpenDecision> {
    const decisions: readonly ExternalOpenDecision[] = ['open', 'trust', 'copy', 'cancel'];
    const isPage = isHtmlPreviewPath(path);
    const message = translateMain(
        isPage ? 'desktop.externalFile.htmlMessage' : 'desktop.externalFile.message',
    );
    /*
     * One short line each (DESIGN.md, Confirmations): with four buttons the alert is narrow, and any wrapped or second
     * line, a path or a file name included, flips macOS 26 to the left-aligned layout. The user just clicked the link,
     * so the dialog names only the consequence; Copy Path still hands over the full address.
     */
    const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: message,
        message,
        detail: translateMain(
            isPage ? 'desktop.externalFile.htmlDetail' : 'desktop.externalFile.detail',
        ),
        buttons: [
            translateMain('desktop.dialog.open'),
            translateMain('desktop.externalFile.trustFolder'),
            translateMain('desktop.externalFile.copyPath'),
            translateMain('desktop.dialog.cancel'),
        ],
        defaultId: 0,
        cancelId: 3,
        noLink: true,
    };
    const result = await (window
        ? dialog.showMessageBox(window, options)
        : dialog.showMessageBox(options));
    const decision = decisions[result.response] ?? 'cancel';
    if (decision === 'copy') await clipboard.writeText(path);
    return decision;
}
