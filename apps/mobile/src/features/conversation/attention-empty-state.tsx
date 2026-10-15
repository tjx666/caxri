import type { ReactNode } from 'react';
import { Pressable, Text } from 'react-native';

import { useTranslation } from '../../i18n';
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
            style={{ justifyContent: 'center', minHeight: 44, padding: 8 }}
            testID="attention-open-terminal-fallback"
        >
            <Text style={{ color: theme.primary, textDecorationLine: 'underline' }}>
                {fallbackCopy}
            </Text>
        </Pressable>
    ) : (
        <Text style={{ color: theme.muted, padding: 8 }}>{fallbackCopy}</Text>
    );
}
