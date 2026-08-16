import type { BrowserWindow } from 'electron';
import { clipboard, dialog, nativeImage, shell } from 'electron';

import { agentProviderCatalog } from '../shared/agents';
import { CaxriError } from '../shared/ipc/errors';
import type { MainRequest } from '../shared/ipc/methods';
import { themeImportExtensions } from '../shared/theme-import';
import { readArgvConfig, updateArgvConfig } from './argv-config';
import {
    deleteProjectPrompt,
    deleteSessionPrompt,
    externalLinkChoice,
    externalLinkPrompt,
    trashPrompt,
    unsavedChangesChoice,
    unsavedChangesPrompt,
} from './confirmations';
import { openExternalUrl } from './external-links';
import type { DesktopHostConnection } from './host-connection';
import type { ProcessExplorerWindowController } from './process-explorer-window';
import type { UpdateService } from './updates';
import type { createWorkbenchRootAuthority } from './workbench-root-authority';

interface MainMethodHandlerOptions {
    getProcessExplorer(): ProcessExplorerWindowController;
    getUserDataPath(): string;
    getSupervisor(): DesktopHostConnection;
    getUpdateService(): UpdateService;
    getWindow(): BrowserWindow | undefined;
    workbenchRootAuthority: ReturnType<typeof createWorkbenchRootAuthority>;
}

function assertNever(value: never): never {
    throw new CaxriError('INTERNAL', `Unhandled Main request: ${String(value)}`);
}

/**
 * Creates the Main-side handler for Desktop requests the Host forwards to Electron: native dialogs, Trash, screenshots,
 * and update control all need direct Electron API access the Host process lacks.
 */
export function createMainMethodHandler(options: MainMethodHandlerOptions) {
    async function handleExternalUrl(
        url: string,
        externalOptions: { allowTrust: boolean; window?: BrowserWindow },
    ) {
        const supervisor = options.getSupervisor();
        return openExternalUrl(
            url,
            {
                getTrustedDomains: async () =>
                    (await supervisor.request('settings.get')).value['security.trustedDomains'],
                prompt: async (parsed) => {
                    const messageBoxOptions = externalLinkPrompt(
                        parsed,
                        externalOptions.allowTrust,
                    );
                    const result = externalOptions.window
                        ? await dialog.showMessageBox(externalOptions.window, messageBoxOptions)
                        : await dialog.showMessageBox(messageBoxOptions);
                    return externalLinkChoice(result.response, externalOptions.allowTrust);
                },
                trust: async (domain) => {
                    await supervisor.request('settings.trustDomain', { domain });
                },
                open: (target) => shell.openExternal(target),
            },
            { allowTrust: externalOptions.allowTrust },
        );
    }

    return async function handleMainMethod(request: MainRequest): Promise<unknown> {
        const supervisor = options.getSupervisor();
        const mainWindow = options.getWindow();
        switch (request.method) {
            case 'argv.get':
                return { value: await readArgvConfig(options.getUserDataPath()) };
            case 'argv.update':
                return {
                    value: await updateArgvConfig(
                        options.getUserDataPath(),
                        request.params.changes,
                    ),
                };
            case 'external.open':
                return handleExternalUrl(request.params.url, {
                    allowTrust: true,
                    window: mainWindow,
                });
            case 'dialog.selectDirectory':
                return options.workbenchRootAuthority.selectProjectDirectory();
            case 'session.continueInWorktree':
                return options.workbenchRootAuthority.continueInWorktree(request.params);
            case 'session.authorizeWorkbenchRoot':
                return options.workbenchRootAuthority.authorizeSelection(request.params);
            case 'project.create':
                return options.workbenchRootAuthority.createProject(request.params);
            case 'project.cancelCreate':
                return options.workbenchRootAuthority.cancelProjectCreate(request.params);
            case 'files.trash': {
                const item = await supervisor.request('files.authorizeTrash', request.params);
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    trashPrompt({ ...item, hasUnsavedChanges: request.params.hasUnsavedChanges }),
                );
                if (result.response !== 0) return { canceled: true };
                /**
                 * Reauthorize after the native dialog so a replaced path cannot inherit approval.
                 */
                const current = await supervisor.request('files.authorizeTrash', request.params);
                if (
                    current.path !== item.path ||
                    current.device !== item.device ||
                    current.inode !== item.inode ||
                    current.root.path !== item.root.path ||
                    current.root.device !== item.root.device ||
                    current.root.inode !== item.root.inode
                )
                    throw new CaxriError(
                        'CONFLICT',
                        'File or folder changed before it reached Trash',
                    );
                /**
                 * Electron's Trash API is path-based, so authorization is repeated immediately before it.
                 */
                await shell.trashItem(current.path);
                return item;
            }
            case 'project.delete': {
                const { projectId } = request.params;
                const state = await supervisor.request('app.bootstrap');
                const sessions = state.sessions.filter(
                    (session) => session.projectId === projectId,
                );
                const counts = await Promise.all(
                    sessions.map((session) =>
                        supervisor.request('terminal.runningCount', { sessionId: session.id }),
                    ),
                );
                const count = counts.reduce((sum, value) => sum + value, 0);
                const projectTitle =
                    state.projects.find((project) => project.id === projectId)?.displayTitle ??
                    'this Project';
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    deleteProjectPrompt(projectTitle, count),
                );
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('project.delete', { projectId });
            }
            case 'session.delete': {
                const { sessionId } = request.params;
                const count = await supervisor.request('terminal.runningCount', { sessionId });
                const bootstrap = await supervisor.request('app.bootstrap');
                const sessionTitle =
                    bootstrap.sessions.find((session) => session.id === sessionId)?.displayTitle ??
                    'this Session';
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    deleteSessionPrompt(sessionTitle, count),
                );
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('session.delete', { sessionId });
            }
            case 'theme.import': {
                const result = await dialog.showOpenDialog(mainWindow!, {
                    title: 'Import Theme',
                    properties: ['openFile'],
                    filters: [
                        {
                            name: 'Theme files',
                            extensions: [...themeImportExtensions],
                        },
                    ],
                });
                const path = result.filePaths[0];
                return !path || result.canceled
                    ? null
                    : supervisor.request('theme.importPath', { path });
            }
            case 'app.openConfigFile': {
                const paths = await supervisor.request('config.paths');
                const path = paths[request.params.kind];
                if (!path) throw new CaxriError('NOT_FOUND', 'Unknown configuration file');
                const error = await shell.openPath(path);
                if (error) throw new CaxriError('IO', error);
                return null;
            }
            case 'editor.confirmDiscard': {
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    unsavedChangesPrompt(request.params.name),
                );
                return { choice: unsavedChangesChoice(result.response) };
            }
            case 'processExplorer.open':
                options.getProcessExplorer().open();
                return null;
            case 'bugReport.send': {
                const { report, screenshot, sessionId, terminalId } = request.params;
                const records = await supervisor.request('app.records', {
                    sessionIds: [],
                    terminalIds: [terminalId],
                });
                // `.find` (not index `[0]`) keeps the result typed as possibly missing: `app.records`
                // returns an empty array, not a guaranteed match, when the Terminal no longer exists.
                const terminal = records.terminals.find((candidate) => candidate.id === terminalId);
                if (!terminal) throw new CaxriError('NOT_FOUND', 'Agent Terminal not found');
                if (terminal.sessionId !== sessionId)
                    throw new CaxriError(
                        'CONFLICT',
                        'The selected Agent no longer belongs to this Session',
                    );
                if (!terminal.provider)
                    throw new CaxriError(
                        'CONFLICT',
                        'Bug reports can only be sent to an Agent Terminal',
                    );
                if (terminal.lastProcessState !== 'running' || terminal.processId === undefined)
                    throw new CaxriError('UNAVAILABLE', 'The selected Agent is no longer running');
                const imageInput = agentProviderCatalog[terminal.provider].imageInput;
                const isPasteImage = Boolean(screenshot && imageInput);
                if (isPasteImage && screenshot) {
                    const image = nativeImage.createFromDataURL(screenshot.dataUrl);
                    if (image.isEmpty())
                        throw new CaxriError(
                            'VALIDATION',
                            'Captured screenshot is not a valid image',
                        );
                    /**
                     * The user explicitly opted into screenshot delivery. Codex's supported image input reads the macOS
                     * clipboard, so disclose this replacement before Send.
                     */
                    clipboard.writeImage(image);
                }
                return supervisor.request('bugReport.deliver', {
                    pasteImage: isPasteImage,
                    report,
                    sessionId,
                    terminalId,
                });
            }
            case 'bugReport.captureScreenshot': {
                if (!mainWindow || mainWindow.isDestroyed())
                    throw new CaxriError('UNAVAILABLE', 'The Caxri window is not available');
                const image = await mainWindow.webContents.capturePage();
                const { height, width } = image.getSize();
                return {
                    dataUrl: `data:image/jpeg;base64,${image.toJPEG(80).toString('base64')}`,
                    height,
                    width,
                };
            }
            case 'diagnostics.export': {
                const result = await dialog.showSaveDialog(mainWindow!, {
                    title: 'Export Diagnostics',
                    defaultPath: `caxri-diagnostics-${new Date().toISOString().replaceAll(':', '-')}.zip`,
                    filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
                });
                if (result.canceled || !result.filePath) return null;
                return supervisor.request(
                    'diagnostics.exportPath',
                    { destination: result.filePath },
                    60_000,
                );
            }
            case 'updates.getState':
                return options.getUpdateService().getState();
            case 'updates.check':
                return options.getUpdateService().check();
            case 'updates.download':
                return options.getUpdateService().download();
            case 'updates.cancel':
                return options.getUpdateService().cancel();
            case 'updates.open':
                return options.getUpdateService().open();
        }
        return assertNever(request);
    };
}
