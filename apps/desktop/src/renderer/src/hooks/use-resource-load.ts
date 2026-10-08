import { useCallback, useEffect, useState } from 'react';

interface ResourceLoadFailure {
    error: unknown;
}

interface ResourceLoadScope {
    target: string;
    enabled: boolean;
    load: () => Promise<ResourceLoadFailure | undefined>;
    attempt: number;
}

interface ResourceLoadOutcome {
    scope: ResourceLoadScope;
    failure?: ResourceLoadFailure;
}

/**
 * Whether the scope held in state still describes what this render asks for. Every part is compared by identity,
 * including `load`: a caller whose loader closure changed is reading something else, even when `target` reads the same,
 * and `attempt` is what makes Retry a new read rather than a no-op.
 */
export function isCurrentResourceLoadScope(
    scope: ResourceLoadScope,
    next: Omit<ResourceLoadScope, 'attempt'> & { attempt: number },
): boolean {
    return (
        scope.target === next.target &&
        scope.enabled === next.enabled &&
        scope.load === next.load &&
        scope.attempt === next.attempt
    );
}

/**
 * The failure to show for the scope being rendered. An outcome is claimed only by the exact scope object that requested
 * it, so a read that lands after the target changed, after Retry started a new attempt, or after the caller disabled
 * the surface paints nothing: the identity check is the whole stale-result defense.
 */
export function currentResourceLoadFailure(
    outcome: ResourceLoadOutcome | undefined,
    scope: ResourceLoadScope,
    isEnabled: boolean,
): ResourceLoadFailure | undefined {
    return isEnabled && outcome?.scope === scope ? outcome.failure : undefined;
}

/**
 * Holds a recoverable read outcome while the caller's cache remains the document authority. Changing the target,
 * loader, or enabled lifetime hides the old failure before paint; late results cannot overwrite a newer attempt.
 */
export function useResourceLoad({ target, enabled, load }: Omit<ResourceLoadScope, 'attempt'>) {
    const [attempt, setAttempt] = useState(0);
    const [scope, setScope] = useState<ResourceLoadScope>({ target, enabled, load, attempt });
    const [outcome, setOutcome] = useState<ResourceLoadOutcome>();
    if (!isCurrentResourceLoadScope(scope, { target, enabled, load, attempt }))
        setScope({ target, enabled, load, attempt });

    useEffect(() => {
        if (!scope.enabled) return;
        let isDisposed = false;
        const run = async (): Promise<void> => {
            let failure: ResourceLoadFailure | undefined;
            try {
                failure = await scope.load();
            } catch (error) {
                failure = { error };
            }
            if (!isDisposed) setOutcome({ scope, failure });
        };
        // eslint-disable-next-line no-void -- expected and unexpected read failures become the recoverable outcome
        void run();
        return () => {
            isDisposed = true;
        };
    }, [scope]);

    const retry = useCallback(() => setAttempt((value) => value + 1), []);
    return { failure: currentResourceLoadFailure(outcome, scope, enabled), retry };
}
