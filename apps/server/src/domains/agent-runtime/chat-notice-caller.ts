import type { AgentChatSnapshot } from '@caxri/protocol';

/**
 * Where a Chat caller stands for a settlement notice (`SettlementNotices`): `idle` takes the notice as a message that
 * starts a turn now; `busy` will be idle again by itself (a turn runs, messages are queued, it is starting or
 * compacting); `paused` needs something other than time (a permission request, a stopped queue, a usage limit, a
 * stopped or failed provider). A missing projection is `undefined`.
 */
export function chatNoticeCallerState(
    snapshot:
        | (Pick<AgentChatSnapshot, 'requests'> &
              Partial<
                  Pick<
                      AgentChatSnapshot,
                      | 'activeTurnId'
                      | 'operation'
                      | 'queue'
                      | 'queueLength'
                      | 'queuePaused'
                      | 'status'
                      | 'usageGuard'
                  >
              >)
        | undefined,
    isWaitingForUsageLimit: boolean,
): 'idle' | 'busy' | 'paused' | undefined {
    if (!snapshot) return undefined;
    if (snapshot.status === 'stopped' || snapshot.status === 'failed') return 'paused';
    if (
        isWaitingForUsageLimit ||
        snapshot.queuePaused ||
        snapshot.usageGuard ||
        snapshot.requests.length > 0
    )
        return 'paused';
    const queued = snapshot.queueLength ?? snapshot.queue?.length ?? 0;
    return snapshot.status === 'starting' ||
        snapshot.activeTurnId ||
        snapshot.operation ||
        queued > 0
        ? 'busy'
        : 'idle';
}
