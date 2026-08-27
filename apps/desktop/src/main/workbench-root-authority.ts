import { realpath } from 'node:fs/promises';
import { dirname } from 'node:path';

import type {
    MainRequest,
    ServerOperationParameters as ServerOperationParameters,
    ServerOperationResult,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import type { ProjectRootGrants } from './root-grants';
import type { DesktopServerConnection } from './server-connection';

type ContinueParameters = Extract<MainRequest, { method: 'session.continueInWorktree' }>['params'];
type AuthorizeParameters = Extract<
    MainRequest,
    { method: 'session.authorizeWorkbenchRoot' }
>['params'];
type CreateProjectParameters = Extract<MainRequest, { method: 'project.create' }>['params'];
type CancelProjectParameters = Extract<MainRequest, { method: 'project.cancelCreate' }>['params'];
type OpenTerminalFileLinkParameters = Extract<
    MainRequest,
    { method: 'terminal.openFileLink' }
>['params'];

interface WorkbenchRootAuthorityOptions {
    getServer(): DesktopServerConnection;
    getWindow(): BrowserWindow | undefined;
    grants: ProjectRootGrants;
    nextTestRoot(): string | undefined;
}

async function chooseDirectory(
    window: BrowserWindow | undefined,
    options: Electron.OpenDialogOptions,
): Promise<Electron.OpenDialogReturnValue> {
    return window ? dialog.showOpenDialog(window, options) : dialog.showOpenDialog(options);
}

async function showMessageBox(
    window: BrowserWindow | undefined,
    options: Electron.MessageBoxOptions,
): Promise<Electron.MessageBoxReturnValue> {
    return window ? dialog.showMessageBox(window, options) : dialog.showMessageBox(options);
}

/**
 * Keeps candidate paths and single-use directory grants inside Electron Main. The Renderer sees only opaque candidate
 * IDs and can never nominate a path for automatic authorization.
 */
export function createWorkbenchRootAuthority(options: WorkbenchRootAuthorityOptions) {
    async function chooseTargetSession(projectId: string): Promise<string | undefined> {
        const server = options.getServer();
        const state = await server.request('app.bootstrap');
        const sessions = state.sessions.filter(
            (session) =>
                session.archivedAt === undefined && session.workbenchProjectId === projectId,
        );
        const selected = sessions.find((session) => session.id === state.selectedSessionId);
        if (selected) return selected.id;
        if (sessions.length === 1) return sessions[0].id;
        if (sessions.length === 0)
            return (await server.request('session.create', { projectId, defaultAgent: null }))
                .session.id;

        const projectTitle =
            state.projects.find((project) => project.id === projectId)?.displayTitle ?? 'Project';
        const result = await showMessageBox(options.getWindow(), {
            type: 'question',
            title: 'Choose a Session',
            message: `Choose a Session in ${projectTitle} to open this file`,
            detail: 'The file will open in the selected Session without starting a Terminal.',
            buttons: [
                ...sessions.map(
                    (session, index) => `${session.displayTitle || 'Untitled'} (${index + 1})`,
                ),
                'Cancel',
            ],
            defaultId: 0,
            cancelId: sessions.length,
            noLink: true,
        });
        return result.response === sessions.length ? undefined : sessions[result.response]?.id;
    }

    async function openTerminalFileLink(parameters: OpenTerminalFileLinkParameters) {
        const server = options.getServer();
        const initial = await server.request('terminal.fileLink.resolve', parameters);
        if (initial.status === 'ambiguous')
            return {
                status: initial.status,
                candidates: initial.candidates,
                truncated: initial.truncated,
            };
        let expectedIdentity: NonNullable<
            ServerOperationParameters<'desktop.openFile'>['expectedIdentity']
        >;
        let path: string;
        let projectId: string;

        if (initial.status === 'authorized') {
            expectedIdentity = initial.identity;
            path = initial.path;
            projectId = initial.projectId;
        } else {
            const testRoot = options.nextTestRoot();
            let selectedRoot = testRoot;
            if (!selectedRoot) {
                const confirmation = await showMessageBox(options.getWindow(), {
                    type: 'question',
                    title: 'Open a File Outside Added Projects?',
                    message: 'This file is outside every added Project.',
                    detail: 'Choose a Project folder that contains the file. Caxri will add that folder before opening it.',
                    buttons: ['Choose Project Folder…', 'Cancel'],
                    defaultId: 0,
                    cancelId: 1,
                    noLink: true,
                });
                if (confirmation.response !== 0) return { canceled: true as const };
                const selection = await chooseDirectory(options.getWindow(), {
                    title: 'Choose a Project Folder',
                    defaultPath: dirname(initial.path),
                    properties: ['openDirectory'],
                });
                selectedRoot = selection.canceled ? undefined : selection.filePaths.at(0);
            }
            if (!selectedRoot) return { canceled: true as const };

            const selected = await server.request('terminal.fileLink.resolve', {
                ...parameters,
                selectedRoot,
            });
            if (selected.status !== 'selection_authorized')
                throw new CaxriError('INTERNAL', 'Terminal link selection was not authorized');
            expectedIdentity = selected.identity;
            options.grants.grant(selected.rootPath);
            let project: ServerOperationResult<'project.create'>;
            /**
             * A failed autonomous flow cannot leave a reusable directory grant behind.
             */
            try {
                project = await options.grants.use(selected.rootPath, () =>
                    server.request('project.create', {
                        rootPath: selected.rootPath,
                        expectedRootIdentity: selected.identity.root,
                    }),
                );
            } catch (error) {
                options.grants.revoke(selected.rootPath);
                throw error;
            }
            path = selected.path;
            projectId = project.id;
        }

        const sessionId = await chooseTargetSession(projectId);
        if (!sessionId) return { canceled: true as const };
        await server.request('desktop.openFile', {
            expectedIdentity,
            path,
            sessionId,
            launchIfNeeded: false,
            ...(parameters.location && { location: parameters.location }),
        });
        return { opened: true as const };
    }

    return {
        async selectProjectDirectory() {
            const testRoot = options.nextTestRoot();
            if (testRoot) {
                options.grants.grant(testRoot);
                return testRoot;
            }
            const result = await chooseDirectory(options.getWindow(), {
                title: 'Choose a Project directory',
                properties: ['openDirectory', 'createDirectory'],
            });
            // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: `filePaths` is empty
            // when the dialog is dismissed without a selection.
            const path = result.filePaths.at(0);
            if (path && !result.canceled) options.grants.grant(path);
            /**
             * A dismissed or empty selection must resolve to null, never to an absent value.
             */
            return result.canceled ? null : (path ?? null);
        },

        createProject(parameters: CreateProjectParameters) {
            return options.grants.use(parameters.rootPath, () =>
                options.getServer().request('project.create', parameters),
            );
        },

        cancelProjectCreate(parameters: CancelProjectParameters) {
            options.grants.revoke(parameters.rootPath);
            return null;
        },

        openTerminalFileLink,

        async authorizeSelection(parameters: AuthorizeParameters) {
            const testRoot = options.nextTestRoot();
            const result = testRoot
                ? { canceled: false, filePaths: [testRoot] }
                : await chooseDirectory(options.getWindow(), {
                      title: 'Authorize Workbench Root',
                      properties: ['openDirectory'],
                  });
            const selectedPath = result.filePaths[0];
            if (!selectedPath || result.canceled) return { canceled: true as const };
            const canonicalRoot = await realpath(selectedPath);
            options.grants.grant(canonicalRoot);
            try {
                return await options.grants.use(canonicalRoot, () =>
                    options.getServer().request('session.workbenchRoot.authorizeSelection', {
                        sessionId: parameters.sessionId,
                        rootPath: canonicalRoot,
                    }),
                );
            } catch (error) {
                options.grants.revoke(canonicalRoot);
                throw error;
            }
        },

        async continueInWorktree(parameters: ContinueParameters) {
            const { candidateId, sessionId } = parameters;
            const server = options.getServer();
            const candidate = await server.request('session.workbenchCandidate.claim', {
                candidateId,
                sessionId,
            });
            try {
                if (candidate.projectId)
                    return await server.request('session.selectWorkbenchRoot', {
                        sessionId,
                        projectId: candidate.projectId,
                    });
                const testRoot = options.nextTestRoot();
                const result = testRoot
                    ? { canceled: false, filePaths: [testRoot] }
                    : await chooseDirectory(options.getWindow(), {
                          title: 'Authorize Git Worktree',
                          defaultPath: candidate.rootPath,
                          properties: ['openDirectory'],
                      });
                const selectedPath = result.filePaths[0];
                if (!selectedPath || result.canceled) return { canceled: true as const };
                const [expectedRoot, selectedRoot] = await Promise.all([
                    realpath(candidate.rootPath),
                    realpath(selectedPath),
                ]);
                if (selectedRoot !== expectedRoot)
                    throw new CaxriError(
                        'PATH_DENIED',
                        'Selected directory does not match the detected worktree',
                    );
                options.grants.grant(selectedRoot);
                try {
                    return await options.grants.use(selectedRoot, () =>
                        server.request('session.workbenchCandidate.authorize', {
                            candidateId,
                            rootPath: selectedRoot,
                            sessionId,
                        }),
                    );
                } catch (error) {
                    options.grants.revoke(selectedRoot);
                    throw error;
                }
            } finally {
                try {
                    await server.request('session.workbenchCandidate.cancel', {
                        candidateId,
                        sessionId,
                    });
                } catch {
                    // Best-effort cleanup; the outer try already owns the result or error.
                }
            }
        },
    };
}
