/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';

import { useTranslation } from '../../i18n';
import { mobileControl, mobileSpace, mobileType } from '../../theme/scale';
import type { MobileTheme } from '../../theme/tokens';

/**
 * What `AttentionCards` renders once there are no visible requests left: the "Always allow" banner if it is active,
 * otherwise a Terminal fallback (or nothing) depending on whether this Session even has a Terminal segment to open.
 * Split out of `AttentionCards` so its resolution stays a flat sequence of guard clauses instead of nesting inside the
 * list's own render branch (react-doctor/no-high-complexity-react-function).
 */
export function AttentionEmptyState({
    banner,
    fallbackToTerminal,
    isSuccess,
    onOpenTerminal,
    theme,
}: {
    banner: ReactNode;
    fallbackToTerminal: boolean | undefined;
    isSuccess: boolean;
    onOpenTerminal?: () => void;
    theme: MobileTheme;
}) {
    const { t } = useTranslation();
    if (banner) return banner;
    if (!fallbackToTerminal || !isSuccess) return null;
    const fallbackCopy = t('conversation.attention.terminalFallback');
    return onOpenTerminal ? (
        <Pressable
            accessibilityLabel={t('conversation.attention.openTerminal')}
            accessibilityRole="button"
            onPress={onOpenTerminal}
            style={styles.link}
            testID="attention-open-terminal-fallback"
        >
            <Text style={[styles.text, styles.underline, { color: theme.primary }]}>
                {fallbackCopy}
            </Text>
        </Pressable>
    ) : (
        <Text style={[styles.text, styles.padded, { color: theme.muted }]}>{fallbackCopy}</Text>
    );
}

const styles = StyleSheet.create({
    link: {
        justifyContent: 'center',
        minHeight: mobileControl.row,
        paddingHorizontal: mobileSpace.lg,
    },
    text: mobileType.meta,
    padded: { padding: mobileSpace.lg },
    underline: { textDecorationLine: 'underline' },
});
/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
