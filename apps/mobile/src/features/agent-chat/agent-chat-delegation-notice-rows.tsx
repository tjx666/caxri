/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { AgentChatDelegationNotice, DelegationNoticeEvent } from '@caxri/protocol';
import { delegationNoticeEventTone } from '@caxri/protocol';
import type { LucideIcon } from 'lucide-react-native';
import {
    CircleAlert,
    CircleCheck,
    CircleQuestionMark,
    CircleSlash,
    CircleX,
    Hand,
    ShieldAlert,
    Undo2,
} from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { conversationStyles } from '../conversation/conversation-styles';
import { useHostSessions } from '../sessions/components/host-sessions-provider';
import { allMobileSessions } from '../sessions/hooks/use-session-polling';
import { sessionTitleForDisplay } from '../sessions/session-row-model';
import { noticeEventKey } from './agent-chat-delegation-notice';
import { useOpenSession } from './use-open-session';

const ICONS: Record<DelegationNoticeEvent, LucideIcon> = {
    completed: CircleCheck,
    failed: CircleX,
    interrupted: CircleSlash,
    taken_over: Hand,
    handed_back: Undo2,
    question: CircleQuestionMark,
    approval: ShieldAlert,
    answer_unavailable: CircleAlert,
    settled: CircleCheck,
};

/**
 * One item of a delivered notice: an icon, the child Session's title from the phone's own Session list (never from the
 * message text), and what happened to it. The row opens the Session; a Session the phone does not list reads as
 * unavailable and does not open.
 */
function DelegationNoticeRow({
    item,
    theme,
}: {
    item: AgentChatDelegationNotice['items'][number];
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    const { sessions } = useHostSessions();
    const openSession = useOpenSession();
    const session = allMobileSessions(sessions.sections).find(({ id }) => id === item.sessionId);
    const Icon = ICONS[item.event];
    const tone = delegationNoticeEventTone(item.event);
    const content = (
        <>
            <Icon color={tone === 'muted' ? theme.muted : theme[tone]} size={14} />
            <Text numberOfLines={1} style={[styles.title, { color: theme.muted }]}>
                {session
                    ? sessionTitleForDisplay(session.title, t)
                    : t('chat.delegationNotice.unavailable')}
            </Text>
            <Text style={[styles.status, { color: theme.muted }]}>
                {t(noticeEventKey(item.event))}
            </Text>
        </>
    );
    return session ? (
        <Pressable
            accessibilityHint={t('chat.delegationNotice.openHint')}
            accessibilityRole="link"
            hitSlop={4}
            onPress={() => openSession(session.id)}
            style={styles.row}
            testID={`agent-chat-delegation-notice-item-${item.delegationId}`}
        >
            {content}
        </Pressable>
    ) : (
        <View style={styles.row}>{content}</View>
    );
}

/**
 * A settlement notice Caxri delivered to this Chat's Agent, in place of the user bubble its raw text would be: one
 * compact line per task, stacked when one message reports several, as Desktop draws it.
 */
export const AgentChatDelegationNoticeRows = ({
    id,
    notice,
    theme,
}: {
    id: string;
    notice: AgentChatDelegationNotice;
    theme: MobileTheme;
}) => (
    <View style={conversationStyles.message} testID={`agent-chat-delegation-notice-${id}`}>
        {notice.items.map((item) => (
            <DelegationNoticeRow
                item={item}
                key={`${item.delegationId}:${item.event}`}
                theme={theme}
            />
        ))}
    </View>
);

const styles = StyleSheet.create({
    row: { alignItems: 'center', flexDirection: 'row', gap: 8, minHeight: 24 },
    title: { flex: 1, flexShrink: 1, fontSize: 13, lineHeight: 20 },
    status: { flexShrink: 0, fontSize: 13, lineHeight: 20 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
