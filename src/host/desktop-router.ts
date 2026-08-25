import { randomUUID } from 'node:crypto';

import { CaxriError, isCaxriError } from '../shared/ipc/errors';
import type {
    DesktopLease,
    DesktopOperation,
    DesktopTargetPayload,
} from '../shared/ipc/local-transport';
import type {
    RuntimeMethodParams as RuntimeMethodParameters,
    RuntimeMethodResult,
} from '../shared/ipc/methods';
import type { RuntimeWorkbenchContext } from '../shared/ipc/transport';
import type { HostRuntimeSupervisor } from './runtime-supervisor';

type AuthorizedEntry = RuntimeMethodResult<'files.authorizeOpen'>;
type ExpectedIdentity = NonNullable<
    RuntimeMethodParameters<'desktop.openFile'>['expectedIdentity']
>;
type BootstrapState = RuntimeMethodResult<'app.bootstrap'>;
type DesktopStatus = { state: 'offline' } | { state: 'background' | 'window'; generation: number };

interface StoredTarget {
    entry: AuthorizedEntry;
    expiresAt: number;
    generation: number;
    id: string;
    operation: 'open' | 'openInEditor' | 'reveal' | 'trash';
    projectId?: string;
    sessionId: string;
    location?: { column: number; line: number };
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
    runtime: Pick<
        HostRuntimeSupervisor,
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

function assertNotCancelled(signal?: AbortSignal): void {
    if (signal?.aborted) throw new CaxriError('CANCELLED', 'Desktop operation was cancelled');
}

/**
 * Resolves raw paths inside Runtime, then exposes only one-use generation-bound targets to Main.
 */
export class HostDesktopRouter {
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
        operation: 'open' | 'openInEditor' | 'reveal' | 'trash',
        generation: number,
        resolved: { entry: AuthorizedEntry; projectId?: string; sessionId: string },
        location?: { column: number; line: number },
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
        context?: RuntimeWorkbenchContext,
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        if (context && requestedSessionId !== context.sessionId)
            throw new CaxriError('PATH_DENIED', 'Desktop request context is inconsistent');
        const state = await this.options.runtime.request('app.bootstrap');
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
                        const entry = await this.options.runtime.request('files.authorizeOpen', {
                            sessionId: session.id,
                            path,
                        });
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
            throw new CaxriError('PATH_DENIED', 'Path is outside every added Project');
        matches.sort((left, right) => right.entry.root.path.length - left.entry.root.path.length);
        if (matches[1] && matches[1].entry.root.path.length === matches[0].entry.root.path.length)
            throw new CaxriError('CONFLICT', 'Path matches more than one Project');
        const projectId = matches[0].projectId;
        const sessions = activeSessions.filter((session) => session.projectId === projectId);
        const selected = sessions.find((session) => session.id === state.selectedSessionId);
        const session = selected ?? (sessions.length === 1 ? sessions[0] : undefined);
        if (!session)
            throw new CaxriError('CONFLICT', 'Select a Session explicitly for this Project');
        const entry = await this.options.runtime.request('files.authorizeOpen', {
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
        context?: RuntimeWorkbenchContext,
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (session.archivedAt !== undefined)
            throw new CaxriError('CONFLICT', 'Archived Sessions cannot receive Desktop targets');
        const parameters = { sessionId, path };
        const entry = context
            ? await this.options.runtime.requestInWorkbenchContext(
                  'files.authorizeOpen',
                  parameters,
                  context,
                  undefined,
                  signal,
              )
            : signal
              ? await this.options.runtime.requestWithSignal(
                    'files.authorizeOpen',
                    parameters,
                    signal,
                )
              : await this.options.runtime.request('files.authorizeOpen', parameters);
        return { entry, projectId: session.projectId, sessionId };
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

    async trash(
        parameters: RuntimeMethodParameters<'files.trash'>,
        signal?: AbortSignal,
        context?: RuntimeWorkbenchContext,
    ): Promise<RuntimeMethodResult<'files.trash'>> {
        assertNotCancelled(signal);
        const lease = await this.requireLease(false);
        const item = context
            ? await this.options.runtime.requestInWorkbenchContext(
                  'files.authorizeTrash',
                  parameters,
                  context,
                  undefined,
                  signal,
              )
            : signal
              ? await this.options.runtime.requestWithSignal(
                    'files.authorizeTrash',
                    parameters,
                    signal,
                )
              : await this.options.runtime.request('files.authorizeTrash', parameters);
        assertNotCancelled(signal);
        const isConfirmed = isDesktopConfirmationAccepted(
            await this.options.bridge.invoke(
                {
                    kind: 'confirmFilesTrash',
                    item: {
                        name: item.name,
                        path: item.path,
                        ...(parameters.hasUnsavedChanges !== undefined && {
                            hasUnsavedChanges: parameters.hasUnsavedChanges,
                        }),
                    },
                },
                lease.generation,
            ),
        );
        assertNotCancelled(signal);
        if (!isConfirmed) return { canceled: true };
        const target = this.issueTarget('trash', lease.generation, {
            entry: item,
            sessionId: parameters.sessionId,
        });
        try {
            await this.options.bridge.invoke(
                { kind: 'trash', targetId: target.id },
                lease.generation,
            );
        } catch (error) {
            this.targets.delete(target.id);
            throw error;
        }
        return { kind: item.kind, name: item.name, path: item.path };
    }

    async discard(
        parameters: RuntimeMethodParameters<'git.discard'>,
        signal?: AbortSignal,
        context?: RuntimeWorkbenchContext,
    ): Promise<RuntimeMethodResult<'git.discard'>> {
        assertNotCancelled(signal);
        const lease = await this.requireLease(false);
        const preflightParameters: RuntimeMethodParameters<'git.discard.preflight'> = {
            repositoryId: parameters.repositoryId,
            scope:
                parameters.scope.kind === 'all'
                    ? { kind: 'all' }
                    : { kind: 'file', path: parameters.scope.path },
            sessionId: parameters.sessionId,
        };
        const preflight = context
            ? await this.options.runtime.requestInWorkbenchContext(
                  'git.discard.preflight',
                  preflightParameters,
                  context,
                  undefined,
                  signal,
              )
            : signal
              ? await this.options.runtime.requestWithSignal(
                    'git.discard.preflight',
                    preflightParameters,
                    signal,
                )
              : await this.options.runtime.request('git.discard.preflight', preflightParameters);
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
            ? this.options.runtime.requestInWorkbenchContext(
                  'git.discard.apply',
                  { token: preflight.token },
                  context,
              )
            : this.options.runtime.request('git.discard.apply', { token: preflight.token });
    }

    async open(
        operation: 'open' | 'openInEditor' | 'reveal',
        requestedKind: 'directory' | 'file' | undefined,
        parameters: {
            launchIfNeeded: boolean;
            path: string;
            sessionId?: string;
            expectedIdentity?: ExpectedIdentity;
            location?: { column: number; line: number };
        },
        signal?: AbortSignal,
        context?: RuntimeWorkbenchContext,
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
        /**
         * Reject a raw target in the headless Host before a CLI open is allowed to launch Desktop.
         */
        const lease = await this.requireLease(parameters.launchIfNeeded);
        const target = this.issueTarget(operation, lease.generation, resolved, parameters.location);
        try {
            await this.options.bridge.invoke(
                { kind: operation, targetId: target.id },
                lease.generation,
            );
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
                    : operation === 'openInEditor'
                      ? 'opened'
                      : 'requested',
            generation: lease.generation,
            projectId: resolved.projectId,
            sessionId: resolved.sessionId,
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
        const current = await this.options.runtime.request(
            target.operation === 'trash' ? 'files.authorizeTrash' : 'files.authorizeOpen',
            { sessionId: target.sessionId, path: target.entry.path },
        );
        if (!isSameIdentity(target.entry, current))
            throw new CaxriError('CONFLICT', 'Desktop target changed before use');
        return {
            targetId,
            operation: target.operation,
            kind: current.kind,
            sessionId: target.sessionId,
            path: current.path,
            ...(target.location && { location: target.location }),
        };
    }
}
