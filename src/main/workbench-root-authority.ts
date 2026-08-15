import { realpath } from 'node:fs/promises';

import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import { CaxriError } from '../shared/ipc/errors';
import type { MainRequest } from '../shared/ipc/methods';
import type { DesktopHostConnection } from './host-connection';
import type { ProjectRootGrants } from './root-grants';

type ContinueParameters = Extract<MainRequest, { method: 'session.continueInWorktree' }>['params'];
type AuthorizeParameters = Extract<
    MainRequest,
    { method: 'session.authorizeWorkbenchRoot' }
>['params'];
type CreateProjectParameters = Extract<MainRequest, { method: 'project.create' }>['params'];
type CancelProjectParameters = Extract<MainRequest, { method: 'project.cancelCreate' }>['params'];

interface WorkbenchRootAuthorityOptions {
    getHost(): DesktopHostConnection;
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

/**
 * Keeps candidate paths and single-use directory grants inside Electron Main. The Renderer sees only opaque candidate
 * IDs and can never nominate a path for automatic authorization.
 */
export function createWorkbenchRootAuthority(options: WorkbenchRootAuthorityOptions) {
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
            const path = result.filePaths[0];
            if (path && !result.canceled) options.grants.grant(path);
            /**
             * A dismissed or empty selection must resolve to null, never to an absent value.
             */
            return result.canceled ? null : (path ?? null);
        },

        createProject(parameters: CreateProjectParameters) {
            return options.grants.use(parameters.rootPath, () =>
                options.getHost().request('project.create', parameters),
            );
        },

        cancelProjectCreate(parameters: CancelProjectParameters) {
            options.grants.revoke(parameters.rootPath);
            return null;
        },

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
                    options.getHost().request('session.workbenchRoot.authorizeSelection', {
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
            const host = options.getHost();
            const candidate = await host.request('session.workbenchCandidate.claim', {
                candidateId,
                sessionId,
            });
            try {
                if (candidate.projectId)
                    return await host.request('session.selectWorkbenchRoot', {
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
                        host.request('session.workbenchCandidate.authorize', {
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
                    await host.request('session.workbenchCandidate.cancel', {
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
