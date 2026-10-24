import { Pressable, Text, View } from 'react-native';

import { ChevronLeft } from 'lucide-react-native';

import { Spinner } from '../../components/spinner';
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

/**
 * An outdated diff: Refresh re-reads it, unless the phone is offline and can only wait to reconnect.
 */
const ChangesDiffStale = ({
    isDisconnected,
    onRefresh,
    theme,
}: {
    isDisconnected: boolean;
    onRefresh: () => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.state} testID="changes-diff-stale">
            <Text style={[styles.stateBody, { color: theme.muted }]}>
                {t(isDisconnected ? 'changes.diffReconnect' : 'changes.diffOutdated')}
            </Text>
            {isDisconnected ? null : (
                <Pressable
                    accessibilityLabel={t('changes.refresh')}
                    accessibilityRole="button"
                    onPress={onRefresh}
                    style={styles.commit}
                    testID="changes-diff-refresh"
                >
                    <Text style={[styles.commitText, { color: theme.primary }]}>
                        {t('changes.diffRefresh')}
                    </Text>
                </Pressable>
            )}
        </View>
    );
};

/**
 * The diff, or the loading, outdated, failed, or too-large state that stands in for it.
 */
const ChangesDiffBody = ({
    onRefresh,
    onRetry,
    state,
    theme,
}: {
    onRefresh: () => void;
    onRetry: () => void;
    state: ChangesDiffState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    if (state.isLoading)
        return (
            <View style={styles.state} testID="changes-diff-loading">
                <Spinner color={theme.primary} />
                <Text style={[styles.stateBody, { color: theme.muted }]}>
                    {t('changes.diffLoading')}
                </Text>
            </View>
        );
    if (state.stale)
        return (
            <ChangesDiffStale
                isDisconnected={state.isDisconnected}
                onRefresh={onRefresh}
                theme={theme}
            />
        );
    if (state.error)
        return (
            <View style={styles.state} testID="changes-diff-error">
                <Text accessibilityRole="alert" style={[styles.stateBody, { color: theme.danger }]}>
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
        );
    if (state.unavailable)
        return (
            <View style={styles.state} testID="changes-too-large">
                <Text style={[styles.stateBody, { color: theme.muted }]}>
                    {t('changes.diffUnavailable')}
                </Text>
            </View>
        );
    return <ChangesDiffLines patch={state.patch ?? ''} theme={theme} />;
};

export const ChangesDiff = ({
    onBack,
    onRefresh,
    onRetry,
    path,
    state,
    theme,
}: {
    onBack: () => void;
    /**
     * Re-reads the changed files and this file's diff, so an outdated diff becomes current without leaving the file.
     */
    onRefresh: () => void;
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
                <Text
                    ellipsizeMode="head"
                    numberOfLines={1}
                    style={[styles.detailPath, { color: theme.text }]}
                >
                    {path}
                </Text>
            </View>
            <ChangesDiffBody onRefresh={onRefresh} onRetry={onRetry} state={state} theme={theme} />
        </View>
    );
};
