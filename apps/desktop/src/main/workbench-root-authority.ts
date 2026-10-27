import type { BigIntStats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';

import type {
    BootstrapState,
    MainRequest,
    ServerOperationParameters,
    TerminalFileLinkRefusalReason,
} from '@caxri/protocol';
import { CaxriError } from '@caxri/protocol';
import type { BrowserWindow } from 'electron';
import { dialog } from 'electron';

import { readExternalFileSnapshot } from './external-file-snapshot';
import { translateMain } from './locale';
import type { PathBrowserOpenTarget } from './path-browser-authority';
import { createPathBrowserAuthority } from './path-browser-authority';
import { sshHostPathBrowserDirectories } from './path-browser-directories';
import type { PathBrowserLogger } from './path-browser-log';
import type { ProjectRootGrantIdentity, ProjectRootGrants } from './root-grants';
import type { DesktopServerConnection } from './server-connection';
import { currentRequestWindowKey, PRIMARY_WINDOW_KEY } from './window-presence-registry';

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
type OpenBotFileLinkParameters = Extract<
    MainRequest,
    { method: 'caxriBot.openFileLink' }
>['params'];
type ExternalOpenDecision = 'cancel' | 'open' | 'trust';

interface WorkbenchRootAuthorityOptions {
    /**
     * `ssh` serves an SSH Host window: every root path names a folder on the remote machine, so this authority never
     * resolves it on the local disk, never mints a local folder grant for it, and refuses files outside every Project
     * instead of reading a same-named local file. See docs/adr/0014-ssh-remote-server.md.
     */
    environment?: 'local' | 'ssh';
    getServer(): DesktopServerConnection;
    getWindow(): BrowserWindow | undefined;
    grants: ProjectRootGrants;
    logger(): PathBrowserLogger | undefined;
    nextTestRoot(): string | undefined;
    /**
     * Raises and focuses the Workbench window. Used only by `openBotFileLink`, so a native dialog or the opened editor
     * always lands on the window the user can actually see, even though the request originated in the hidden Caxri
     * Bot's window.
     */
    focusWindow(): Promise<void>;
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
 * Captures the canonical path, device, and inode of the folder the user just picked. Server Core compares them again
 * right before the insert, so a path replaced between the pick and `project.create` cannot persist a different
 * directory. The stat is taken on the canonical path: a picked symlink resolves to its target here, and
 * `project.create` is later sent that canonical path so Server Core's no-symlink identity check still passes.
 */
async function captureRootIdentity(selectedPath: string): Promise<ProjectRootGrantIdentity> {
    let path: string;
    let info: BigIntStats;
    try {
        path = await realpath(selectedPath);
        info = await lstat(path, { bigint: true });
    } catch {
        throw new CaxriError('PATH_DENIED', 'Selected Project folder is not available');
    }
    if (!info.isDirectory())
        throw new CaxriError('PATH_DENIED', 'Selected Project folder is not a directory');
    return { path, device: info.dev.toString(), inode: info.ino.toString() };
}

/**
 * Keeps candidate paths and single-use folder grants inside Electron Main. In a local window the Renderer sees only
 * opaque candidate IDs and can never nominate a path for automatic authorization. An SSH Host window is the documented
 * exception: it has no native picker for the SSH Host's disk, so `project.create` forwards the folder the user chose in
 * the SSH Host's own folder browser, and that Server canonicalizes it.
 */
export function createWorkbenchRootAuthority(options: WorkbenchRootAuthorityOptions) {
    const isSshHost = options.environment === 'ssh';
    /**
     * The Session that should receive the file, or why it will not be opened. A refusal carries a reason so the
     * Renderer can say something; a user who dismissed the chooser gets `undefined` and no message, because they
     * already know.
     */
    async function chooseTargetSession(
        projectId: string,
    ): Promise<
        { sessionId: string } | { reason: TerminalFileLinkRefusalReason } | { canceled: true }
    > {
        const server = options.getServer();
        // The requesting window's own selection decides which Session a link opens in.
        const windowKey = currentRequestWindowKey();
        const state = await server.request('app.bootstrap', windowKey ? { windowKey } : {});
        const sessions = state.sessions.filter(
            (session) =>
                session.archivedAt === undefined && session.workbenchProjectId === projectId,
        );
        const selected = sessions.find((session) => session.id === state.selectedSessionId);
        if (selected) return { sessionId: selected.id };
        if (sessions[0] && sessions.length === 1) return { sessionId: sessions[0].id };
        if (sessions.length === 0) {
            /**
             * Server Core resolves a link into an auto-registered worktree Project only while a live Session uses it as
             * its Workbench Root, and it refuses to create a Session inside such a Project. If that binding vanished
             * between resolve and open, refuse instead of asking for a Session the Server would reject. A missing
             * Project row is the same situation one step further along, and `project?.ownerProjectId !== undefined`
             * used to read as "this is a top-level Project" for it, so the open fell through to `session.create`
             * against a Project id that no longer named anything.
             */
            const project = state.projects.find((candidate) => candidate.id === projectId);
            if (!project) return { reason: 'project_gone' };
            if (project.ownerProjectId !== undefined) return { reason: 'worktree_project_unbound' };
            const created = await server.request('session.create', {
                projectId,
                defaultAgent: null,
                ...(windowKey && { windowKey }),
            });
            return { sessionId: created.session.id };
        }

        const projectTitle =
            state.projects.find((project) => project.id === projectId)?.displayTitle ??
            translateMain('desktop.chooseSession.fallbackProject');
        const result = await showMessageBox(options.getWindow(), {
            type: 'question',
            title: translateMain('desktop.chooseSession.title'),
            message: translateMain('desktop.chooseSession.message', { project: projectTitle }),
            detail: translateMain('desktop.chooseSession.detail'),
            buttons: [
                ...sessions.map(
                    (session, index) =>
                        `${session.displayTitle || translateMain('desktop.chooseSession.untitled')} (${index + 1})`,
                ),
                translateMain('desktop.dialog.cancel'),
            ],
            defaultId: 0,
            cancelId: sessions.length,
            noLink: true,
        });
        // Cancel is the one button past the Session list, so its response is the first index with no Session behind it.
        const chosen: (typeof sessions)[number] | undefined =
            result.response === sessions.length ? undefined : sessions[result.response];
        return chosen ? { sessionId: chosen.id } : { canceled: true };
    }

    /**
     * A directory link has no editor tab: it selects the Session and reveals the directory in the Files explorer.
     * `desktop.openProject` carries a directory target (the same Server-side identity check as a file) to the
     * Workbench, whose `desktop.openRequested` handler treats a directory path below the Session root as a Files
     * reveal.
     */
    async function revealDirectoryInFiles(
        resolved: {
            identity: NonNullable<
                ServerOperationParameters<'desktop.openProject'>['expectedIdentity']
            >;
            path: string;
        },
        sessionId: string,
    ) {
        await options.getServer().request('desktop.openProject', {
            expectedIdentity: resolved.identity,
            path: resolved.path,
            sessionId,
            launchIfNeeded: false,
        });
    }

    /**
     * A Project-contained link opens through Server Core's authorized editable path. Anything else is an "external"
     * file: Main confirms once (or silently when a Trusted Folder already contains it), reads one bounded snapshot, and
     * hands it to the Terminal's own Session as an ephemeral, editable tab whose saves go back through Main's
     * `externalDocument.write`. No Project or Session is created.
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
        if (isSshHost && resolved.status === 'external')
            return { canceled: true as const, reason: 'outside_projects' as const };
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

        const target = await chooseTargetSession(resolved.projectId);
        if (!('sessionId' in target))
            return 'reason' in target
                ? { canceled: true as const, reason: target.reason }
                : { canceled: true as const };
        if (resolved.kind === 'directory') {
            await revealDirectoryInFiles(resolved, target.sessionId);
            return { opened: true as const };
        }
        await server.request('desktop.openFile', {
            expectedIdentity: resolved.identity,
            path: resolved.path,
            sessionId: target.sessionId,
            launchIfNeeded: false,
            // Clicking a path link in a Terminal is a request to read that file, so the keyboard follows it.
            focusEditor: true,
            ...(parameters.location && { location: parameters.location }),
        });
        return { opened: true as const };
    }

    /**
     * The first non-archived Session in `state`, preferring whichever one the Workbench currently has selected. Used
     * only to host an external (outside every Project) file's ephemeral tab for Caxri Bot: such a file has no owning
     * Project to search for a covering Session, so any live Session is as good as another. `undefined` means the
     * Workbench has no Session at all to attach the tab to, which the caller treats as a cancellation.
     */
    function pickAnyVisibleSessionId(state: BootstrapState): string | undefined {
        const sessions = state.sessions.filter((session) => session.archivedAt === undefined);
        return (
            sessions.find((session) => session.id === state.selectedSessionId)?.id ??
            sessions[0]?.id
        );
    }

    /**
     * The Session that should receive a file link resolved inside `projectId`, for Caxri Bot only. Unlike
     * `chooseTargetSession`, this never opens the interactive "Choose a Session" dialog: that dialog answers a click
     * the user just made in a visible pane, but this hand-off starts in Caxri Bot's hidden window, so it always
     * resolves silently instead of surfacing a modal the user did not ask for. Preference order: the Session the Caxri
     * Bot itself created in this Project (the one an operator watching Caxri Bot most likely means), then the
     * Workbench's currently selected Session, then the first. The zero-Session branch mirrors `chooseTargetSession`'s:
     * Server Core will not create a Session inside a worktree Project no live Session is using as its Workbench Root.
     */
    async function pickBotFileLinkSession(
        state: BootstrapState,
        projectId: string,
    ): Promise<
        { sessionId: string } | { reason: TerminalFileLinkRefusalReason } | { canceled: true }
    > {
        const server = options.getServer();
        const sessions = state.sessions.filter(
            (session) =>
                session.archivedAt === undefined && session.workbenchProjectId === projectId,
        );
        if (sessions.length === 0) {
            const project = state.projects.find((candidate) => candidate.id === projectId);
            if (!project) return { reason: 'project_gone' };
            if (project.ownerProjectId !== undefined) return { reason: 'worktree_project_unbound' };
            const created = await server.request('session.create', {
                projectId,
                defaultAgent: null,
                windowKey: PRIMARY_WINDOW_KEY,
            });
            return { sessionId: created.session.id };
        }
        if (sessions.length === 1) return { sessionId: sessions[0].id };
        /**
         * Best-effort: a failed board read (Caxri Bot not yet initialized) just skips Caxri Bot-created preference
         * rather than blocking the open.
         */
        let board: Awaited<ReturnType<typeof server.request<'bot.board'>>> | undefined;
        try {
            board = await server.request('bot.board');
        } catch {
            board = undefined;
        }
        const botSessionIds = new Set(
            board?.rows.filter((row) => row.botSession).map((row) => row.sessionId),
        );
        const preferred =
            sessions.find((session) => botSessionIds.has(session.id)) ??
            sessions.find((session) => session.id === state.selectedSessionId) ??
            sessions[0];
        return { sessionId: preferred.id };
    }

    /**
     * Caxri Bot's counterpart to `openTerminalFileLink`. Caxri Bot's own cwd is its hidden system Project, so it must
     * never gain authority over another Project through this hand-off: every branch below resolves through the same
     * Server-side `terminal.fileLink.resolve` used by every other Terminal (global across all visible Projects,
     * independent of the source Terminal), and then always substitutes a real, visible Session for the Caxri Bot's own
     * (see `pickBotFileLinkSession` and `pickAnyVisibleSessionId`), rather than trusting `resolved.sourceSessionId`,
     * which would otherwise name Caxri Bot's own invisible Session.
     */
    async function openBotFileLink(parameters: OpenBotFileLinkParameters) {
        const server = options.getServer();
        const resolved = await server.request('terminal.fileLink.resolve', {
            terminalId: parameters.terminalId,
            target: parameters.target,
        });
        if (resolved.status === 'ambiguous')
            return {
                status: resolved.status,
                candidates: resolved.candidates,
                truncated: resolved.truncated,
            };
        /**
         * Past this point every branch either opens a native dialog or the Workbench editor, so raise the Workbench
         * first. The ambiguous branch above deliberately skips this: it only returns data for Caxri Bot's own
         * already-mounted link picker, and stealing focus for that would be jarring rather than helpful.
         */
        await options.focusWindow();
        const state = await server.request('app.bootstrap', { windowKey: PRIMARY_WINDOW_KEY });
        if (resolved.status === 'external') {
            if (!resolved.trusted) {
                const decision = await confirmExternalOpen(resolved.path);
                if (decision === 'cancel') return { canceled: true as const };
                if (decision === 'trust')
                    await server.request('settings.trustFolder', { path: dirname(resolved.path) });
            }
            const sessionId = pickAnyVisibleSessionId(state);
            if (!sessionId) return { canceled: true as const };
            return {
                opened: true as const,
                document: await readExternalFileSnapshot(resolved.path),
                sessionId,
            };
        }

        const target = await pickBotFileLinkSession(state, resolved.projectId);
        if (!('sessionId' in target))
            return 'reason' in target
                ? { canceled: true as const, reason: target.reason }
                : { canceled: true as const };
        if (resolved.kind === 'directory') {
            await revealDirectoryInFiles(resolved, target.sessionId);
            return { opened: true as const };
        }
        await server.request('desktop.openFile', {
            expectedIdentity: resolved.identity,
            path: resolved.path,
            sessionId: target.sessionId,
            launchIfNeeded: false,
            focusEditor: true,
            ...(parameters.location && { location: parameters.location }),
        });
        return { opened: true as const };
    }

    async function confirmExternalOpen(path: string): Promise<ExternalOpenDecision> {
        const folder = dirname(path);
        const result = await showMessageBox(options.getWindow(), {
            type: 'question',
            title: translateMain('desktop.externalFile.title'),
            message: translateMain('desktop.externalFile.message', { name: basename(path) }),
            detail: translateMain('desktop.externalFile.detail', { path, folder }),
            buttons: [
                translateMain('desktop.dialog.open'),
                translateMain('desktop.externalFile.trustFolder'),
                translateMain('desktop.dialog.cancel'),
            ],
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
            /**
             * The user picked this file and pressed Enter; the next thing they type belongs in it, not on the tab
             * button that focus recovery would otherwise hand them. Matches VS Code's Quick Open.
             */
            focusEditor: true,
        });
        return { opened: true as const };
    }

    const pathBrowser = createPathBrowserAuthority({
        ...(isSshHost && {
            directories: sshHostPathBrowserDirectories(() => options.getServer()),
        }),
        getServer: () => options.getServer(),
        logger: () => options.logger(),
        openFile: openPathBrowserFile,
    });

    return {
        async selectProjectFolder() {
            const testRoot = options.nextTestRoot();
            if (testRoot) {
                options.grants.grant(testRoot, await captureRootIdentity(testRoot));
                return testRoot;
            }
            const result = await chooseDirectory(options.getWindow(), {
                title: translateMain('desktop.chooseProjectFolder'),
                properties: ['openDirectory', 'createDirectory'],
            });
            // `.at(0)` (not `[0]`) keeps the result typed as possibly missing: `filePaths` is empty
            // when the dialog is dismissed without a selection.
            const path = result.filePaths.at(0);
            if (path && !result.canceled)
                options.grants.grant(path, await captureRootIdentity(path));
            /**
             * A dismissed or empty selection must resolve to null, never to an absent value.
             */
            return result.canceled ? null : (path ?? null);
        },

        createProject(parameters: CreateProjectParameters) {
            /**
             * The remote folder was listed by the remote Server itself (`project.browseFolders`), which canonicalizes
             * the root again in `project.create`; a local grant would describe a path on the wrong machine.
             */
            if (isSshHost)
                return options.getServer().request('project.create', {
                    rootPath: parameters.rootPath,
                });
            /**
             * Main owns the identity: whatever `expectedRootIdentity` the Renderer sent is dropped, and the one
             * captured at pick time is injected. The canonical path replaces the picked one so a symlinked pick still
             * passes Server Core's no-symlink identity check. Server Core stays the final authority; a PATH_DENIED
             * means the selected object changed, so the grant is spent instead of left for a replay.
             */
            return options.grants.use(parameters.rootPath, async (identity) => {
                if (!identity)
                    throw new CaxriError('PATH_DENIED', 'Project root selection has no identity');
                try {
                    return await options.getServer().request('project.create', {
                        rootPath: identity.path,
                        expectedRootIdentity: identity,
                    });
                } catch (error) {
                    if (error instanceof CaxriError && error.code === 'PATH_DENIED')
                        options.grants.revoke(parameters.rootPath);
                    throw error;
                }
            });
        },

        cancelProjectCreate(parameters: CancelProjectParameters) {
            if (isSshHost) return null;
            options.grants.revoke(parameters.rootPath);
            return null;
        },

        openTerminalFileLink,

        openBotFileLink,

        pathBrowser,

        async authorizeSelection(parameters: AuthorizeParameters) {
            const selectedPath = await options
                .getServer()
                .request('session.workbenchRoot.resolve', parameters);
            if (isSshHost)
                return options.getServer().request('session.workbenchRoot.authorizeSelection', {
                    sessionId: parameters.sessionId,
                    rootPath: selectedPath,
                    worktreeId: parameters.worktreeId,
                });
            const canonicalRoot = await realpath(selectedPath);
            options.grants.grant(canonicalRoot);
            try {
                return await options.grants.use(canonicalRoot, () =>
                    options.getServer().request('session.workbenchRoot.authorizeSelection', {
                        sessionId: parameters.sessionId,
                        rootPath: canonicalRoot,
                        worktreeId: parameters.worktreeId,
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
                /**
                 * Continue authorizes the exact Server-owned candidate, never a Renderer-supplied path. Server
                 * revalidates the candidate and Git topology before consuming this single-use root grant.
                 */
                if (isSshHost)
                    return await server.request('session.workbenchCandidate.authorize', {
                        candidateId,
                        rootPath: candidate.rootPath,
                        sessionId,
                    });
                let selectedRoot: string;
                try {
                    selectedRoot = await realpath(candidate.rootPath);
                } catch {
                    throw new CaxriError(
                        'NOT_FOUND',
                        'The worktree candidate is no longer available',
                    );
                }
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
