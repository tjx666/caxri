import { useCallback, useEffect, useState } from 'react';

import type { MethodResult } from '@caxri/protocol';

import { useReadCache } from '../../read-cache/read-cache-context';
import { cachedAgentAvailabilitySchema } from '../../read-cache/read-cache-model';

type AgentAvailabilityResult = MethodResult<'mobile.agent.availability'>;

export interface SavedAgentAvailability {
    /**
     * The pairing the answer was read under; another pairing's answer is never shown.
     */
    scope: string;
    value: AgentAvailabilityResult;
}

/**
 * The Agent availability answer this pairing last read, and the writer that keeps it current after each live read.
 * Loaded with the computer's Session list rather than when New Session opens, so the screen's first frame already has
 * it.
 */
export const useSavedAgentAvailability = (connectionScopeKey: string | null) => {
    const readCache = useReadCache();
    const [saved, setSaved] = useState<SavedAgentAvailability | null>(null);
    useEffect(() => {
        if (connectionScopeKey === null) return;
        let isActive = true;
        void readCache
            .load(connectionScopeKey, { kind: 'agentAvailability' }, cachedAgentAvailabilitySchema)
            .then((entry) => {
                if (isActive && entry)
                    setSaved((current) =>
                        // A live answer saved while the file was read is newer than the file.
                        current?.scope === connectionScopeKey
                            ? current
                            : { scope: connectionScopeKey, value: entry.value },
                    );
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache]);
    const save = useCallback(
        (scope: string, value: AgentAvailabilityResult): void => {
            setSaved({ scope, value });
            readCache.save(scope, { kind: 'agentAvailability' }, value);
        },
        [readCache],
    );
    return { save, saved };
};
