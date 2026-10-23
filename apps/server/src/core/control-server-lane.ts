import {
    isConcurrentRead,
    isExtensionViewOperationName,
    isExtensionViewReadOperation,
} from '@caxri/protocol';

import type { ControlSocketTerminationReason, OrderedQueueTiming } from './control-server-support';

const SELF_SERIALIZED_OPERATIONS = new Set([
    'agentChat.saveLongPaste',
    'files.copy',
    'terminal.prepareLongPaste',
]);

/**
 * Core Git writes a client can issue on its own connection (the Renderer's branch picker, Desktop Main's confirmed
 * discard). They share the repository lane with Extension mutations because an Extension Git sync runs `git pull`, and
 * a checkout that lands between its fetch and merge would merge the old branch's upstream into the new branch.
 */
const REPO_GIT_WRITES = new Set([
    'git.discard.apply',
    'git.mergePullRequest',
    'git.switchBranch',
    'git.sync',
]);

/**
 * `viewContainers.viewOperation` is one `control` method that multiplexes Extension view reads and the `source.action`
 * mutation, so the lane decision has to look at the operation. A read operation (`cancellation: 'reject'` in
 * `extensionViewOperationMetadata`) is admitted in order, then settles outside the lane because every layer below
 * already tolerates overlap with later work: Core `ExtensionService.viewOperation` re-asserts the active view context
 * and the provider generation after each await, the Git provider bumps its model revision synchronously and rejects a
 * superseded snapshot or history read after each await, those rejections map to CANCELLED, and the Renderer cancels a
 * replaced snapshot through `viewContainers.cancelRequest` anyway. Production (0.0.95) showed why it matters: a 9.8s
 * `source.snapshot` waiting on a nested Git summary held the Desktop lane and queued `commander.status` and
 * `app.records` for the same 9.8s.
 */
function isExtensionViewRead(parameters: unknown): boolean {
    if (typeof parameters !== 'object' || parameters === null) return false;
    const { operation } = parameters as { operation?: unknown };
    return (
        typeof operation === 'string' &&
        isExtensionViewOperationName(operation) &&
        isExtensionViewReadOperation(operation)
    );
}

/**
 * True for the all-Session Workbench Root sweep: `session.validateWorkbenchRoots` without a `sessionId`. Desktop Main
 * sends it on every app activation and window focus and ignores the reply, yet it forces a Git topology read per owning
 * Project behind the shared Git command budget. Production logged 10 Session switches queued 300-530ms behind it, twice
 * for about 7s. Nothing orders a later request after it: the sweep revalidates each binding after its awaits and a
 * newer selection wins, and the Server already coalesces overlapping sweeps. The per-Session form is a deliberate user
 * action whose result the caller reads, so it stays ordered.
 */
function isBackgroundSweep(request: { method: string; params?: unknown }): boolean {
    if (request.method !== 'session.validateWorkbenchRoots') return false;
    const parameters = request.params;
    if (typeof parameters !== 'object' || parameters === null) return true;
    return (parameters as { sessionId?: unknown }).sessionId === undefined;
}

/**
 * The lane a control request settles in. `read` and `self-serialized` requests leave the ordered lane after admission;
 * `repository` and `background` requests move to their own chains; everything else is `ordered` and holds the lane
 * until it settles. A new write defaults to `ordered`, which is the wrong lane for anything slow whose caller does not
 * need later requests to wait: classify it explicitly in the lane test (`control-server-lane.test.ts`).
 */
export type ControlLane = 'background' | 'ordered' | 'read' | 'repository' | 'self-serialized';

export function classifyControlLane(request: { method: string; params?: unknown }): ControlLane {
    if (isConcurrentRead(request.method)) return 'read';
    if (isRepoMutation(request)) return 'repository';
    if (isBackgroundSweep(request)) return 'background';
    if (shouldSettleOutsideOrderedLane(request)) return 'self-serialized';
    return 'ordered';
}

/**
 * Reads do not carry mutation ordering. Long-running operations may also settle independently only when their domain
 * service serializes its own shared mutations and revalidates authority after every await boundary.
 */
export function shouldSettleOutsideOrderedLane(request: {
    method: string;
    params?: unknown;
}): boolean {
    return (
        isConcurrentRead(request.method) ||
        SELF_SERIALIZED_OPERATIONS.has(request.method) ||
        (request.method === 'viewContainers.viewOperation' && isExtensionViewRead(request.params))
    );
}

/**
 * True for a write that runs in the connection's repository lane instead of holding its ordered lane: an Extension
 * mutation (`viewContainers.executeCommand`, or a `source.action` view operation) or a core Git write.
 *
 * Extension mutations run arbitrary work (Git sync, discard, a pull request merge that waits on `gh pr merge` for
 * seconds) and nothing below the lane serializes them: the Extension Host dispatches requests concurrently and the Git
 * domain has no per-repository mutation queue. So they still run one at a time, and only after every earlier ordered
 * request settled, but a later Session switch no longer waits for them. Production (0.0.122) showed why it matters: a
 * 7.8s Status panel merge held the Desktop lane, so a Session tab click's `session.select` queued for 6s before its
 * 33ms handler ran.
 */
function isRepoMutation(request: { method: string; params?: unknown }): boolean {
    if (request.method === 'viewContainers.executeCommand') return true;
    if (request.method === 'viewContainers.viewOperation')
        return !isExtensionViewRead(request.params);
    return REPO_GIT_WRITES.has(request.method);
}

/**
 * How long {@link LaneRegistry.drain} waits. A sweep is bounded by Git's own command timeouts, but shutdown must not
 * hang on a wedged one, so it gives up after this and lets the process exit.
 */
const BACKGROUND_DRAIN_MS = 2000;

/**
 * Creates each control connection's lanes and tracks background-lane requests across every control connection so
 * `ControlServer.close()` can wait for a running Workbench Root sweep instead of tearing the Server down underneath it.
 * It holds only requests that are running now, so a closed connection leaves nothing behind. Only the background lane
 * is awaited: an ordered or repository request may be waiting on a peer that never answers.
 */
export class LaneRegistry {
    private readonly running = new Set<Promise<void>>();

    /**
     * Creates the lanes for one control connection, sharing this registry's background tracking.
     */
    connection(fail: (reason: ControlSocketTerminationReason) => void): ControlConnectionLanes {
        return new ControlConnectionLanes(fail, this);
    }

    track(work: Promise<void>): Promise<void> {
        this.running.add(work);
        const forget = (): void => {
            this.running.delete(work);
        };
        // eslint-disable-next-line unicorn/prefer-await -- bookkeeping must not change the caller's promise
        work.then(forget).catch(forget);
        return work;
    }

    /**
     * Resolves when no tracked request is running, or after {@link BACKGROUND_DRAIN_MS}.
     */
    async drain(): Promise<void> {
        if (this.running.size === 0) return;
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, BACKGROUND_DRAIN_MS);
        });
        try {
            await Promise.race([Promise.allSettled(this.running), timeout]);
        } finally {
            clearTimeout(timer);
        }
    }
}

/**
 * One control connection's request lanes. The ordered lane preserves handshake, control, and mutation order across
 * repeated invocations of the socket's synchronous 'data' handler, so Promise chaining stands in for `await`, which
 * cannot span callbacks. After ordered admission a read settles independently, a repository mutation moves on to the
 * repository lane, and every other request holds the ordered lane until it settles.
 */
export class ControlConnectionLanes {
    private ordered = Promise.resolve();
    private repo = Promise.resolve();
    private background = Promise.resolve();
    private orderedBacklog = 0;

    constructor(
        private readonly fail: (reason: ControlSocketTerminationReason) => void,
        private readonly registry: LaneRegistry,
    ) {}

    /**
     * Runs `handle` once every frame that arrived earlier on this connection has been admitted.
     */
    admit(handle: (timing: OrderedQueueTiming) => Promise<void>): void {
        const enqueuedAt = performance.now();
        this.orderedBacklog += 1;
        const timing: OrderedQueueTiming = { enqueuedAt, queueDepth: this.orderedBacklog };
        this.ordered = this.ordered
            // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
            .then(() => handle(timing))
            // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
            .catch(() => this.fail('queue-processing-failed'))
            // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
            .finally(() => {
                // Reads and repository mutations continue independently after their admission entry.
                this.orderedBacklog -= 1;
            });
    }

    /**
     * Settles one admitted request in its lane. Resolves once the ordered lane may admit the next frame, which for a
     * read or a repository mutation is before the request itself settles; `failure` names a dispatch that rejected
     * after the ordered lane let go of it.
     */
    async settle(
        request: { method: string; params?: unknown },
        timing: OrderedQueueTiming,
        dispatch: (timing: OrderedQueueTiming) => Promise<void>,
        failure: ControlSocketTerminationReason,
    ): Promise<void> {
        if (isConcurrentRead(request.method)) {
            // eslint-disable-next-line unicorn/prefer-await -- reads settle outside the ordered lane
            dispatch(timing).catch(() => this.fail(failure));
            return;
        }
        if (isRepoMutation(request)) {
            const repoTiming: OrderedQueueTiming = { ...timing, lane: 'repository' };
            this.repo = this.repo
                // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
                .then(() => dispatch(repoTiming))
                // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
                .catch(() => this.fail(failure));
            return;
        }
        if (isBackgroundSweep(request)) {
            const backgroundTiming: OrderedQueueTiming = { ...timing, lane: 'background' };
            // Registered the moment it is queued, not when it starts, so `drain()` also waits for a sweep that is still
            // behind an earlier one on this connection.
            this.background = this.registry.track(
                this.background
                    // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
                    .then(() => dispatch(backgroundTiming))
                    // eslint-disable-next-line unicorn/prefer-await -- see the class note on callback chaining
                    .catch(() => this.fail(failure)),
            );
            return;
        }
        await dispatch(timing);
    }
}
