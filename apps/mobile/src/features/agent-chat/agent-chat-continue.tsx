/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { use, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type {
    AgentChatContinuation,
    MobileContinuationOrigin,
    MobileDeviceRole,
} from '@caxri/protocol';

import { BottomSheet, SheetTitle } from '../../components/bottom-sheet';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { mobileAgentDisplayName } from '../sessions/agent-display-name';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { SessionContinuePane } from '../sessions/components/session-actions-panes';
import { useSessionManagement } from '../sessions/hooks/use-session-management';
import { sessionTitleForDisplay } from '../sessions/session-row-model';
import { AgentChatContinuer } from './agent-chat-handoff';
import { useOpenSession } from './use-open-session';

/**
 * A usage-limit or usage guard card's way forward, as Desktop's cards offer it: "Continue in another Agent" while the
 * work has not moved on, and "Continued in" with a link to the new Session once it has, which every role sees. A
 * Session the phone does not list (archived) is named by its Agent without a link.
 */
export const AgentChatContinueAction = ({
    continuedIn,
    origin,
    testID = 'agent-chat-continue-in-agent',
    theme,
}: {
    continuedIn: AgentChatContinuation | undefined;
    origin: MobileContinuationOrigin;
    testID?: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const continuer = use(AgentChatContinuer);
    const { sessions } = useHostSessions();
    const openSession = useOpenSession();
    if (continuedIn) {
        const target = sessions.sections.sessions.find(({ id }) => id === continuedIn.sessionId);
        return (
            <View style={styles.row}>
                <Text style={[styles.label, { color: theme.muted }]}>
                    {t('chat.handoff.continuedIn')}
                </Text>
                {target ? (
                    <Pressable
                        accessibilityHint={t('chat.handoff.openTargetHint')}
                        accessibilityRole="link"
                        hitSlop={8}
                        onPress={() => openSession(target.id)}
                        style={styles.link}
                        testID={`agent-chat-continued-in-${target.id}`}
                    >
                        <Text numberOfLines={1} style={[styles.label, { color: theme.primary }]}>
                            {sessionTitleForDisplay(target.title, t)}
                        </Text>
                    </Pressable>
                ) : (
                    <Text style={[styles.label, { color: theme.text }]}>
                        {mobileAgentDisplayName(continuedIn.provider)}
                    </Text>
                )}
            </View>
        );
    }
    if (!continuer) return null;
    return (
        <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !continuer.isConnected }}
            disabled={!continuer.isConnected}
            hitSlop={8}
            onPress={() => continuer.open(origin)}
            style={styles.row}
            testID={testID}
        >
            <Text
                style={[
                    styles.label,
                    { color: continuer.isConnected ? theme.primary : theme.muted },
                ]}
            >
                {t('sessions.actions.continue')}
            </Text>
        </Pressable>
    );
};

/**
 * Lets the Chat's usage-limit cards and usage guard card open Continue in Another Agent, and shows its sheet. Only a
 * control device may continue, as the Session menu's own entry requires.
 */
export const AgentChatContinueScope = ({
    children,
    deviceRole,
    isConnected,
    sessionId,
    terminalId,
    theme,
}: {
    children: ReactNode;
    deviceRole: MobileDeviceRole | null;
    isConnected: boolean;
    sessionId: string;
    terminalId: string | undefined;
    theme: MobileTheme;
}) => {
    const [origin, setOrigin] = useState<MobileContinuationOrigin | null>(null);
    const continuer = useMemo(
        () =>
            deviceRole === 'control' && terminalId !== undefined
                ? { isConnected, open: setOrigin }
                : undefined,
        [deviceRole, isConnected, terminalId],
    );
    return (
        <AgentChatContinuer value={continuer}>
            {children}
            {origin && terminalId ? (
                <AgentChatContinueSheet
                    isConnected={isConnected}
                    onClose={() => setOrigin(null)}
                    origin={origin}
                    sessionId={sessionId}
                    terminalId={terminalId}
                    theme={theme}
                />
            ) : null}
        </AgentChatContinuer>
    );
};

/**
 * The Continue in Another Agent sheet a Chat opens from its usage-limit card or usage guard card: the Session menu's
 * list, continuing from that failure, then opening the new Session.
 */
const AgentChatContinueSheet = ({
    isConnected,
    onClose,
    origin,
    sessionId,
    terminalId,
    theme,
}: {
    isConnected: boolean;
    onClose: () => void;
    origin: MobileContinuationOrigin;
    sessionId: string;
    terminalId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const management = useSessionManagement();
    const openSession = useOpenSession();
    return (
        <BottomSheet
            closeLabel={t('sessions.actions.close')}
            onClose={onClose}
            testID="agent-chat-continue-sheet"
            theme={theme}
        >
            {() => (
                <>
                    <SheetTitle theme={theme} title={t('sessions.actions.continue')} />
                    <SessionContinuePane
                        isConnected={isConnected}
                        management={management}
                        onCancel={onClose}
                        onContinued={(created) => {
                            onClose();
                            openSession(created);
                        }}
                        origin={origin}
                        sessionId={sessionId}
                        terminalId={terminalId}
                        theme={theme}
                    />
                    {management.error ? (
                        <Text
                            accessibilityRole="alert"
                            style={[styles.error, { color: theme.danger }]}
                            testID="agent-chat-continue-error"
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
    row: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.sm },
    label: { ...mobileType.meta, flexShrink: 0 },
    link: { flexShrink: 1 },
    error: { ...mobileType.meta, paddingHorizontal: mobileSpace.sm, paddingTop: mobileSpace.md },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
