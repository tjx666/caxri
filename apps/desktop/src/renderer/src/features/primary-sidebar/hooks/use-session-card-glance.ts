import { useCaxriQuery } from '../../../queries/client';

/**
 * Process readings are a single `ps` sample: reopening the card a few seconds later re-samples instead of showing a
 * figure that already moved, while a quick hover sweep back and forth reuses the last one.
 */
const RESOURCES_STALE_MS = 3_000;
/**
 * Spend only moves while an Agent works, and each read waits on the usage ledger's sync, so it is refreshed less often.
 */
const COST_STALE_MS = 30_000;

/**
 * The live figures of the Session card, read once when the card opens and never polled, so a closed card costs nothing.
 * Only the opened card's content mounts this hook, which keeps every closed row out of these subscriptions.
 */
export function useSessionCardGlance(sessionId: string) {
    const resources = useCaxriQuery(
        'terminal.sessionResources',
        { sessionId },
        { staleTime: RESOURCES_STALE_MS },
    );
    const cost = useCaxriQuery('usage.sessionCost', { sessionId }, { staleTime: COST_STALE_MS });
    return {
        cost: cost.data,
        isLoading: resources.isPending || cost.isPending,
        resources: resources.data,
    };
}
