/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { StyleSheet, View } from 'react-native';

import type { MobileTheme } from '../theme/tokens';

/**
 * A horizontal usage bar (CPU, memory, plan limits, context window). `ratio` is clamped to 0–1; `color` carries the
 * level's semantic role, which the caller pairs with a number so the level never rests on color alone.
 */
export const Meter = ({
    color,
    ratio,
    testID,
    theme,
}: {
    color: string;
    ratio: number;
    testID?: string;
    theme: MobileTheme;
}) => (
    <View style={[styles.track, { backgroundColor: theme.elevated }]} testID={testID}>
        <View
            style={[
                styles.fill,
                {
                    backgroundColor: color,
                    width: `${Math.round(Math.min(1, Math.max(0, ratio)) * 100)}%`,
                },
            ]}
        />
    </View>
);

const styles = StyleSheet.create({
    fill: { borderRadius: 3, height: 6 },
    track: { borderRadius: 3, height: 6, overflow: 'hidden' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
