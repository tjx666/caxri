import { useCallback, useMemo, useState } from 'react';

import type { MobilePreviewTarget } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';
import { useIsFocused } from 'expo-router';

import { openLink } from '../../lib/open-link';
import { useMobileClient } from '../connection/mobile-client-provider';

/**
 * How often a visible Session re-reads its listening ports: soon enough that a dev server an Agent just started shows
 * up during a glance, rarely enough that `lsof` stays negligible on the computer.
 */
const PREVIEW_POLL_MS = 10_000;

/**
 * The local web servers of one Session that a `control` device can preview, and the action that opens one in the in-app
 * browser. Other roles never ask: the Server would refuse them.
 */
export const useSessionPreviews = (
    sessionId: string,
    deviceRole: 'view' | 'reply' | 'control' | null,
) => {
    const { connectionScopeKey, isForeground, request, status } = useMobileClient();
    const isFocused = useIsFocused();
    const queryKey = useMemo(
        () => ['mobile', 'preview', connectionScopeKey ?? 'unpaired', sessionId] as const,
        [connectionScopeKey, sessionId],
    );
    const isObservable =
        deviceRole === 'control' &&
        connectionScopeKey !== null &&
        isForeground &&
        isFocused &&
        status === 'connected';
    const query = useQuery({
        enabled: isObservable,
        gcTime: 60_000,
        networkMode: 'always',
        queryFn: () => request('mobile.preview.list', { sessionId }),
        queryKey,
        refetchInterval: isObservable ? PREVIEW_POLL_MS : false,
        refetchIntervalInBackground: false,
        refetchOnReconnect: true,
        refetchOnWindowFocus: false,
        retry: false,
    });
    const [openingPort, setOpeningPort] = useState<number | null>(null);
    /**
     * Resolves `false` when the computer refused or the port stopped listening, so the caller can say so.
     */
    const open = useCallback(
        async (target: MobilePreviewTarget): Promise<boolean> => {
            setOpeningPort(target.port);
            try {
                const { url } = await request('mobile.preview.open', {
                    port: target.port,
                    sessionId,
                });
                openLink(url);
                return true;
            } catch {
                void query.refetch();
                return false;
            } finally {
                setOpeningPort(null);
            }
        },
        [query, request, sessionId],
    );
    const targets: readonly MobilePreviewTarget[] = isObservable ? (query.data?.targets ?? []) : [];
    return {
        open,
        openingPort,
        targets,
    };
};
