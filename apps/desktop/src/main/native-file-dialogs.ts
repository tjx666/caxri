import type { ProjectTransferExportResult } from '@caxri/protocol';
import { themeImportExtensions } from '@caxri/protocol';
import type { BrowserWindow, Dialog, OpenDialogOptions, SaveDialogOptions } from 'electron';

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

/**
 * The Chat composer's `+` → Files and folders: files and folders together, several at once.
 */
export function agentChatPathPickerOptions(): OpenDialogOptions {
    return {
        title: translateMain('desktop.chooseChatFilesAndFolders'),
        properties: ['openFile', 'openDirectory', 'multiSelections'],
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

function projectTransferExportDialogOptions(now: Date): SaveDialogOptions {
    return {
        title: translateMain('desktop.projectTransfer.exportTitle'),
        defaultPath: `caxri-projects-${now.toISOString().slice(0, 10)}.json`,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
        filters: [
            { name: translateMain('desktop.projectTransfer.jsonFile'), extensions: ['json'] },
        ],
    };
}

export function projectTransferImportDialogOptions(): OpenDialogOptions {
    return {
        title: translateMain('desktop.projectTransfer.importTitle'),
        properties: ['openFile'],
        filters: [
            { name: translateMain('desktop.projectTransfer.jsonFile'), extensions: ['json'] },
            { name: translateMain('desktop.fileFilter.allFiles'), extensions: ['*'] },
        ],
    };
}

/**
 * Save dialog for a Benchmark share card; `fileName` is the suggested name, already reduced to a base name by the
 * caller.
 */
export function benchmarkShareImageDialogOptions(fileName: string): SaveDialogOptions {
    return {
        title: translateMain('desktop.benchmarkShare.title'),
        defaultPath: fileName,
        filters: [{ name: translateMain('desktop.benchmarkShare.pngImage'), extensions: ['png'] }],
    };
}

/**
 * Save As for an untitled Editor buffer. `defaultPath` is the Renderer's suggestion (the Session's Project folder and a
 * name drawn from the first line); the user confirms or replaces it, and macOS asks before overwriting.
 */
export function untitledEditorSaveDialogOptions(defaultPath: string): SaveDialogOptions {
    return {
        title: translateMain('desktop.untitledSave.title'),
        defaultPath,
        properties: ['createDirectory', 'showOverwriteConfirmation'],
    };
}

/**
 * Asks where to save a Projects and Sessions export and has Server Core write it there. Shared by the Project menu
 * command and the data-reset update prompt; resolves `null` when the user cancels the save panel.
 */
export async function exportProjectsAndSessions(input: {
    dialog: Pick<Dialog, 'showSaveDialog'>;
    exportPath(destination: string): Promise<ProjectTransferExportResult>;
    window: BrowserWindow | undefined;
}): Promise<ProjectTransferExportResult | null> {
    const options = projectTransferExportDialogOptions(new Date());
    const result = await (input.window
        ? input.dialog.showSaveDialog(input.window, options)
        : input.dialog.showSaveDialog(options));
    if (result.canceled || !result.filePath) return null;
    return input.exportPath(result.filePath);
}
