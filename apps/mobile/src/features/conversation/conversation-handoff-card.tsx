/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { MessageSquareShare } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import { mobileRadius, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * A `/new-session` message in place of the user's bubble, mirroring Desktop's hand-off bubble: the command as a chip,
 * then what the user said the next task is, never the instructions the composer wrote for the Agent. The link to the
 * Session the Agent created is `footer`, drawn under the card once that Session exists.
 */
export const ConversationHandoffCard = ({
    footer,
    note,
    theme,
}: {
    footer?: ReactNode;
    note: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View>
            <View style={styles.row}>
                <View style={[styles.chip, { backgroundColor: theme.elevated }]}>
                    <MessageSquareShare color={theme.primary} size={14} />
                    <Text numberOfLines={1} style={[styles.chipLabel, { color: theme.primary }]}>
                        {t('chat.handoff.command')}
                    </Text>
                </View>
                <Text style={[styles.note, { color: note ? theme.text : theme.muted }]}>
                    {note || t('chat.handoff.noNote')}
                </Text>
            </View>
            {footer}
        </View>
    );
};

const styles = StyleSheet.create({
    row: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: mobileSpace.sm },
    chip: {
        alignItems: 'center',
        borderRadius: mobileRadius.sm,
        flexDirection: 'row',
        flexShrink: 1,
        gap: mobileSpace.xs,
        paddingHorizontal: mobileSpace.sm,
        paddingVertical: mobileSpace.xxs,
    },
    chipLabel: { ...mobileType.meta, flexShrink: 1, fontWeight: '600' },
    note: { ...mobileType.body, flexShrink: 1 },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
