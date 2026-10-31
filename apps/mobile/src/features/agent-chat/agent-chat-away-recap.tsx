/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import { Sparkles, X } from 'lucide-react-native';

import { Card } from '../../components/card';
import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import { mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { relativeAgeLabel } from '../sessions/session-row-model';
import { useMinuteClock } from './use-minute-clock';

/**
 * The away recap at the end of the transcript, worded as Desktop's card: a quiet card labelled `While you were away`
 * with its age, so it never reads as the Agent's own message, and a close button. Server Core asked the Agent for it on
 * the side while the user was elsewhere (`ChatAwayRecap`); the timeline drops it once the Chat replies again or starts
 * a turn (`withAgentChatAwayRecap`).
 */
export const AgentChatAwayRecap = ({
    generatedAt,
    onDismiss,
    text,
    theme,
}: {
    generatedAt: number;
    onDismiss: () => void;
    text: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const now = useMinuteClock();
    return (
        <Card
            accessibilityLabel={t('chat.awayRecap.label')}
            padded={false}
            style={styles.card}
            testID="agent-chat-away-recap"
            theme={theme}
        >
            <View style={styles.header}>
                <Sparkles color={theme.muted} size={14} />
                <Text numberOfLines={1} style={[styles.headerText, { color: theme.muted }]}>
                    <Text style={styles.label}>{t('chat.awayRecap.label')}</Text>
                    {` · ${relativeAgeLabel(generatedAt, now, t)}`}
                </Text>
                <IconButton
                    accessibilityLabel={t('chat.awayRecap.dismiss')}
                    color={theme.muted}
                    icon={X}
                    onPress={onDismiss}
                    size={16}
                    testID="agent-chat-away-recap-dismiss"
                    theme={theme}
                />
            </View>
            <Text selectable style={[styles.body, { color: theme.text }]}>
                {text}
            </Text>
        </Card>
    );
};

const styles = StyleSheet.create({
    card: { paddingBottom: mobileSpace.md, paddingLeft: mobileSpace.md },
    header: { alignItems: 'center', flexDirection: 'row', gap: mobileSpace.xs },
    headerText: { ...mobileType.caption, flex: 1, minWidth: 0 },
    label: { fontWeight: '600' },
    body: { ...mobileType.meta, paddingRight: mobileSpace.md },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
