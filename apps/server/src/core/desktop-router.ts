import { randomUUID } from 'node:crypto';

import type {
    DesktopLease,
    DesktopOperation,
    DesktopTargetPayload,
    EditorNavigationTarget,
    RemoteUpdateInstallResult,
    ServerOperationParameters,
    ServerOperationResult,
    UpdateState,
    WorkbenchRequestContext,
} from '@caxri/protocol';
import {
    CaxriError,
    isCaxriError,
    PATH_OUTSIDE_PROJECTS_MESSAGE,
    remoteUpdateInstallResultSchema,
    SESSION_SELECTION_REQUIRED_MESSAGE,
    updateStateSchema,
} from '@caxri/protocol';

import type { ServerDomainService } from '../core/domain-service';
import { authorizeProjectRoot } from './project-root-target';

type AuthorizedEntry = ServerOperationResult<'files.authorizeOpen'>;
type ExpectedIdentity = NonNullable<
    ServerOperationParameters<'desktop.openFile'>['expectedIdentity']
>;
type BootstrapState = ServerOperationResult<'app.bootstrap'>;
type DesktopStatus = { state: 'offline' } | { state: 'background' | 'window'; generation: number };

interface StoredTarget {
    entry: AuthorizedEntry;
    expiresAt: number;
    generation: number;
    id: string;
    operation: 'open' | 'openInEditor' | 'openWithDefaultApp' | 'reveal';
    projectId?: string;
    sessionId?: string;
    projectRootId?: string;
    location?: EditorNavigationTarget;
    focusEditor?: boolean;
}

interface DesktopRouterBridge {
    invoke(operation: DesktopOperation, expectedGeneration: number): Promise<unknown>;
    lease(): DesktopLease | undefined;
    launch?(): Promise<void>;
    waitForLease?(timeoutMs: number): Promise<DesktopLease>;
}

export interface DesktopRouterOptions {
    bridge: DesktopRouterBridge;
    maximumTargets?: number;
    now?: () => number;
    domainService: Pick<
        ServerDomainService,
        'request' | 'requestInWorkbenchContext' | 'requestWithSignal'
    >;
    targetTtlMs?: number;
}

const DEFAULT_TARGET_TTL_MS = 15_000;
const DEFAULT_MAXIMUM_TARGETS = 128;

function isSameIdentity(left: AuthorizedEntry, right: AuthorizedEntry): boolean {
    return (
        left.kind === right.kind &&
        left.path === right.path &&
        left.device === right.device &&
        left.inode === right.inode &&
        left.root.path === right.root.path &&
        left.root.device === right.root.device &&
        left.root.inode === right.root.inode
    );
}

function isExpectedIdentity(entry: AuthorizedEntry, expected: ExpectedIdentity): boolean {
    return (
        entry.device === expected.device &&
        entry.inode === expected.inode &&
        entry.root.path === expected.root.path &&
        entry.root.device === expected.root.device &&
        entry.root.inode === expected.root.inode
    );
}

function isDesktopConfirmationAccepted(result: unknown): boolean {
    if (
        typeof result !== 'object' ||
        result === null ||
        !('confirmed' in result) ||
        typeof result.confirmed !== 'boolean'
    )
        throw new CaxriError('INTERNAL', 'Desktop returned an invalid confirmation');
    return result.confirmed;
}

const isUnsupportedDesktopUpdate = (result: unknown): boolean =>
    typeof result === 'object' && result !== null && 'unsupported' in result;

const invalidDesktopUpdate = () =>
    new CaxriError('INTERNAL', 'Desktop returned an invalid update answer');

function assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new CaxriError('CANCELLED', 'Desktop operation was cancelled');
}

/**
 * Resolves raw paths inside the domain layer, then exposes only one-use generation-bound targets to Desktop Main.
 */
export class ServerDesktopRouter {
    private readonly maximumTargets: number;
    private readonly now: () => number;
    private readonly targetTtlMs: number;
    private readonly targets = new Map<string, StoredTarget>();
    private launching?: Promise<DesktopLease>;

    constructor(private readonly options: DesktopRouterOptions) {
        this.maximumTargets = options.maximumTargets ?? DEFAULT_MAXIMUM_TARGETS;
        this.now = options.now ?? Date.now;
        this.targetTtlMs = options.targetTtlMs ?? DEFAULT_TARGET_TTL_MS;
    }

    private async requireLease(shouldLaunch: boolean): Promise<DesktopLease> {
        const current = this.options.bridge.lease();
        if (current) return current;
        if (!shouldLaunch)
            throw new CaxriError('UNAVAILABLE', 'Desktop is not running for this profile');
        if (!this.options.bridge.launch || !this.options.bridge.waitForLease)
            throw new CaxriError('UNAVAILABLE', 'Desktop launcher is unavailable');
        this.launching ??= (async () => {
            try {
                await this.options.bridge.launch!();
                return await this.options.bridge.waitForLease!(15_000);
            } finally {
                this.launching = undefined;
            }
        })();
        return this.launching;
    }

    private issueTarget(
        operation: 'open' | 'openInEditor' | 'openWithDefaultApp' | 'reveal',
        generation: number,
        resolved: {
            entry: AuthorizedEntry;
            projectId?: string;
            sessionId?: string;
            projectRootId?: string;
        },
        location?: EditorNavigationTarget,
        shouldFocusEditor?: boolean,
    ): StoredTarget {
        this.pruneTargets();
        if (this.targets.size >= this.maximumTargets)
            throw new CaxriError('CAPACITY', 'Too many Desktop targets are pending');
        const target: StoredTarget = {
            ...resolved,
            expiresAt: this.now() + this.targetTtlMs,
            generation,
            id: randomUUID(),
            operation,
            ...(location && { location }),
            ...(shouldFocusEditor && { focusEditor: shouldFocusEditor }),
        };
        this.targets.set(target.id, target);
        return target;
    }

    private pruneTargets(): void {
        const now = this.now();
        for (const [id, target] of this.targets)
            if (target.expiresAt < now) this.targets.delete(id);
    }

    private async resolveTarget(
        path: string,
        requestedSessionId?: string,
        signal?: AbortSignal,
        context?: WorkbenchRequestContext,
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        if (context && requestedSessionId !== context.sessionId)
            throw new CaxriError('PATH_DENIED', 'Desktop request context is inconsistent');
        const state = await this.options.domainService.request('app.bootstrap');
        if (requestedSessionId)
            return this.resolveRequestedSession(state, requestedSessionId, path, signal, context);

        const activeSessions = state.sessions.filter((session) => session.archivedAt === undefined);
        const representatives = new Map<string, (typeof activeSessions)[number]>();
        for (const session of activeSessions)
            if (!representatives.has(session.projectId))
                representatives.set(session.projectId, session);
        const matches = (
            await Promise.all(
                representatives.values().map(async (session) => {
                    try {
                        const entry = await this.options.domainService.request(
                            'files.authorizeOpen',
                            {
                                sessionId: session.id,
                                path,
                            },
                        );
                        return { entry, projectId: session.projectId };
                    } catch (error) {
                        if (
                            isCaxriError(error) &&
                            (error.code === 'PATH_DENIED' || error.code === 'NOT_FOUND')
                        )
                            return;
                        throw error;
                    }
                }),
            )
        ).filter((value) => value !== undefined);
        if (matches.length === 0)
            throw new CaxriError('PATH_DENIED', PATH_OUTSIDE_PROJECTS_MESSAGE);
        matches.sort((left, right) => right.entry.root.path.length - left.entry.root.path.length);
        if (matches[1] && matches[1].entry.root.path.length === matches[0].entry.root.path.length)
            throw new CaxriError('CONFLICT', 'Path matches more than one Project');
        const projectId = matches[0].projectId;
        const sessions = activeSessions.filter((session) => session.projectId === projectId);
        const selected = sessions.find((session) => session.id === state.selectedSessionId);
        const session = selected ?? (sessions.length === 1 ? sessions[0] : undefined);
        if (!session) throw new CaxriError('CONFLICT', SESSION_SELECTION_REQUIRED_MESSAGE);
        const entry = await this.options.domainService.request('files.authorizeOpen', {
            sessionId: session.id,
            path,
        });
        return { entry, projectId, sessionId: session.id };
    }

    private async resolveRequestedSession(
        state: BootstrapState,
        sessionId: string,
        path: string,
        signal?: AbortSignal,
        context?: WorkbenchRequestContext,
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (session.archivedAt !== undefined)
            throw new CaxriError('CONFLICT', 'Archived Sessions cannot receive Desktop targets');
        const parameters = { sessionId, path };
        const entry = context
            ? await this.options.domainService.requestInWorkbenchContext(
                  'files.authorizeOpen',
                  parameters,
                  context,
                  undefined,
                  signal,
              )
            : signal
              ? await this.options.domainService.requestWithSignal(
                    'files.authorizeOpen',
                    parameters,
                    signal,
                )
              : await this.options.domainService.request('files.authorizeOpen', parameters);
        return { entry, projectId: session.projectId, sessionId };
    }

    /**
     * Reads `workbench.externalEditor` here, in Server Core, so the `openInEditor` command Main receives is
     * self-contained. Main must not resolve it itself: the only call a Desktop command handler may make back to Server
     * Core is the dedicated `desktop-target.consume` lane, which `control-server.ts` deliberately routes around the
     * per-connection ordered queue. Any ordinary request Main issues while servicing a Desktop command instead queues
     * behind the very `project.openInEditor` dispatch that is waiting for Main's reply, so both sides stall until the
     * 15s Desktop command timeout fires.
     */
    private async resolveEditorCommand(signal?: AbortSignal): Promise<string | undefined> {
        const settings = signal
            ? await this.options.domainService.requestWithSignal('settings.get', {}, signal)
            : await this.options.domainService.request('settings.get', {});
        const command = settings.value['workbench.externalEditor']?.trim();
        return command === '' ? undefined : command;
    }

    private async resolveProjectRoot(projectId: string): Promise<AuthorizedEntry> {
        const state = await this.options.domainService.request('app.bootstrap');
        const project = state.projects.find((candidate) => candidate.id === projectId);
        if (!project) throw new CaxriError('NOT_FOUND', 'Project not found');
        return authorizeProjectRoot(project);
    }

    async status(): Promise<DesktopStatus> {
        const lease = this.options.bridge.lease();
        if (!lease) return { state: 'offline' };
        const result = await this.options.bridge.invoke({ kind: 'status' }, lease.generation);
        if (
            typeof result !== 'object' ||
            result === null ||
            !('state' in result) ||
            (result.state !== 'background' && result.state !== 'window')
        )
            throw new CaxriError('INTERNAL', 'Desktop returned an invalid status');
        return { state: result.state, generation: lease.generation };
    }

    async focus(shouldLaunch: boolean): Promise<{ state: 'focused'; generation: number }> {
        const lease = await this.requireLease(shouldLaunch);
        await this.options.bridge.invoke({ kind: 'focus' }, lease.generation);
        return { state: 'focused', generation: lease.generation };
    }

    /**
     * Reads or advances Desktop Main's app update for a paired phone. Never launches Desktop: an update needs the Main
     * that will restart, so `offline` is the answer when none is attached.
     */
    async update(
        action: 'check' | 'download' | 'read',
    ): Promise<UpdateState | 'offline' | 'unsupported'> {
        const lease = this.options.bridge.lease();
        if (!lease) return 'offline';
        const result = await this.options.bridge.invoke(
            { kind: 'update', action },
            lease.generation,
        );
        if (isUnsupportedDesktopUpdate(result)) return 'unsupported';
        const parsed = updateStateSchema.safeParse(result);
        if (!parsed.success) throw invalidDesktopUpdate();
        return parsed.data;
    }

    /**
     * Asks Desktop Main to restart into the staged `version` the phone confirmed. Main answers before it starts
     * quitting, so `restarting` reaches the phone ahead of the disconnect.
     */
    async installUpdate(version: string): Promise<RemoteUpdateInstallResult> {
        const lease = this.options.bridge.lease();
        if (!lease) return { outcome: 'blocked', reason: 'desktop-offline' };
        const result = await this.options.bridge.invoke(
            { kind: 'update', action: 'install', version },
            lease.generation,
        );
        if (isUnsupportedDesktopUpdate(result))
            return { outcome: 'blocked', reason: 'unsupported' };
        const parsed = remoteUpdateInstallResultSchema.safeParse(result);
        if (!parsed.success) throw invalidDesktopUpdate();
        return parsed.data;
    }

    async discard(
        parameters: ServerOperationParameters<'git.discard'>,
        signal?: AbortSignal,
        context?: WorkbenchRequestContext,
    ): Promise<ServerOperationResult<'git.discard'>> {
        assertNotCancelled(signal);
        const lease = await this.requireLease(false);
        const preflightParameters: ServerOperationParameters<'git.discard.preflight'> = {
            repositoryId: parameters.repositoryId,
            scope:
                parameters.scope.kind === 'all'
                    ? { kind: 'all' }
                    : { kind: 'file', path: parameters.scope.path },
            sessionId: parameters.sessionId,
        };
        const preflight = context
            ? await this.options.domainService.requestInWorkbenchContext(
                  'git.discard.preflight',
                  preflightParameters,
                  context,
                  undefined,
                  signal,
              )
            : signal
              ? await this.options.domainService.requestWithSignal(
                    'git.discard.preflight',
                    preflightParameters,
                    signal,
                )
              : await this.options.domainService.request(
                    'git.discard.preflight',
                    preflightParameters,
                );
        assertNotCancelled(signal);
        if (preflight.status === 'noop') return null;
        const isConfirmed = isDesktopConfirmationAccepted(
            await this.options.bridge.invoke(
                {
                    kind: 'confirmGitDiscard',
                    target: {
                        repositoryName: preflight.repositoryName,
                        scope: preflight.scope,
                    },
                },
                lease.generation,
            ),
        );
        assertNotCancelled(signal);
        if (!isConfirmed) return { canceled: true };
        return context
            ? this.options.domainService.requestInWorkbenchContext(
                  'git.discard.apply',
                  { token: preflight.token },
                  context,
              )
            : this.options.domainService.request('git.discard.apply', { token: preflight.token });
    }

    async open(
        operation: 'open' | 'openInEditor' | 'openWithDefaultApp' | 'reveal',
        requestedKind: 'directory' | 'file' | undefined,
        parameters: {
            launchIfNeeded: boolean;
            path: string;
            sessionId?: string;
            expectedIdentity?: ExpectedIdentity;
            location?: EditorNavigationTarget;
            focusEditor?: boolean;
        },
        signal?: AbortSignal,
        context?: WorkbenchRequestContext,
    ): Promise<{
        state: 'opened' | 'requested' | 'revealed';
        generation: number;
        projectId: string;
        sessionId: string;
    }> {
        assertNotCancelled(signal);
        const resolved = await this.resolveTarget(
            parameters.path,
            parameters.sessionId,
            signal,
            context,
        );
        assertNotCancelled(signal);
        if (
            parameters.expectedIdentity &&
            !isExpectedIdentity(resolved.entry, parameters.expectedIdentity)
        )
            throw new CaxriError(
                'CONFLICT',
                'Desktop target changed after Terminal link authorization',
            );
        if (requestedKind && resolved.entry.kind !== requestedKind)
            throw new CaxriError(
                'VALIDATION',
                requestedKind === 'file'
                    ? 'The requested Desktop target is not a file'
                    : 'The requested Desktop target is not a directory',
            );
        const editorCommand =
            operation === 'openInEditor' ? await this.resolveEditorCommand(signal) : undefined;
        assertNotCancelled(signal);
        /**
         * Reject a raw target in Server Core before a CLI open is allowed to launch Desktop.
         */
        const lease = await this.requireLease(parameters.launchIfNeeded);
        const target = this.issueTarget(
            operation,
            lease.generation,
            resolved,
            parameters.location,
            parameters.focusEditor,
        );
        const invoked: DesktopOperation =
            operation === 'openInEditor'
                ? {
                      kind: 'openInEditor',
                      targetId: target.id,
                      ...(editorCommand && { editorCommand }),
                  }
                : { kind: operation, targetId: target.id };
        try {
            await this.options.bridge.invoke(invoked, lease.generation);
        } catch (error) {
            this.targets.delete(target.id);
            throw error;
        }
        return {
            /**
             * Renderer work is intentionally one-shot and asynchronous after Main dispatches it.
             */
            state:
                operation === 'reveal'
                    ? 'revealed'
                    : operation === 'openInEditor' || operation === 'openWithDefaultApp'
                      ? 'opened'
                      : 'requested',
            generation: lease.generation,
            projectId: resolved.projectId,
            sessionId: resolved.sessionId,
        };
    }

    async openProjectRoot(
        parameters: ServerOperationParameters<'project.openRoot'>,
    ): Promise<ServerOperationResult<'project.openRoot'>> {
        const entry = await this.resolveProjectRoot(parameters.projectId);
        const operation = parameters.application === 'finder' ? 'reveal' : 'openInEditor';
        const editorCommand =
            operation === 'openInEditor' ? await this.resolveEditorCommand() : undefined;
        const lease = await this.requireLease(false);
        const target = this.issueTarget(operation, lease.generation, {
            entry,
            projectId: parameters.projectId,
            projectRootId: parameters.projectId,
        });
        try {
            await this.options.bridge.invoke(
                operation === 'reveal'
                    ? { kind: 'reveal', targetId: target.id }
                    : {
                          kind: 'openInEditor',
                          targetId: target.id,
                          ...(editorCommand && { editorCommand }),
                      },
                lease.generation,
            );
        } catch (error) {
            this.targets.delete(target.id);
            throw error;
        }
        return {
            state: operation === 'reveal' ? 'revealed' : 'opened',
            generation: lease.generation,
            projectId: parameters.projectId,
        };
    }

    async consumeTarget(targetId: string, generation: number): Promise<DesktopTargetPayload> {
        const target = this.targets.get(targetId);
        if (!target) throw new CaxriError('NOT_FOUND', 'Desktop target is missing or already used');
        this.targets.delete(targetId);
        if (target.expiresAt < this.now())
            throw new CaxriError('NOT_FOUND', 'Desktop target expired');
        if (target.generation !== generation)
            throw new CaxriError('CONFLICT', 'Desktop target belongs to a stale generation');
        if (target.projectRootId) {
            const current = await this.resolveProjectRoot(target.projectRootId);
            if (!isSameIdentity(target.entry, current))
                throw new CaxriError('CONFLICT', 'Project root changed before use');
            if (target.operation !== 'reveal' && target.operation !== 'openInEditor')
                throw new CaxriError(
                    'PATH_DENIED',
                    'Project root target cannot perform this operation',
                );
            return {
                targetId,
                operation: target.operation,
                kind: 'directory',
                projectId: target.projectRootId,
                path: current.path,
            };
        }
        if (!target.sessionId)
            throw new CaxriError('PATH_DENIED', 'Desktop target has no Session authority');
        const current = await this.options.domainService.request('files.authorizeOpen', {
            sessionId: target.sessionId,
            path: target.entry.path,
        });
        if (!isSameIdentity(target.entry, current))
            throw new CaxriError('CONFLICT', 'Desktop target changed before use');
        return {
            targetId,
            operation: target.operation,
            kind: current.kind,
            sessionId: target.sessionId,
            path: current.path,
            ...(target.location && { location: target.location }),
            ...(target.focusEditor && { focusEditor: target.focusEditor }),
        };
    }
}
