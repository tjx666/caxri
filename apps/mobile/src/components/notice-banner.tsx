import { StyleSheet, Text, View } from 'react-native';

import { mobileSpace, mobileType } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { Button } from './button';

const styles = StyleSheet.create({
    banner: {
        alignItems: 'center',
        borderBottomWidth: 1,
        flexDirection: 'row',
        gap: mobileSpace.md,
        paddingHorizontal: mobileSpace.lg,
        paddingVertical: mobileSpace.sm,
    },
    text: { ...mobileType.meta, flex: 1 },
    button: { minWidth: 72 },
});

/**
 * The one state notice across the top of a screen or Session segment (stale connection, failed or handed-off Agent,
 * usage guard, update available), with an optional separate action button. The sentence itself is never the button, so
 * the action keeps a full touch target and a short accessible name. A screen shows at most one at a time: the most
 * severe state wins and the rest wait, so notices never stack above the content.
 */
export const NoticeBanner = ({
    actionLabel,
    actionTestID,
    isBusy,
    message,
    onAction,
    onSecondaryAction,
    secondaryActionLabel,
    secondaryActionTestID,
    testID,
    theme,
    tone,
}: {
    actionLabel?: string;
    /**
     * Overrides the action's default `${testID}-action`, for a button whose id outlived a renamed banner.
     */
    actionTestID?: string;
    isBusy?: boolean;
    message: string;
    onAction?: () => void;
    /**
     * A quieter companion to the action, such as `Later` beside `Update`. Drawn before the main action.
     */
    onSecondaryAction?: () => void;
    secondaryActionLabel?: string;
    secondaryActionTestID?: string;
    testID: string;
    theme: MobileTheme;
    tone: 'danger' | 'muted' | 'warning';
}) => (
    <View
        accessibilityRole="alert"
        style={[styles.banner, { borderColor: theme.border }]}
        testID={testID}
    >
        <Text style={[styles.text, { color: theme[tone] }]}>{message}</Text>
        {secondaryActionLabel && onSecondaryAction ? (
            <Button
                label={secondaryActionLabel}
                onPress={onSecondaryAction}
                style={styles.button}
                testID={secondaryActionTestID ?? `${testID}-secondary-action`}
                theme={theme}
                variant="outline"
            />
        ) : null}
        {actionLabel && onAction ? (
            <Button
                isBusy={isBusy}
                label={actionLabel}
                onPress={onAction}
                style={styles.button}
                testID={actionTestID ?? `${testID}-action`}
                theme={theme}
                variant="secondary"
            />
        ) : null}
    </View>
);
