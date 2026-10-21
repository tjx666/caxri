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
 * One control connection's request lanes. The ordered lane preserves handshake, control, and mutation order across
 * repeated invocations of the socket's synchronous 'data' handler, so Promise chaining stands in for `await`, which
 * cannot span callbacks. After ordered admission a read settles independently, a repository mutation moves on to the
 * repository lane, and every other request holds the ordered lane until it settles.
 */
export class ControlConnectionLanes {
    private ordered = Promise.resolve();
    private repo = Promise.resolve();
    private orderedBacklog = 0;

    constructor(private readonly fail: (reason: ControlSocketTerminationReason) => void) {}

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
        await dispatch(timing);
    }
}
