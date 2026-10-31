import { useCallback, useMemo, useState } from 'react';

import type { MobilePreviewTarget } from '@caxri/protocol';
import { useQuery } from '@tanstack/react-query';
import { router, useIsFocused } from 'expo-router';

import { useTranslation } from '../../i18n';
import { openLink } from '../../lib/open-link';
import { useMobileClient } from '../connection/mobile-client-provider';
import { isSessionPreviewObservable } from './preview-availability';

/**
 * How often a visible Session re-reads its listening ports: soon enough that a dev server an Agent just started shows
 * up during a glance, rarely enough that `lsof` stays negligible on the computer.
 */
const PREVIEW_POLL_MS = 10_000;

/**
 * The local web servers of one Session that a `control` device can preview, and the action that opens one in the in-app
 * browser, passing `label` (`Preview · :5173`) as the browser route's page title. Other roles never ask: the Server
 * would refuse them. Nor does a Relay connection (`isSessionPreviewObservable`).
 */
export const useSessionPreviews = (
    sessionId: string,
    deviceRole: 'view' | 'reply' | 'control' | null,
) => {
    const { t } = useTranslation();
    const { connectionScopeKey, isForeground, request, route, status } = useMobileClient();
    const isFocused = useIsFocused();
    const queryKey = useMemo(
        () => ['mobile', 'preview', connectionScopeKey ?? 'unpaired', sessionId] as const,
        [connectionScopeKey, sessionId],
    );
    const isObservable = isSessionPreviewObservable({
        connectionScopeKey,
        deviceRole,
        isFocused,
        isForeground,
        route,
        status,
    });
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
                // The in-app browser titles the page with `label` instead of the proxy's loopback URL.
                const label = t('browser.preview.pageLabel', { port: target.port });
                openLink(url, {
                    navigate: (page) =>
                        router.push({ params: { label, url: page }, pathname: '/browser' }),
                });
                return true;
            } catch {
                void query.refetch();
                return false;
            } finally {
                setOpeningPort(null);
            }
        },
        [query, request, sessionId, t],
    );
    const targets: readonly MobilePreviewTarget[] = isObservable ? (query.data?.targets ?? []) : [];
    return {
        open,
        openingPort,
        targets,
    };
};
