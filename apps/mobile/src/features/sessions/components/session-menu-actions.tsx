import { useMemo } from 'react';
import { Text } from 'react-native';

import {
    Bot,
    CornerUpLeft,
    Forward,
    GitFork,
    History,
    Play,
    RotateCw,
    Trash2,
    Undo2,
    Unplug,
} from 'lucide-react-native';

import { PopoverAction, PopoverDivider } from '../../../components/popover-menu';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';
import { useSessionMenuState } from '../hooks/use-session-menu-state';
import { sessionAgentMenu } from '../session-agent-menu';
import type { SessionMenuAction, SessionMenuActions } from '../session-management-model';
import { sessionForkBlocker } from '../session-management-model';
import type { MobileSessionItem } from '../session-model';
import { useHostSessions } from './host-sessions-provider';
import { sessionDetailStyles as styles } from './session-detail-styles';

/**
 * The Agent group of the Session menu, in Desktop's order, from the menu state the phone reads when the menu opens.
 */
const SessionAgentMenuEntries = ({
    isConnected,
    isIdle,
    run,
    session,
    theme,
}: {
    isConnected: boolean;
    isIdle: boolean;
    run: (action: SessionMenuAction) => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const menuState = useSessionMenuState(session.id, true).data;
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
    const { bot, creatorSessionId, detach, restart } = agentMenu;
    return (
        <>
            {restart ? (
                <PopoverAction
                    disabled={!isConnected || restart.blocker !== undefined}
                    icon={RotateCw}
                    label={t('sessions.detail.restartAgent')}
                    onPress={() => run('restart')}
                    testID="session-menu-restart"
                    theme={theme}
                />
            ) : null}
            {detach?.action === 'resume' ? (
                <PopoverAction
                    disabled={!isIdle}
                    icon={Play}
                    label={t('sessions.actions.resumeAgent')}
                    onPress={() => run('resume')}
                    testID="session-menu-resume"
                    theme={theme}
                />
            ) : detach ? (
                <PopoverAction
                    disabled={!isConnected || !detach.canDetach}
                    icon={Unplug}
                    label={t('sessions.detail.detachAgent')}
                    onPress={() => run('detach')}
                    testID="session-menu-detach"
                    theme={theme}
                />
            ) : null}
            {bot ? (
                <PopoverAction
                    disabled={!isIdle}
                    icon={bot === 'handOver' ? Bot : Undo2}
                    label={t(
                        bot === 'handOver'
                            ? 'sessions.actions.handOverToBot'
                            : 'sessions.actions.takeBackFromBot',
                    )}
                    onPress={() => run(bot)}
                    testID={
                        bot === 'handOver' ? 'session-menu-hand-over' : 'session-menu-take-back'
                    }
                    theme={theme}
                />
            ) : null}
            {agentMenu.canReopen ? (
                <PopoverAction
                    disabled={!isConnected}
                    icon={History}
                    label={t('sessions.detail.reopenConversation')}
                    onPress={() => run('reopen')}
                    testID="session-menu-reopen"
                    theme={theme}
                />
            ) : null}
            {creatorSessionId ? (
                <PopoverAction
                    icon={CornerUpLeft}
                    label={t('sessions.actions.goToCreatingSession')}
                    onPress={() => run('goToCreator')}
                    testID="session-menu-go-to-creator"
                    theme={theme}
                />
            ) : null}
        </>
    );
};

/**
 * The Session menu's Fork, Continue in Another Agent, Agent group, and Delete entries, grouped as Desktop's Session
 * menu keeps Fork with Continue and the removal at the end. Continue, Delete, Restart, Detach, and Reopen open their
 * step of the Session actions sheet; the rest run at once. The Fork pair hides for a Session it cannot act on, and a
 * blocked Restart or Detach only disables, where the long-press sheet explains why. A device without the control role
 * gets no `actions` and no entries.
 */
export const SessionMenuActionEntries = ({
    actions,
    isConnected,
    onClose,
    session,
    theme,
}: {
    actions: SessionMenuActions | undefined;
    isConnected: boolean;
    onClose: () => void;
    session: MobileSessionItem;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (!actions) return null;
    const canFork = sessionForkBlocker(session.primaryTerminal) === undefined;
    const isIdle = isConnected && !actions.isBusy;
    const run = (action: SessionMenuAction): void => {
        onClose();
        actions.onAction(action);
    };
    return (
        <>
            <PopoverDivider theme={theme} />
            {canFork ? (
                <>
                    <PopoverAction
                        disabled={!isIdle}
                        icon={GitFork}
                        label={t('sessions.detail.forkSession')}
                        onPress={() => run('fork')}
                        testID="session-menu-fork"
                        theme={theme}
                    />
                    <PopoverAction
                        disabled={!isConnected}
                        icon={Forward}
                        label={t('sessions.detail.continueInAgent')}
                        onPress={() => run('continue')}
                        testID="session-menu-continue"
                        theme={theme}
                    />
                </>
            ) : null}
            <SessionAgentMenuEntries
                isConnected={isConnected}
                isIdle={isIdle}
                run={run}
                session={session}
                theme={theme}
            />
            <PopoverAction
                disabled={!isConnected}
                icon={Trash2}
                label={t('sessions.detail.deleteSession')}
                onPress={() => run('delete')}
                testID="session-menu-delete"
                theme={theme}
                tone="danger"
            />
        </>
    );
};

/**
 * The failure of the last action started from the Session menu, under the header.
 */
export const SessionMenuActionsError = ({
    actions,
    theme,
}: {
    actions: SessionMenuActions | undefined;
    theme: MobileTheme;
}) =>
    actions?.error ? (
        <Text
            accessibilityRole="alert"
            style={[styles.sendState, { color: theme.danger }]}
            testID="session-menu-error"
        >
            {actions.error}
        </Text>
    ) : null;
