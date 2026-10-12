import { themeImportExtensions } from '@caxri/protocol';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';

import { translateMain } from './locale';

/**
 * Native file dialog options for Main's own file pickers. Titles and filter names go through {@link translateMain}
 * because macOS shows them verbatim, so they follow `workbench.language` like the menu bar does.
 */
export function themeImportDialogOptions(): OpenDialogOptions {
    return {
        title: translateMain('desktop.themeImport.title'),
        properties: ['openFile'],
        filters: [
            {
                name: translateMain('desktop.themeImport.themeFiles'),
                extensions: [...themeImportExtensions, 'vsix'],
            },
            { name: translateMain('desktop.fileFilter.allFiles'), extensions: ['*'] },
        ],
    };
}

export function diagnosticsExportDialogOptions(now: Date): SaveDialogOptions {
    return {
        title: translateMain('desktop.diagnosticsExport.title'),
        defaultPath: `caxri-diagnostics-${now.toISOString().replaceAll(':', '-')}.zip`,
        filters: [
            { name: translateMain('desktop.diagnosticsExport.zipArchive'), extensions: ['zip'] },
        ],
    };
}
