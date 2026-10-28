/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, Text, View } from 'react-native';

import { mobileSpace, mobileType } from '../theme/scale';
import type { MobileTheme } from '../theme/tokens';
import { Button } from './button';
import { Spinner } from './spinner';

/**
 * The `loading`, `empty`, `error`, and `offline` states the spec makes first-class on every remote surface, drawn the
 * same way on every screen and segment: a centered title, an optional detail line, and at most one action. `loading`
 * delays its spinner so a fast read never flashes one; `offline` must offer its way back through `actionLabel`, never a
 * spinner that cannot end.
 */
export const ScreenState = ({
    actionLabel,
    detail,
    isActionBusy,
    kind,
    onAction,
    testID,
    theme,
    title,
}: {
    actionLabel?: string;
    detail?: string;
    isActionBusy?: boolean;
    kind: 'empty' | 'error' | 'loading' | 'offline';
    onAction?: () => void;
    testID: string;
    theme: MobileTheme;
    title: string;
}) => (
    <View style={styles.state} testID={testID}>
        {kind === 'loading' ? <Spinner color={theme.muted} isDelayed /> : null}
        <Text
            accessibilityRole={kind === 'error' || kind === 'offline' ? 'alert' : 'text'}
            style={[
                mobileType.bodyStrong,
                styles.center,
                {
                    color:
                        kind === 'error'
                            ? theme.danger
                            : kind === 'loading'
                              ? theme.muted
                              : theme.text,
                },
            ]}
        >
            {title}
        </Text>
        {detail ? (
            <Text style={[mobileType.meta, styles.center, { color: theme.muted }]}>{detail}</Text>
        ) : null}
        {actionLabel && onAction ? (
            <Button
                isBusy={isActionBusy}
                label={actionLabel}
                onPress={onAction}
                style={styles.action}
                testID={`${testID}-action`}
                theme={theme}
                variant="outline"
            />
        ) : null}
    </View>
);

const styles = StyleSheet.create({
    action: { alignSelf: 'center', marginTop: mobileSpace.sm, minWidth: 120 },
    center: { textAlign: 'center' },
    state: {
        alignItems: 'center',
        flexGrow: 1,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        padding: mobileSpace.xl,
    },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
