import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type {
    ArgvConfig,
    ArgvConfigChanges,
    MainRequest,
    RemoteDebuggingState,
    ServerEvent,
    SettingsTarget,
} from '@caxri/protocol';
import {
    agentProviderCatalog,
    BUG_REPORT_JPEG_DATA_URL_PREFIX,
    CaxriError,
    themeImportExtensions,
} from '@caxri/protocol';
import type { StructuredLogger } from '@caxri/system';
import type { BrowserWindow } from 'electron';
import { app, clipboard, ClipboardItem, dialog, nativeImage, net, shell } from 'electron';

import { createAcceptanceExternalOpenFixture } from './acceptance-external-open';
import { createAcceptanceSessionDeleteFixture } from './acceptance-session-delete';
import { createAcceptanceThemeImportFixture } from './acceptance-theme-import';
import type { AgentCommanderWindowController } from './agent-commander-window';
import { createAgentProviderStatus, createE2EStatusPageFetch } from './agent-provider-status';
import { readArgvConfig, updateArgvConfig } from './argv-config';
import {
    BUG_REPORT_SCREENSHOT_DIRECTORY,
    pruneBugReportScreenshots,
} from './bug-report-screenshots';
import {
    deleteProjectPrompt,
    deleteSessionPrompt,
    deleteSessionsPrompt,
    discardGitChangesPrompt,
    externalLinkChoice,
    externalLinkPrompt,
    revertAgentChatFilesPrompt,
    revokeMobileDevicePrompt,
    shellCommandElevationPrompt,
    trashPrompt,
    unsavedChangesChoice,
    unsavedChangesPrompt,
} from './confirmations';
import { showContextMenu } from './context-menu';
import {
    createExternalDocumentChangeWatcher,
    handleExternalDocumentRequest,
    isExternalDocumentRequest,
} from './external-document-methods';
import { openExternalUrl } from './external-links';
import { createLinkFavicons } from './link-favicons';
import { createLinkPreviews } from './link-previews';
import type { ProcessExplorerWindowController } from './process-explorer-window';
import { currentRequestWindow } from './request-window';
import type { DesktopServerConnection } from './server-connection';
import type { ShellCommandEnvironment } from './shell-command';
import {
    installShellCommand,
    runAsAdministrator,
    SHELL_COMMAND_LINK_PATH,
    uninstallShellCommand,
} from './shell-command';
import type { UpdateService } from './updates';
import type { createWorkbenchRootAuthority } from './workbench-root-authority';

interface MainMethodHandlerOptions {
    externalOpenFixture?: ReturnType<typeof createAcceptanceExternalOpenFixture>;
    acceptanceSessionDeleteFixture?: ReturnType<typeof createAcceptanceSessionDeleteFixture>;
    acceptanceThemeImportFixture?: ReturnType<typeof createAcceptanceThemeImportFixture>;
    allowGpuTestInjection?: boolean;
    getProcessExplorer(): ProcessExplorerWindowController;
    getAgentCommander(): AgentCommanderWindowController | undefined;
    /**
     * Selects a Session in the Workbench and raises the main window; used by the Agent Commander board.
     */
    revealSessionInWorkbench(sessionId: string): Promise<void>;
    /**
     * Raises the Workbench, reopening it if needed, and opens Settings there; used by the Agent Commander window, which
     * has no Settings of its own. An optional `target` scrolls Settings to one specific row instead of its default
     * view.
     */
    openSettingsInWorkbench(target?: SettingsTarget): Promise<void>;
    /**
     * What this instance actually exposes, resolved once at boot by `configureDesktopProfile`. It is not derivable from
     * `argv.jsonc`: an unpackaged launch ignores the stored preference, and a window whose switch was just flipped
     * still holds the port it started with.
     */
    getRemoteDebugging(): RemoteDebuggingState;
    getUserDataPath(): string;
    logger?(): StructuredLogger | undefined;
    getSupervisor(): DesktopServerConnection;
    getUpdateService(): UpdateService;
    getWindow(): BrowserWindow | undefined;
    /**
     * Delivers Main's own events to the Workbench; a handler built without it (unit tests) ignores watch requests.
     */
    sendEvent?: (event: ServerEvent) => void;
    injectGpuContextLoss?(): { correlationId: string };
    /**
     * Settles Main's pending quit-time question about unsaved Editor buffers; see `createUnsavedEditorsBridge`.
     */
    onUnsavedEditorsReply?(
        parameters: Extract<MainRequest, { method: 'editor.unsavedReply' }>['params'],
    ): void;
    restartInGpuSafeMode?(): Promise<void>;
    updateArgvConfig?(changes: ArgvConfigChanges): Promise<ArgvConfig>;
    workbenchRootAuthority: ReturnType<typeof createWorkbenchRootAuthority>;
}

function assertNever(value: never): never {
    throw new CaxriError('INTERNAL', `Unhandled Main request: ${String(value)}`);
}

/**
 * Creates the Main-side handler for Desktop requests the Server forwards to Electron: native dialogs, Trash,
 * screenshots, and update control all need direct Electron API access the Server process lacks.
 */
export function createMainMethodHandler(options: MainMethodHandlerOptions) {
    const linkFavicon = createLinkFavicons((url, init) => net.fetch(url, init));
    const agentProviderStatus = createAgentProviderStatus({
        fetch:
            process.env.CAXRI_E2E === '1'
                ? createE2EStatusPageFetch(process.env.CAXRI_E2E_PROVIDER_STATUS_DIR)
                : (url, init) => net.fetch(url, init),
        logger: () => options.logger?.(),
    });
    const linkPreview = createLinkPreviews((url, init) => net.fetch(url, init));
    const externalOpenFixture =
        options.externalOpenFixture ??
        createAcceptanceExternalOpenFixture({
            environment: process.env,
            userDataPath: options.getUserDataPath(),
        });
    const themeImportFixture =
        options.acceptanceThemeImportFixture ??
        createAcceptanceThemeImportFixture({
            environment: process.env,
            userDataPath: options.getUserDataPath(),
        });
    const sessionDeleteFixture =
        options.acceptanceSessionDeleteFixture ??
        createAcceptanceSessionDeleteFixture({
            environment: process.env,
            userDataPath: options.getUserDataPath(),
        });
    function shellCommandEnvironment(window: BrowserWindow | undefined): ShellCommandEnvironment {
        return {
            launcherPath: app.isPackaged ? join(process.resourcesPath, 'bin', 'caxri') : undefined,
            linkPath: SHELL_COMMAND_LINK_PATH,
            confirmElevation: async (action) => {
                const prompt = shellCommandElevationPrompt(action, SHELL_COMMAND_LINK_PATH);
                const result =
                    window && !window.isDestroyed()
                        ? await dialog.showMessageBox(window, prompt)
                        : await dialog.showMessageBox(prompt);
                return result.response === 0;
            },
            runElevated: runAsAdministrator,
        };
    }
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
                prompt: async (parsed, parentHostname) => {
                    const messageBoxOptions = externalLinkPrompt(
                        parsed,
                        externalOptions.allowTrust,
                        parentHostname,
                    );
                    const result = externalOpenFixture
                        ? await externalOpenFixture.prompt(parsed, messageBoxOptions)
                        : externalOptions.window
                          ? await dialog.showMessageBox(externalOptions.window, messageBoxOptions)
                          : await dialog.showMessageBox(messageBoxOptions);
                    return externalLinkChoice(
                        result.response,
                        externalOptions.allowTrust,
                        Boolean(parentHostname),
                    );
                },
                trust: async (domain) => {
                    await supervisor.request('settings.trustDomain', { domain });
                },
                open: (target) =>
                    externalOpenFixture
                        ? externalOpenFixture.open(target)
                        : shell.openExternal(target),
            },
            { allowTrust: externalOptions.allowTrust },
        );
    }

    const externalDocumentWatcher = createExternalDocumentChangeWatcher(options.sendEvent);

    return async function handleMainMethod(request: MainRequest): Promise<unknown> {
        const supervisor = options.getSupervisor();
        if (isExternalDocumentRequest(request))
            return handleExternalDocumentRequest(request, supervisor, externalDocumentWatcher);
        const mainWindow = options.getWindow();
        switch (request.method) {
            case 'argv.get':
                return {
                    remoteDebugging: options.getRemoteDebugging(),
                    value: await readArgvConfig(options.getUserDataPath()),
                };
            case 'argv.update':
                return {
                    value: await (options.updateArgvConfig
                        ? options.updateArgvConfig(request.params.changes)
                        : updateArgvConfig(options.getUserDataPath(), request.params.changes)),
                };
            case 'gpu.restartInSafeMode':
                if (!options.restartInGpuSafeMode)
                    throw new CaxriError(
                        'UNAVAILABLE',
                        // Surfaces verbatim in a toast through `tryCommand`, so it stays in the product's vocabulary.
                        'Restarting without hardware acceleration is unavailable',
                    );
                await options.restartInGpuSafeMode();
                return null;
            case 'gpu.testInjectContextLoss':
                if (!options.allowGpuTestInjection || !options.injectGpuContextLoss)
                    throw new CaxriError(
                        'FORBIDDEN',
                        'GPU fault injection is available only in E2E launches',
                    );
                return options.injectGpuContextLoss();
            case 'external.open':
                return handleExternalUrl(request.params.url, {
                    allowTrust: true,
                    window: mainWindow,
                });
            case 'links.favicon':
                return linkFavicon(request.params.origin);
            case 'agentProviderStatus.read':
                return agentProviderStatus(request.params.provider);
            case 'links.preview':
                return linkPreview(request.params.url);
            case 'dialog.selectDirectory':
                return options.workbenchRootAuthority.selectProjectFolder();
            case 'pathBrowser.start':
                return options.workbenchRootAuthority.pathBrowser.start(request.params);
            case 'pathBrowser.browse':
                return options.workbenchRootAuthority.pathBrowser.browse(request.params);
            case 'pathBrowser.navigate':
                return options.workbenchRootAuthority.pathBrowser.navigate(request.params);
            case 'pathBrowser.open':
                return options.workbenchRootAuthority.pathBrowser.open(request.params);
            case 'pathBrowser.close':
                return options.workbenchRootAuthority.pathBrowser.close(request.params);
            case 'session.continueInWorktree':
                return options.workbenchRootAuthority.continueInWorktree(request.params);
            case 'session.authorizeWorkbenchRoot':
                return options.workbenchRootAuthority.authorizeSelection(request.params);
            case 'project.create':
                return options.workbenchRootAuthority.createProject(request.params);
            case 'project.cancelCreate':
                return options.workbenchRootAuthority.cancelProjectCreate(request.params);
            case 'terminal.openFileLink':
                return options.workbenchRootAuthority.openTerminalFileLink(request.params);
            case 'agentCommander.openFileLink':
                return options.workbenchRootAuthority.openCommanderFileLink(request.params);
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
                /**
                 * The Terminal count is taken over the same set Server Core deletes (this Project plus the worktree
                 * Projects registered on its behalf), so the number the user consents to is defined by the cascade
                 * rather than by a second rule maintained here. The worktree half contributes nothing today: the Server
                 * refuses to create a Session inside an auto-registered Project at all. Taking the union is what keeps
                 * that a property of the Server's rule instead of an assumption made at this call site.
                 */
                const worktreeProjects = state.projects.filter(
                    (project) => project.ownerProjectId === projectId,
                );
                const deletedProjectIds = new Set([
                    projectId,
                    ...worktreeProjects.map((project) => project.id),
                ]);
                const sessions = state.sessions.filter((session) =>
                    deletedProjectIds.has(session.projectId),
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
                    deleteProjectPrompt(
                        projectTitle,
                        count,
                        worktreeProjects.map((project) => project.displayTitle),
                    ),
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
                const sessionPrompt = deleteSessionPrompt(sessionTitle, count);
                const result = sessionDeleteFixture
                    ? await sessionDeleteFixture.confirm(sessionId, sessionPrompt)
                    : await dialog.showMessageBox(mainWindow!, sessionPrompt);
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('session.delete', { sessionId });
            }
            case 'session.deleteMany': {
                const { sessionIds } = request.params;
                const counts = await Promise.all(
                    sessionIds.map((sessionId) =>
                        supervisor.request('terminal.runningCount', { sessionId }),
                    ),
                );
                const count = counts.reduce((sum, value) => sum + value, 0);
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    sessionIds.length === 1
                        ? deleteSessionPrompt(
                              (await supervisor.request('app.bootstrap')).sessions.find(
                                  (session) => session.id === sessionIds[0],
                              )?.displayTitle ?? 'this Session',
                              count,
                          )
                        : deleteSessionsPrompt(sessionIds.length, count),
                );
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('session.deleteMany', { sessionIds });
            }
            case 'mobile.device.revoke': {
                const device = (await supervisor.request('mobile.device.list')).devices.find(
                    (candidate) =>
                        candidate.deviceId === request.params.deviceId &&
                        candidate.revokedAt === undefined,
                );
                if (!device) throw new CaxriError('NOT_FOUND', 'Paired device not found');
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    revokeMobileDevicePrompt(device),
                );
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('mobile.device.revoke.apply', {
                    deviceId: device.deviceId,
                    expectedGeneration: device.generation,
                });
            }
            case 'theme.import': {
                if (themeImportFixture) {
                    const path = await themeImportFixture.choose();
                    return supervisor.request('theme.importPath', { path });
                }
                const result = await dialog.showOpenDialog(mainWindow!, {
                    title: 'Import Theme',
                    properties: ['openFile'],
                    filters: [
                        {
                            name: 'Theme files',
                            extensions: [...themeImportExtensions, 'vsix'],
                        },
                        { name: 'All Files', extensions: ['*'] },
                    ],
                });
                const path = result.filePaths[0];
                return !path || result.canceled
                    ? null
                    : supervisor.request('theme.importPath', { path });
            }
            case 'git.discard': {
                const preflight = await supervisor.request('git.discard.preflight', {
                    repositoryId: request.params.repositoryId,
                    scope:
                        request.params.scope.kind === 'all'
                            ? { kind: 'all' }
                            : { kind: 'file', path: request.params.scope.path },
                    sessionId: request.params.sessionId,
                });
                if (preflight.status === 'noop') return null;
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    discardGitChangesPrompt(preflight),
                );
                if (result.response !== 0) return { canceled: true };
                return supervisor.request('git.discard.apply', { token: preflight.token });
            }
            case 'editor.confirmDiscard': {
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    unsavedChangesPrompt(request.params.name),
                );
                return { choice: unsavedChangesChoice(result.response) };
            }
            case 'agentChat.confirmRevertFiles': {
                const result = await dialog.showMessageBox(
                    mainWindow!,
                    revertAgentChatFilesPrompt(request.params),
                );
                return { confirmed: result.response === 0 };
            }
            case 'editor.unsavedReply':
                options.onUnsavedEditorsReply?.(request.params);
                return null;
            case 'contextMenu.show': {
                const window = currentRequestWindow() ?? mainWindow;
                if (!window || window.isDestroyed())
                    throw new CaxriError('UNAVAILABLE', 'No window is available for the menu');
                return showContextMenu(window, request.params);
            }
            case 'processExplorer.open':
                options.getProcessExplorer().open();
                return null;
            case 'agentCommander.open':
                options.getAgentCommander()?.open();
                return null;
            case 'agentCommander.stop':
                await options.getAgentCommander()?.stop();
                return null;
            case 'agentCommander.revealSession':
                await options.revealSessionInWorkbench(request.params.sessionId);
                return null;
            case 'agentCommander.openSettings':
                await options.openSettingsInWorkbench(request.params.target);
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
                     * Electron 44 removed writeImage in favor of its W3C-style asynchronous clipboard API. Await the
                     * atomic write so the Agent cannot receive the paste command before its image is available.
                     */
                    const imageBytes = Uint8Array.from(image.toPNG());
                    const imageBlob = new Blob([imageBytes], { type: 'image/png' });
                    await clipboard.write([
                        new ClipboardItem({
                            'image/png': imageBlob,
                        }),
                    ]);
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
                    dataUrl: `${BUG_REPORT_JPEG_DATA_URL_PREFIX}${image.toJPEG(80).toString('base64')}`,
                    height,
                    width,
                };
            }
            /**
             * Some Agent CLIs (Claude Code among them) have no Caxri-safe way to accept a pasted clipboard image, so
             * the report references an on-disk screenshot the Agent can open with its own file tools instead. The file
             * is deliberately unredacted, because it is exactly the capture the user already reviewed in the bug-report
             * preview. It therefore stays outside any Project in the OS temp directory, in a Caxri-owned folder pruned
             * after 24 hours.
             */
            case 'bugReport.saveScreenshot': {
                /**
                 * The validated data URL already carries JPEG bytes; re-encoding through `nativeImage` would only cost
                 * another lossy generation, and decoding a multi-megabyte capture just to learn whether it is an image
                 * blocks the Main process for no gain. The two-byte SOI marker is the cheap equivalent: the schema has
                 * already fixed the prefix, so this only has to reject base64 that is not actually a JPEG.
                 */
                const bytes = Buffer.from(
                    request.params.dataUrl.slice(BUG_REPORT_JPEG_DATA_URL_PREFIX.length),
                    'base64',
                );
                if (bytes.length < 2 || bytes[0] !== 0xff || bytes[1] !== 0xd8)
                    throw new CaxriError('VALIDATION', 'Screenshot is not a valid JPEG image');
                const directory = join(app.getPath('temp'), BUG_REPORT_SCREENSHOT_DIRECTORY);
                // 0o700/0o600: the capture is unredacted, so nothing outside this user account may read it.
                await mkdir(directory, { recursive: true, mode: 0o700 });
                await pruneBugReportScreenshots(directory);
                const stamp = new Date().toISOString().replaceAll(':', '-');
                const target = join(
                    directory,
                    `caxri-bug-report-${stamp}-${randomBytes(4).toString('hex')}.jpg`,
                );
                await writeFile(target, bytes, { mode: 0o600 });
                return { path: target };
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
                return options.getUpdateService().check({ manual: true });
            case 'updates.acknowledge':
                return options.getUpdateService().acknowledge();
            case 'updates.download':
                return options.getUpdateService().download();
            case 'updates.cancel':
                return options.getUpdateService().cancel();
            case 'updates.open':
                return options.getUpdateService().open();
            case 'shellCommand.install':
                return installShellCommand(shellCommandEnvironment(mainWindow));
            case 'shellCommand.uninstall':
                return uninstallShellCommand(shellCommandEnvironment(mainWindow));
        }
        return assertNever(request);
    };
}
