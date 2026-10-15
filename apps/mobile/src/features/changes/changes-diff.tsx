import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { ChevronLeft } from 'lucide-react-native';

import { useTranslation } from '../../i18n';
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
    const { t } = useTranslation();
    return (
        <View style={styles.root} testID="changes-diff-view">
            <View style={[styles.detailToolbar, { borderColor: theme.border }]}>
                <Pressable
                    accessibilityLabel={t('changes.backToFiles')}
                    accessibilityRole="button"
                    onPress={onBack}
                    style={styles.back}
                    testID="changes-diff-back"
                >
                    <ChevronLeft color={theme.text} size={22} />
                </Pressable>
                <Text numberOfLines={1} style={[styles.detailPath, { color: theme.text }]}>
                    {path}
                </Text>
            </View>
            {state.isLoading ? (
                <View style={styles.state} testID="changes-diff-loading">
                    <ActivityIndicator color={theme.primary} />
                    <Text style={[styles.stateBody, { color: theme.muted }]}>
                        {t('changes.diffLoading')}
                    </Text>
                </View>
            ) : state.stale ? (
                <View style={styles.state} testID="changes-diff-stale">
                    <Text style={[styles.stateBody, { color: theme.muted }]}>
                        {t(state.isDisconnected ? 'changes.diffReconnect' : 'changes.diffOutdated')}
                    </Text>
                </View>
            ) : state.error ? (
                <View style={styles.state} testID="changes-diff-error">
                    <Text
                        accessibilityRole="alert"
                        style={[styles.stateBody, { color: theme.danger }]}
                    >
                        {t('changes.diffLoadFailed')}
                    </Text>
                    <Pressable
                        accessibilityLabel={t('changes.diffRetry')}
                        accessibilityRole="button"
                        onPress={onRetry}
                        style={styles.commit}
                    >
                        <Text style={[styles.commitText, { color: theme.primary }]}>
                            {t('common.retry')}
                        </Text>
                    </Pressable>
                </View>
            ) : state.unavailable ? (
                <View style={styles.state} testID="changes-too-large">
                    <Text style={[styles.stateBody, { color: theme.muted }]}>
                        {t('changes.diffUnavailable')}
                    </Text>
                </View>
            ) : (
                <ChangesDiffLines patch={state.patch ?? ''} theme={theme} />
            )}
        </View>
    );
};
