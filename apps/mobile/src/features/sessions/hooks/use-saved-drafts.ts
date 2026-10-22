import type { Dispatch, SetStateAction } from 'react';
import { useEffect, useState } from 'react';

import { useMobileClient } from '../../connection/mobile-client-provider';
import { useReadCache } from '../../read-cache/read-cache-context';
import { draftsToSave, mergeSavedDrafts, savedDraftsSchema } from '../saved-drafts';
import type { HostSessionUiState } from '../session-ui-state';

/**
 * Keeps unsent composer drafts on the phone for this pairing, so a draft survives the system ending a backgrounded app.
 * Nothing is saved until the earlier copy was read, so an empty launch never overwrites drafts it has not restored
 * yet.
 */
export const useSavedDrafts = (
    draftBySession: HostSessionUiState['draftBySession'],
    setUi: Dispatch<SetStateAction<HostSessionUiState>>,
): void => {
    const { connectionScopeKey } = useMobileClient();
    const readCache = useReadCache();
    const [restoredScope, setRestoredScope] = useState<string | null>(null);
    useEffect(() => {
        if (connectionScopeKey === null) return;
        let isActive = true;
        // eslint-disable-next-line no-void -- An unreadable copy restores nothing; typing continues as before.
        void readCache
            .load(connectionScopeKey, { kind: 'drafts' }, savedDraftsSchema)
            .then((entry) => {
                if (!isActive) return;
                if (entry)
                    setUi((current) => ({
                        ...current,
                        draftBySession: mergeSavedDrafts(current.draftBySession, entry.value),
                    }));
                setRestoredScope(connectionScopeKey);
            });
        return () => {
            isActive = false;
        };
    }, [connectionScopeKey, readCache, setUi]);
    useEffect(() => {
        if (restoredScope === null || restoredScope !== connectionScopeKey) return;
        readCache.save(restoredScope, { kind: 'drafts' }, draftsToSave(draftBySession));
    }, [connectionScopeKey, draftBySession, readCache, restoredScope]);
};
