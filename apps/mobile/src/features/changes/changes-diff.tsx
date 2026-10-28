import { Text, View } from 'react-native';

import { ChevronLeft } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import { ScreenState } from '../../components/screen-state';
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
 * The diff, or the loading, outdated, failed, or too-large state that stands in for it. An outdated diff offers Refresh
 * unless the phone is offline and can only wait to reconnect.
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
            <ScreenState
                kind="loading"
                testID="changes-diff-loading"
                theme={theme}
                title={t('changes.diffLoading')}
            />
        );
    if (state.stale)
        return state.isDisconnected ? (
            <ScreenState
                kind="offline"
                testID="changes-diff-stale"
                theme={theme}
                title={t('changes.diffReconnect')}
            />
        ) : (
            <ScreenState
                actionLabel={t('changes.diffRefresh')}
                kind="empty"
                onAction={onRefresh}
                testID="changes-diff-stale"
                theme={theme}
                title={t('changes.diffOutdated')}
            />
        );
    if (state.error)
        return (
            <ScreenState
                actionLabel={t('common.retry')}
                kind="error"
                onAction={onRetry}
                testID="changes-diff-error"
                theme={theme}
                title={t('changes.diffLoadFailed')}
            />
        );
    if (state.unavailable)
        return (
            <ScreenState
                kind="empty"
                testID="changes-too-large"
                theme={theme}
                title={t('changes.diffUnavailable')}
            />
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
                <IconButton
                    accessibilityLabel={t('changes.backToFiles')}
                    icon={ChevronLeft}
                    onPress={onBack}
                    testID="changes-diff-back"
                    theme={theme}
                />
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
