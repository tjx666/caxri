/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useMemo, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { isPinnedSession } from '@caxri/protocol';
import { Archive, Forward, GitFork, Pencil, Pin, PinOff, Trash2 } from 'lucide-react-native';

import {
    BottomSheet,
    SheetAction,
    SheetCancel,
    SheetTitle,
} from '../../../components/bottom-sheet';
import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { useMobileClient } from '../../connection/mobile-client-provider';
import type { useSessionManagement } from '../hooks/use-session-management';
import { useSessionMenuState } from '../hooks/use-session-menu-state';
import { sessionAgentMenu } from '../session-agent-menu';
import type { SessionActionsMode, SessionForkBlocker } from '../session-management-model';
import { sessionForkBlocker } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { sessionTitleForDisplay } from '../session-row-model';
import { useHostSessions } from './host-sessions-provider';
import { SessionContinuePane, SessionDeletePane, SessionRenamePane } from './session-actions-panes';
import {
    SessionAgentConfirmPane,
    SessionAgentSheetActions,
    SessionReopenPane,
} from './session-agent-panes';

const FORK_BLOCKER_REASONS = {
    noAgent: 'sessions.actions.noAgent',
    notChat: 'sessions.actions.forkNeedsChat',
} as const satisfies Record<SessionForkBlocker, TranslationKey>;

/**
 * The Session actions of a control device, from a long-pressed row or the Session menu. Rename, Continue in Another
 * Agent, Delete, and the Agent group's Restart, Detach, and Reopen swap the sheet body for their own step instead of
 * stacking a second modal, so the keyboard and focus stay in one surface; the Session menu opens the sheet directly on
 * one of those steps through `mode`.
 */
export const SessionActionsSheet = ({
    management,
    mode = 'menu',
    onClose,
    onDeleted,
    onOpenSession,
    session,
    theme,
}: {
    management: ReturnType<typeof useSessionManagement>;
    mode?: SessionActionsMode;
    onClose: () => void;
    /**
     * Runs after the Session was deleted, before the sheet closes; a detail view leaves the Session it showed.
     */
    onDeleted?: () => void;
    /**
     * Opens the Session that Fork or Continue in Another Agent created, or the one Go to Creating Session names.
     */
    onOpenSession: (sessionId: string) => void;
    session: MobileSessionItem | null;
    theme: MobileTheme;
}) =>
    session ? (
        // Keyed by Session and step so the rename draft and mode start fresh for each opening.
        <SessionActionsBody
            initialMode={mode}
            key={`${session.id}:${mode}`}
            management={management}
            onClose={onClose}
            onDeleted={onDeleted}
            onOpenSession={onOpenSession}
            session={session}
            theme={theme}
        />
    ) : null;

const SessionActionsBody = ({
    initialMode,
    management,
    onClose,
    onDeleted,
    onOpenSession,
    session,
    theme,
}: {
    initialMode: SessionActionsMode;
    management: ReturnType<typeof useSessionManagement>;
    onClose: () => void;
    onDeleted?: () => void;
    onOpenSession: (sessionId: string) => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const [mode, setMode] = useState<SessionActionsMode>(initialMode);
    const isBusy = management.pending?.sessionId === session.id;
    const isPinned = isPinnedSession(session);
    const terminalId = session.primaryTerminal?.id;
    const forkBlocker = sessionForkBlocker(session.primaryTerminal);
    const forkReason = forkBlocker && t(FORK_BLOCKER_REASONS[forkBlocker]);
    const backToMenu = (): void => {
        management.clearError();
        if (initialMode === 'menu') setMode('menu');
        else onClose();
    };
    const opened = (sessionId: string): void => {
        onClose();
        onOpenSession(sessionId);
    };
    const title = sessionTitleForDisplay(session.title, t);
    const isConnected = useMobileClient().status === 'connected';
    const menuState = useSessionMenuState(session.id, mode === 'menu' || mode === 'reopen').data;
    const { sections } = useHostSessions().sessions;
    const agentMenu = useMemo(
        () =>
            sessionAgentMenu(
                session,
                menuState,
                new Set(sections.sessions.map((listed) => listed.id)),
            ),
        [menuState, sections.sessions, session],
    );
    const stepTitles = {
        continue: t('sessions.actions.continue'),
        delete: t('sessions.actions.deleteTitle', { title }),
        detach: t('sessions.actions.detachTitle'),
        menu: title,
        rename: t('sessions.actions.renameTitle'),
        reopen: t('sessions.actions.reopenConversation'),
        restart: t('sessions.actions.restartTitle'),
    } satisfies Record<SessionActionsMode, string>;
    return (
        <BottomSheet
            closeLabel={t('sessions.actions.close')}
            onClose={onClose}
            testID="session-actions-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <SheetTitle
                        detail={session.projectTitle}
                        theme={theme}
                        title={stepTitles[mode]}
                    />
                    {mode === 'rename' ? (
                        <SessionRenamePane
                            management={management}
                            onCancel={backToMenu}
                            onRenamed={onClose}
                            session={session}
                            theme={theme}
                        />
                    ) : mode === 'continue' ? (
                        <SessionContinuePane
                            isConnected={isConnected}
                            management={management}
                            onCancel={backToMenu}
                            onContinued={opened}
                            sessionId={session.id}
                            terminalId={terminalId}
                            theme={theme}
                        />
                    ) : mode === 'restart' || mode === 'detach' ? (
                        <SessionAgentConfirmPane
                            action={mode}
                            isConnected={isConnected}
                            management={management}
                            onCancel={backToMenu}
                            onDone={onClose}
                            session={session}
                            theme={theme}
                        />
                    ) : mode === 'reopen' ? (
                        <SessionReopenPane
                            isConnected={isConnected}
                            management={management}
                            menuState={menuState}
                            onCancel={backToMenu}
                            onDone={onClose}
                            session={session}
                            theme={theme}
                        />
                    ) : mode === 'delete' ? (
                        <SessionDeletePane
                            management={management}
                            onCancel={backToMenu}
                            onDeleted={() => {
                                onDeleted?.();
                                onClose();
                            }}
                            session={session}
                            theme={theme}
                        />
                    ) : (
                        <View style={styles.actions}>
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'pin'}
                                icon={isPinned ? PinOff : Pin}
                                label={t(
                                    isPinned ? 'sessions.actions.unpin' : 'sessions.actions.pin',
                                )}
                                onPress={() => {
                                    void management
                                        .setPinned(session.id, !isPinned)
                                        .then((done) => {
                                            if (done) onClose();
                                        });
                                }}
                                testID="session-action-pin"
                                theme={theme}
                            />
                            <SheetAction
                                icon={Pencil}
                                label={t('sessions.actions.rename')}
                                onPress={() => setMode('rename')}
                                testID="session-action-rename"
                                theme={theme}
                            />
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'fork'}
                                detail={forkReason}
                                disabled={forkBlocker !== undefined}
                                icon={GitFork}
                                label={t('sessions.actions.fork')}
                                onPress={() => {
                                    if (!terminalId) return;
                                    void management
                                        .fork(session.id, terminalId)
                                        .then((sessionId) => {
                                            if (sessionId) opened(sessionId);
                                        });
                                }}
                                testID="session-action-fork"
                                theme={theme}
                            />
                            <SheetAction
                                detail={forkReason}
                                disabled={forkBlocker !== undefined}
                                icon={Forward}
                                label={t('sessions.actions.continue')}
                                onPress={() => setMode('continue')}
                                testID="session-action-continue"
                                theme={theme}
                            />
                            <SessionAgentSheetActions
                                isConnected={isConnected}
                                management={management}
                                menu={agentMenu}
                                onDone={onClose}
                                onOpenSession={onOpenSession}
                                onStep={setMode}
                                session={session}
                                theme={theme}
                            />
                            <SheetAction
                                busy={isBusy && management.pending?.action === 'archive'}
                                icon={Archive}
                                label={t('sessions.actions.archive')}
                                onPress={() => {
                                    void management.archive(session.id).then((done) => {
                                        if (done) onClose();
                                    });
                                }}
                                testID="session-action-archive"
                                theme={theme}
                            />
                            <SheetAction
                                icon={Trash2}
                                label={t('sessions.actions.delete')}
                                onPress={() => setMode('delete')}
                                testID="session-action-delete"
                                theme={theme}
                            />
                            <SheetCancel
                                onPress={dismiss}
                                testID="session-actions-cancel"
                                theme={theme}
                            />
                        </View>
                    )}
                    {management.error ? (
                        <Text
                            accessibilityRole="alert"
                            style={[styles.error, { color: theme.danger }]}
                            testID="session-actions-error"
                        >
                            {management.error}
                        </Text>
                    ) : null}
                </>
            )}
        </BottomSheet>
    );
};

const styles = StyleSheet.create({
    actions: { paddingTop: mobileSpace.xs },
    error: { ...mobileType.meta, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.md },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
