import { realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type { MainRequest } from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import { readExternalFileSnapshot } from './external-file-snapshot';
import type { PathBrowserOpenTarget } from './path-browser-authority';
import { createPathBrowserAuthority } from './path-browser-authority';
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
type ExternalOpenDecision = 'cancel' | 'open' | 'trust';

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
 * Keeps candidate paths and single-use folder grants inside Electron Main. The Renderer sees only opaque candidate IDs
 * and can never nominate a path for automatic authorization.
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
        if (sessions.length === 0) {
            /**
             * Server Core resolves a link into an auto-registered worktree Project only while a live Session uses it as
             * its Workbench Root, and it refuses to create a Session inside such a Project. If that binding vanished
             * between resolve and open, cancel instead of asking for a Session the Server would reject.
             */
            const project = state.projects.find((candidate) => candidate.id === projectId);
            if (project?.ownerProjectId !== undefined) return undefined;
            return (await server.request('session.create', { projectId, defaultAgent: null }))
                .session.id;
        }

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

    /**
     * A Project-contained link opens through Server Core's authorized editable path. Anything else is an "external"
     * file: Main confirms once (or silently when a Trusted Folder already contains it), reads one bounded read-only
     * snapshot, and hands it to the Terminal's own Session as an ephemeral tab. No Project or Session is created.
     */
    async function openTerminalFileLink(parameters: OpenTerminalFileLinkParameters) {
        const server = options.getServer();
        const resolved = await server.request('terminal.fileLink.resolve', parameters);
        if (resolved.status === 'ambiguous')
            return {
                status: resolved.status,
                candidates: resolved.candidates,
                truncated: resolved.truncated,
            };
        if (resolved.status === 'external') {
            if (!resolved.trusted) {
                const decision = await confirmExternalOpen(resolved.path);
                if (decision === 'cancel') return { canceled: true as const };
                if (decision === 'trust')
                    await server.request('settings.trustFolder', { path: dirname(resolved.path) });
            }
            return {
                opened: true as const,
                document: await readExternalFileSnapshot(resolved.path),
                sessionId: resolved.sourceSessionId,
            };
        }

        const sessionId = await chooseTargetSession(resolved.projectId);
        if (!sessionId) return { canceled: true as const };
        await server.request('desktop.openFile', {
            expectedIdentity: resolved.identity,
            path: resolved.path,
            sessionId,
            launchIfNeeded: false,
            ...(parameters.location && { location: parameters.location }),
        });
        return { opened: true as const };
    }

    async function confirmExternalOpen(path: string): Promise<ExternalOpenDecision> {
        const folder = dirname(path);
        const result = await showMessageBox(options.getWindow(), {
            type: 'question',
            title: 'Open a File Outside Added Projects?',
            message: `Open ${basename(path)} read-only?`,
            detail: `${path}\n\nThis file is outside every added Project, so Caxri opens a read-only copy without adding a Project. Trusting the folder skips this prompt for files under ${folder}.`,
            buttons: ['Open', 'Trust Folder and Open', 'Cancel'],
            defaultId: 0,
            cancelId: 2,
            noLink: true,
        });
        return result.response === 2 ? 'cancel' : result.response === 1 ? 'trust' : 'open';
    }

    async function openPathBrowserFile(target: PathBrowserOpenTarget) {
        await options.getServer().request('desktop.openFile', {
            expectedIdentity: target.expectedIdentity,
            path: target.path,
            sessionId: target.sessionId,
            launchIfNeeded: false,
        });
        return { opened: true as const };
    }

    const pathBrowser = createPathBrowserAuthority({
        getServer: () => options.getServer(),
        openFile: openPathBrowserFile,
    });

    return {
        async selectProjectFolder() {
            const testRoot = options.nextTestRoot();
            if (testRoot) {
                options.grants.grant(testRoot);
                return testRoot;
            }
            const result = await chooseDirectory(options.getWindow(), {
                title: 'Choose a Project folder',
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

        pathBrowser,

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
                        'Selected folder does not match the detected worktree',
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
