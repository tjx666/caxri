/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text } from 'react-native';

import { ChevronRight, MessageSquareWarning } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
import {
    mobileControl,
    mobileRadius,
    mobileSpace,
    mobileType,
    PRESSED_OPACITY,
} from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';
import { useBotInbox } from './use-bot-inbox';

/**
 * The Session home's way into the Bot Inbox. It appears only while Caxri Bot has raised something, so an idle or unused
 * Bot costs no space, and an open item is visible without opening a menu.
 */
export const BotInboxHomeEntry = ({
    onOpen,
    theme,
}: {
    onOpen: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { query } = useBotInbox();
    const count = query.data?.total ?? 0;
    if (count === 0) return null;
    const label = t(count === 1 ? 'inbox.homeEntryOne' : 'inbox.homeEntryOther', { count });
    return (
        <Pressable
            accessibilityHint={t('inbox.homeEntryHint')}
            accessibilityLabel={label}
            accessibilityRole="button"
            onPress={onOpen}
            style={({ pressed }) => [
                styles.entry,
                {
                    backgroundColor: theme.surface,
                    borderColor: theme.border,
                    opacity: pressed ? PRESSED_OPACITY : 1,
                },
            ]}
            testID="bot-inbox-entry"
        >
            <MessageSquareWarning color={theme.warning} size={18} />
            <Text numberOfLines={1} style={[styles.label, { color: theme.text }]}>
                {label}
            </Text>
            <ChevronRight color={theme.muted} size={18} />
        </Pressable>
    );
};

const styles = StyleSheet.create({
    entry: {
        alignItems: 'center',
        borderRadius: mobileRadius.md,
        borderWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.md,
        marginBottom: mobileSpace.sm,
        marginHorizontal: mobileSpace.lg,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    label: { ...mobileType.body, flex: 1 },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
