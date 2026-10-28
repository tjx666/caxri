import { Text, View } from 'react-native';

import { RotateCw } from 'lucide-react-native';

import { Button } from '../../components/button';
import { IconButton } from '../../components/icon-button';
import { NoticeBanner } from '../../components/notice-banner';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffStat } from './changes-diff-stat';
import { ChangesListContent } from './changes-list-content';
import type { ChangedFile, ChangesViewState } from './changes-model';
import { changedFilesSummary, changesSummaryLabel } from './changes-model';
import { changesStyles as styles } from './changes-styles';

/**
 * The prompt the commit shortcut puts in the composer. It stays English on purpose: it is an instruction to the Agent,
 * which the user can edit before sending, not interface copy.
 */
export const COMMIT_DRAFT = 'Commit the current changes with a clear message.';

export const ChangesView = ({
    canAskAgent,
    onAskAgentToCommit,
    onOpenFile,
    onRefresh,
    state,
    theme,
}: {
    canAskAgent: boolean;
    onAskAgentToCommit: () => void;
    onOpenFile: (file: ChangedFile) => void;
    onRefresh: () => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <View style={styles.root} testID="changes-view">
            {/* Outside a Git repository a "0 files changed" summary contradicts the empty state below it. */}
            {state.snapshot?.isRepository === false ? null : (
                <View style={[styles.toolbar, { borderColor: theme.border }]}>
                    <Text
                        accessibilityRole="header"
                        accessibilityLabel={
                            state.snapshot
                                ? changesSummaryLabel(
                                      state.snapshot.changedFileCount,
                                      state.snapshot.additions,
                                      state.snapshot.deletions,
                                      t,
                                  )
                                : undefined
                        }
                        style={[styles.summary, { color: theme.text }]}
                        testID="changes-summary"
                    >
                        {state.snapshot ? (
                            <>
                                {changedFilesSummary(state.snapshot.changedFileCount, t)} ·{' '}
                                <ChangesDiffStat
                                    additions={state.snapshot.additions}
                                    deletions={state.snapshot.deletions}
                                    theme={theme}
                                />
                            </>
                        ) : (
                            t('changes.title')
                        )}
                    </Text>
                    {state.isRefreshing ? (
                        <View style={styles.refresh} testID="changes-refresh">
                            <Spinner color={theme.primary} />
                        </View>
                    ) : (
                        <IconButton
                            accessibilityLabel={t('changes.refresh')}
                            color={theme.primary}
                            icon={RotateCw}
                            onPress={onRefresh}
                            size={20}
                            testID="changes-refresh"
                            theme={theme}
                        />
                    )}
                </View>
            )}
            {state.isStale ? (
                <NoticeBanner
                    message={t('changes.staleNotice')}
                    testID="changes-stale"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
            {state.snapshot && state.error ? (
                <NoticeBanner
                    actionLabel={t('common.retry')}
                    isBusy={state.isRefreshing}
                    message={t('changes.refreshFailed')}
                    onAction={onRefresh}
                    testID="changes-refresh-failed"
                    theme={theme}
                    tone="danger"
                />
            ) : null}
            <ChangesListContent
                onOpenFile={onOpenFile}
                onRefresh={onRefresh}
                state={state}
                theme={theme}
            />
            {canAskAgent && state.snapshot && state.snapshot.files.length > 0 ? (
                <View style={[styles.footer, { borderColor: theme.border }]}>
                    <Button
                        accessibilityHint={t('changes.askAgentToCommitHint')}
                        label={t('changes.askAgentToCommit')}
                        onPress={onAskAgentToCommit}
                        testID="changes-ask-agent-commit"
                        theme={theme}
                        variant="primary"
                    />
                </View>
            ) : null}
        </View>
    );
};
