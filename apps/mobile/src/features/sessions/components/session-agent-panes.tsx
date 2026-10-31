/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import type { MobileSessionMenuState } from '@caxri/protocol';
import { Bot, CornerUpLeft, History, Play, RotateCw, Undo2, Unplug } from 'lucide-react-native';

import { SheetAction } from '../../../components/bottom-sheet';
import { Button } from '../../../components/button';
import { useTranslation } from '../../../i18n';
import { mobileSpace, mobileType } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';
import { mobileAgentDisplayName } from '../agent-display-name';
import type { useSessionManagement } from '../hooks/use-session-management';
import type { SessionAgentMenu } from '../session-agent-menu';
import { RESTART_AGENT_BLOCKER_REASONS } from '../session-agent-menu';
import type { MobileSessionItem } from '../session-model';

type Management = ReturnType<typeof useSessionManagement>;

/**
 * The Agent group of the Session actions sheet, in Desktop's Session row menu order. Restart, Detach, and Reopen open
 * their own step; Resume, Hand Over, and Take Back run at once and close the sheet. Every entry needs the computer, so
 * all of them disable while the phone is offline.
 */
export const SessionAgentSheetActions = ({
    isConnected,
    management,
    menu,
    onDone,
    onOpenSession,
    onStep,
    session,
    theme,
}: {
    isConnected: boolean;
    management: Management;
    menu: SessionAgentMenu;
    onDone: () => void;
    onOpenSession: (sessionId: string) => void;
    onStep: (step: 'detach' | 'reopen' | 'restart') => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isBusy = management.pending?.sessionId === session.id;
    const isRunning = (action: NonNullable<Management['pending']>['action']): boolean =>
        isBusy && management.pending?.action === action;
    const finish = (isDone: boolean): void => {
        if (isDone) onDone();
    };
    const { bot, creatorSessionId, detach, restart } = menu;
    return (
        <>
            {restart ? (
                <SheetAction
                    detail={restart.blocker && t(RESTART_AGENT_BLOCKER_REASONS[restart.blocker])}
                    disabled={!isConnected || restart.blocker !== undefined}
                    icon={RotateCw}
                    label={t('sessions.actions.restartAgent')}
                    onPress={() => onStep('restart')}
                    testID="session-action-restart"
                    theme={theme}
                />
            ) : null}
            {detach ? (
                <SessionDetachSheetAction
                    detach={detach}
                    isBusy={isRunning(detach.action === 'resume' ? 'resume' : 'detach')}
                    isConnected={isConnected}
                    onResume={() => {
                        void management.resume(session.id).then(finish);
                    }}
                    onStep={() => onStep('detach')}
                    theme={theme}
                />
            ) : null}
            {bot ? (
                <SessionBotSheetAction
                    bot={bot}
                    isBusy={isRunning(bot)}
                    isConnected={isConnected}
                    onPress={() => {
                        const send =
                            bot === 'handOver'
                                ? management.handOverToBot
                                : management.takeBackFromBot;
                        void send(session.id).then(finish);
                    }}
                    theme={theme}
                />
            ) : null}
            {menu.canReopen ? (
                <SheetAction
                    disabled={!isConnected}
                    icon={History}
                    label={t('sessions.actions.reopenConversation')}
                    onPress={() => onStep('reopen')}
                    testID="session-action-reopen"
                    theme={theme}
                />
            ) : null}
            {creatorSessionId ? (
                <SheetAction
                    icon={CornerUpLeft}
                    label={t('sessions.actions.goToCreatingSession')}
                    onPress={() => {
                        onDone();
                        onOpenSession(creatorSessionId);
                    }}
                    testID="session-action-go-to-creator"
                    theme={theme}
                />
            ) : null}
            {isConnected ? null : (
                <Text
                    style={[styles.status, { color: theme.muted }]}
                    testID="session-agent-actions-offline"
                >
                    {t('sessions.detail.reconnectForActions')}
                </Text>
            )}
        </>
    );
};

/**
 * Detach Agent, or Resume Agent once the Agent is detached. Resume runs at once; Detach opens its confirmation step.
 */
const SessionDetachSheetAction = ({
    detach,
    isBusy,
    isConnected,
    onResume,
    onStep,
    theme,
}: {
    detach: NonNullable<SessionAgentMenu['detach']>;
    isBusy: boolean;
    isConnected: boolean;
    onResume: () => void;
    onStep: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return detach.action === 'resume' ? (
        <SheetAction
            busy={isBusy}
            disabled={!isConnected}
            icon={Play}
            label={t('sessions.actions.resumeAgent')}
            onPress={onResume}
            testID="session-action-resume"
            theme={theme}
        />
    ) : (
        <SheetAction
            detail={detach.canDetach ? undefined : t('sessions.actions.detachNoRunning')}
            disabled={!isConnected || !detach.canDetach}
            icon={Unplug}
            label={t('sessions.actions.detachAgent')}
            onPress={onStep}
            testID="session-action-detach"
            theme={theme}
        />
    );
};

/**
 * Hand Over to Caxri Bot, or Take Back once Caxri Bot manages the Session.
 */
const SessionBotSheetAction = ({
    bot,
    isBusy,
    isConnected,
    onPress,
    theme,
}: {
    bot: NonNullable<SessionAgentMenu['bot']>;
    isBusy: boolean;
    isConnected: boolean;
    onPress: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isHandOver = bot === 'handOver';
    return (
        <SheetAction
            busy={isBusy}
            disabled={!isConnected}
            icon={isHandOver ? Bot : Undo2}
            label={t(
                isHandOver ? 'sessions.actions.handOverToBot' : 'sessions.actions.takeBackFromBot',
            )}
            onPress={onPress}
            testID={isHandOver ? 'session-action-hand-over' : 'session-action-take-back'}
            theme={theme}
        />
    );
};

/**
 * The phone's own confirmation for Restart Agent and Detach Agent, since both end a running turn and neither Server
 * method asks on the computer.
 */
export const SessionAgentConfirmPane = ({
    action,
    isConnected,
    management,
    onCancel,
    onDone,
    session,
    theme,
}: {
    action: 'detach' | 'restart';
    isConnected: boolean;
    management: Management;
    onCancel: () => void;
    onDone: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isBusy = management.pending?.sessionId === session.id;
    const confirm = (): void => {
        const send = action === 'restart' ? management.restartAgent : management.detach;
        void send(session.id).then((done) => {
            if (done) onDone();
        });
    };
    return (
        <View style={styles.form}>
            <Text
                style={[styles.detail, { color: theme.muted }]}
                testID={`session-${action}-detail`}
            >
                {t(
                    action === 'restart'
                        ? 'sessions.actions.restartDetail'
                        : 'sessions.actions.detachDetail',
                )}
            </Text>
            <View style={styles.buttons}>
                <Button
                    isDisabled={isBusy}
                    label={t('common.cancel')}
                    onPress={onCancel}
                    style={styles.button}
                    testID={`session-${action}-cancel`}
                    theme={theme}
                    variant="outline"
                />
                <Button
                    isBusy={isBusy}
                    isDisabled={!isConnected}
                    label={t(
                        action === 'restart'
                            ? 'sessions.actions.restartConfirm'
                            : 'sessions.actions.detachConfirm',
                    )}
                    onPress={confirm}
                    style={styles.button}
                    testID={`session-${action}-confirm`}
                    theme={theme}
                    variant="danger"
                />
            </View>
        </View>
    );
};

/**
 * Reopen Conversation: the Session's closed conversations, newest first as the Server lists them. Choosing one opens it
 * as a tab of the Session on the computer, so the sheet closes without navigating.
 */
export const SessionReopenPane = ({
    isConnected,
    management,
    menuState,
    onCancel,
    onDone,
    session,
    theme,
}: {
    isConnected: boolean;
    management: Management;
    menuState: MobileSessionMenuState | undefined;
    onCancel: () => void;
    onDone: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isBusy = management.pending?.sessionId === session.id;
    return (
        <View style={styles.list}>
            <Text style={[styles.status, { color: theme.muted }]} testID="session-reopen-detail">
                {t('sessions.actions.reopenDetail')}
            </Text>
            {menuState?.conversations.map((conversation) => {
                const agent = mobileAgentDisplayName(conversation.provider);
                return (
                    <SheetAction
                        busy={isBusy}
                        detail={conversation.title ? agent : undefined}
                        disabled={!isConnected}
                        icon={History}
                        key={`${conversation.provider}:${conversation.agentSessionId}`}
                        label={
                            conversation.title ?? t('sessions.actions.reopenUntitled', { agent })
                        }
                        onPress={() => {
                            void management
                                .reopenConversation(session.id, conversation)
                                .then((done) => {
                                    if (done) onDone();
                                });
                        }}
                        testID={`session-reopen-${conversation.agentSessionId}`}
                        theme={theme}
                    />
                );
            })}
            <View style={styles.buttons}>
                <Button
                    label={t('common.cancel')}
                    onPress={onCancel}
                    style={styles.button}
                    testID="session-reopen-cancel"
                    theme={theme}
                    variant="outline"
                />
            </View>
        </View>
    );
};

const styles = StyleSheet.create({
    form: { gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.sm },
    list: { gap: mobileSpace.xs, paddingTop: mobileSpace.xs },
    buttons: { flexDirection: 'row', gap: mobileSpace.md, paddingHorizontal: mobileSpace.sm },
    button: { flex: 1 },
    detail: { ...mobileType.body },
    status: {
        ...mobileType.body,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.sm,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
