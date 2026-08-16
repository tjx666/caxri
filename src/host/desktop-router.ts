import { randomUUID } from 'node:crypto';

import { CaxriError, isCaxriError } from '../shared/ipc/errors';
import type {
    DesktopLease,
    DesktopOperation,
    DesktopTargetPayload,
} from '../shared/ipc/local-transport';
import type { RuntimeMethodResult } from '../shared/ipc/methods';
import type { HostRuntimeSupervisor } from './runtime-supervisor';

type AuthorizedEntry = RuntimeMethodResult<'files.authorizeOpen'>;
type BootstrapState = RuntimeMethodResult<'app.bootstrap'>;
type DesktopStatus = { state: 'offline' } | { state: 'background' | 'window'; generation: number };

interface StoredTarget {
    entry: AuthorizedEntry;
    expiresAt: number;
    generation: number;
    id: string;
    operation: 'open' | 'reveal';
    projectId: string;
    sessionId: string;
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
    runtime: Pick<HostRuntimeSupervisor, 'request'>;
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
        operation: 'open' | 'reveal',
        generation: number,
        resolved: { entry: AuthorizedEntry; projectId: string; sessionId: string },
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
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        const state = await this.options.runtime.request('app.bootstrap');
        if (requestedSessionId)
            return this.resolveRequestedSession(state, requestedSessionId, path);

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
    ): Promise<{ entry: AuthorizedEntry; projectId: string; sessionId: string }> {
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        if (!session) throw new CaxriError('NOT_FOUND', 'Session not found');
        if (session.archivedAt !== undefined)
            throw new CaxriError('CONFLICT', 'Archived Sessions cannot receive Desktop targets');
        const entry = await this.options.runtime.request('files.authorizeOpen', {
            sessionId,
            path,
        });
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

    async open(
        operation: 'open' | 'reveal',
        requestedKind: 'directory' | 'file' | undefined,
        parameters: { launchIfNeeded: boolean; path: string; sessionId?: string },
    ): Promise<{
        state: 'requested' | 'revealed';
        generation: number;
        projectId: string;
        sessionId: string;
    }> {
        const resolved = await this.resolveTarget(parameters.path, parameters.sessionId);
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
        const target = this.issueTarget(operation, lease.generation, resolved);
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
            state: operation === 'reveal' ? 'revealed' : 'requested',
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
        const current = await this.options.runtime.request('files.authorizeOpen', {
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
        };
    }
}
