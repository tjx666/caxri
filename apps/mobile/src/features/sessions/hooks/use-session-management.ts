import { useCallback, useState } from 'react';

import type { AgentProvider } from '@caxri/protocol';

import { useTranslation } from '../../../i18n';
import { useMobileClient } from '../../connection/mobile-client-provider';
import { useHostSessions } from '../components/host-sessions-provider';
import { sessionManagementErrorMessage } from '../session-management-model';

type Action =
    'archive' | 'continue' | 'delete' | 'fork' | 'pin' | 'rename' | 'restore' | 'suggestTitle';

/**
 * The Session actions of a control device: rename (with AI), pin, archive, restore, delete, Fork Session, and Continue
 * in Another Agent. Each change refreshes the dashboard afterwards so the home list reflects it without waiting for the
 * next poll, and a Session the phone then opens is already in that list.
 */
export const useSessionManagement = () => {
    const { request } = useMobileClient();
    const { sessions } = useHostSessions();
    const { t } = useTranslation();
    const [pending, setPending] = useState<{ action: Action; sessionId: string } | null>(null);
    const [error, setError] = useState<string | null>(null);
    /**
     * Resolves to what `send` returned, or `null` after a failure, which `error` then describes.
     */
    const attempt = useCallback(
        async <Result>(
            action: Action,
            sessionId: string,
            send: () => Promise<Result>,
            fallback: string,
            shouldRefresh: boolean,
        ): Promise<Result | null> => {
            setPending({ action, sessionId });
            setError(null);
            try {
                const result = await send();
                if (shouldRefresh) await sessions.refresh();
                return result;
            } catch (error_) {
                setError(sessionManagementErrorMessage(error_, fallback));
                return null;
            } finally {
                setPending(null);
            }
        },
        [sessions],
    );
    const run = useCallback(
        async (
            action: Action,
            sessionId: string,
            send: () => Promise<unknown>,
            fallback: string,
        ): Promise<boolean> =>
            (await attempt(action, sessionId, async () => (await send(), true), fallback, true)) ??
            false,
        [attempt],
    );
    const rename = useCallback(
        (sessionId: string, title: string) =>
            run(
                'rename',
                sessionId,
                () => request('mobile.session.rename', { sessionId, title }),
                t('sessions.manage.renameFailed'),
            ),
        [request, run, t],
    );
    const archive = useCallback(
        (sessionId: string) =>
            run(
                'archive',
                sessionId,
                () => request('mobile.session.archive', { sessionId }),
                t('sessions.manage.archiveFailed'),
            ),
        [request, run, t],
    );
    const restore = useCallback(
        (sessionId: string) =>
            run(
                'restore',
                sessionId,
                () => request('mobile.session.restore', { sessionId }),
                t('sessions.manage.restoreFailed'),
            ),
        [request, run, t],
    );
    const setPinned = useCallback(
        (sessionId: string, isPinned: boolean) =>
            run(
                'pin',
                sessionId,
                () => request('mobile.session.setPinned', { sessionId, pinned: isPinned }),
                t('sessions.manage.pinFailed'),
            ),
        [request, run, t],
    );
    const remove = useCallback(
        (sessionId: string) =>
            run(
                'delete',
                sessionId,
                () => request('mobile.session.delete', { sessionId }),
                t('sessions.manage.deleteFailed'),
            ),
        [request, run, t],
    );
    /**
     * Resolves to the suggested title, which the caller puts in its rename field, or `null` after a failure.
     */
    const suggestTitle = useCallback(
        async (sessionId: string) =>
            (
                await attempt(
                    'suggestTitle',
                    sessionId,
                    () => request('mobile.session.suggestTitle', { sessionId }),
                    t('sessions.manage.suggestTitleFailed'),
                    false,
                )
            )?.title ?? null,
        [attempt, request, t],
    );
    /**
     * Fork Session and Continue in Another Agent resolve to the new Session's id, or `null` after a failure.
     */
    const fork = useCallback(
        async (sessionId: string, terminalId: string) =>
            (
                await attempt(
                    'fork',
                    sessionId,
                    () => request('mobile.agentChat.fork', { terminalId }),
                    t('sessions.manage.forkFailed'),
                    true,
                )
            )?.sessionId ?? null,
        [attempt, request, t],
    );
    const continueInAgent = useCallback(
        async (sessionId: string, terminalId: string, provider: AgentProvider) =>
            (
                await attempt(
                    'continue',
                    sessionId,
                    () => request('mobile.agentChat.continueInAgent', { terminalId, provider }),
                    t('sessions.manage.continueFailed'),
                    true,
                )
            )?.sessionId ?? null,
        [attempt, request, t],
    );
    const clearError = useCallback(() => setError(null), []);
    return {
        archive,
        clearError,
        continueInAgent,
        error,
        fork,
        pending,
        remove,
        rename,
        restore,
        setPinned,
        suggestTitle,
    };
};
