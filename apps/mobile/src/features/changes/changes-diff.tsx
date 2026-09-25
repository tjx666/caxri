import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffLines } from './changes-diff-lines';
import { changesStyles as styles } from './changes-styles';

export interface ChangesDiffState {
    error: boolean;
    isDisconnected: boolean;
    isLoading: boolean;
    patch: string | null;
    stale: boolean;
    unavailable: boolean;
}

export const ChangesDiff = ({
    onBack,
    onRetry,
    path,
    state,
    theme,
}: {
    onBack: () => void;
    onRetry: () => void;
    path: string;
    state: ChangesDiffState;
    theme: MobileTheme;
}) => {
    return (
        <View style={styles.root} testID="changes-diff-view">
            <View style={[styles.detailToolbar, { borderColor: theme.border }]}>
                <Pressable
                    accessibilityLabel="Back to changed files"
                    accessibilityRole="button"
                    onPress={onBack}
                    style={styles.back}
                    testID="changes-diff-back"
                >
                    <Text style={[styles.backText, { color: theme.text }]}>←</Text>
                </Pressable>
                <Text numberOfLines={1} style={[styles.detailPath, { color: theme.text }]}>
                    {path}
                </Text>
            </View>
            {state.isLoading ? (
                <View style={styles.state} testID="changes-diff-loading">
                    <ActivityIndicator color={theme.primary} />
                    <Text style={[styles.stateBody, { color: theme.muted }]}>Loading diff…</Text>
                </View>
            ) : state.stale ? (
                <View style={styles.state} testID="changes-diff-stale">
                    <Text style={[styles.stateBody, { color: theme.muted }]}>
                        {state.isDisconnected
                            ? 'Reconnect to review this diff.'
                            : 'This diff is no longer current. Refresh changes and open the file again.'}
                    </Text>
                </View>
            ) : state.error ? (
                <View style={styles.state} testID="changes-diff-error">
                    <Text
                        accessibilityRole="alert"
                        style={[styles.stateBody, { color: theme.danger }]}
                    >
                        Unable to load this diff.
                    </Text>
                    <Pressable
                        accessibilityLabel="Retry diff"
                        accessibilityRole="button"
                        onPress={onRetry}
                        style={styles.commit}
                    >
                        <Text style={[styles.commitText, { color: theme.primary }]}>Retry</Text>
                    </Pressable>
                </View>
            ) : state.unavailable ? (
                <View style={styles.state} testID="changes-too-large">
                    <Text style={[styles.stateBody, { color: theme.muted }]}>
                        This file is too large or not text. Review it on your computer.
                    </Text>
                </View>
            ) : (
                <ChangesDiffLines patch={state.patch ?? ''} theme={theme} />
            )}
        </View>
    );
};
