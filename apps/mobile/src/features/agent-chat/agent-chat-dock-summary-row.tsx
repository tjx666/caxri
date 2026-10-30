/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { Pressable, StyleSheet, Text } from 'react-native';

import { ChevronDown, Layers } from 'lucide-react-native';

import { Card } from '../../components/card';
import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * The one row that stands for the goal bar, status row, and queue card while the keyboard is up: their facts on a
 * single line, with a chevron. Tapping it unfolds the full rows (and folds them again), so every entry stays one tap
 * away.
 */
export const AgentChatDockSummaryRow = ({
    isExpanded,
    onToggle,
    segments,
    theme,
}: {
    isExpanded: boolean;
    onToggle: () => void;
    segments: readonly string[];
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const line = segments.join(' · ');
    return (
        <Card padded={false} style={styles.dock} theme={theme}>
            <Pressable
                accessibilityHint={t(isExpanded ? 'chat.dock.collapse' : 'chat.dock.expand')}
                accessibilityLabel={line}
                accessibilityRole="button"
                accessibilityState={{ expanded: isExpanded }}
                onPress={onToggle}
                style={styles.row}
                testID="agent-chat-dock-summary"
            >
                <Layers color={theme.muted} size={16} />
                <Text numberOfLines={1} style={[styles.line, { color: theme.text }]}>
                    {line}
                </Text>
                <ChevronDown
                    color={theme.muted}
                    size={16}
                    style={isExpanded ? styles.chevronOpen : null}
                />
            </Pressable>
        </Card>
    );
};

const styles = StyleSheet.create({
    /**
     * The dock gutter is 16dp, shared with the plan card, requests, status row, and timeline column.
     */
    dock: { marginHorizontal: mobileSpace.lg, marginTop: mobileSpace.sm },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.md,
    },
    line: { ...mobileType.meta, flex: 1, minWidth: 0 },
    chevronOpen: { transform: [{ rotate: '180deg' }] },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
