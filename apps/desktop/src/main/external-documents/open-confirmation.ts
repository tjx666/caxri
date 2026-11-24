import { basename, dirname } from 'node:path';

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
    const folder = dirname(path);
    const decisions: readonly ExternalOpenDecision[] = ['open', 'trust', 'copy', 'cancel'];
    const options: Electron.MessageBoxOptions = {
        type: 'question',
        title: translateMain('desktop.externalFile.title'),
        message: translateMain('desktop.externalFile.message', { name: basename(path) }),
        detail: translateMain(
            isHtmlPreviewPath(path)
                ? 'desktop.externalFile.htmlDetail'
                : 'desktop.externalFile.detail',
            { path, folder },
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
