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

/**
 * Holds a recoverable read outcome while the caller's cache remains the document authority. Changing the target,
 * loader, or enabled lifetime hides the old failure before paint; late results cannot overwrite a newer attempt.
 */
export function useResourceLoad({ target, enabled, load }: Omit<ResourceLoadScope, 'attempt'>) {
    const [attempt, setAttempt] = useState(0);
    const [scope, setScope] = useState<ResourceLoadScope>({ target, enabled, load, attempt });
    const [outcome, setOutcome] = useState<{
        scope: ResourceLoadScope;
        failure?: ResourceLoadFailure;
    }>();
    if (
        scope.target !== target ||
        scope.enabled !== enabled ||
        scope.load !== load ||
        scope.attempt !== attempt
    )
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
    return { failure: enabled && outcome?.scope === scope ? outcome.failure : undefined, retry };
}
