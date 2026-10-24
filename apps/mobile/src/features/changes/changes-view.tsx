import { Pressable, Text, View } from 'react-native';

import { RotateCw } from 'lucide-react-native';

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
                    <Pressable
                        accessibilityLabel={t('changes.refresh')}
                        accessibilityRole="button"
                        accessibilityState={{ busy: state.isRefreshing }}
                        onPress={onRefresh}
                        style={styles.refresh}
                        testID="changes-refresh"
                    >
                        {state.isRefreshing ? (
                            <Spinner color={theme.primary} />
                        ) : (
                            <RotateCw color={theme.primary} size={20} />
                        )}
                    </Pressable>
                </View>
            )}
            {state.isStale ? (
                <Text
                    style={[styles.stale, { borderColor: theme.border, color: theme.muted }]}
                    testID="changes-stale"
                >
                    {t('changes.staleNotice')}
                </Text>
            ) : null}
            {state.snapshot && state.error ? (
                <Text
                    accessibilityRole="alert"
                    style={[styles.stale, { borderColor: theme.border, color: theme.danger }]}
                >
                    {t('changes.refreshFailed')}
                </Text>
            ) : null}
            <ChangesListContent
                onOpenFile={onOpenFile}
                onRefresh={onRefresh}
                state={state}
                theme={theme}
            />
            {canAskAgent && state.snapshot && state.snapshot.files.length > 0 ? (
                <View style={[styles.footer, { borderColor: theme.border }]}>
                    <Pressable
                        accessibilityLabel={t('changes.askAgentToCommit')}
                        accessibilityHint={t('changes.askAgentToCommitHint')}
                        accessibilityRole="button"
                        onPress={onAskAgentToCommit}
                        style={[styles.commit, { borderColor: theme.success }]}
                        testID="changes-ask-agent-commit"
                    >
                        <Text style={[styles.commitText, { color: theme.success }]}>
                            {t('changes.askAgentToCommit')}
                        </Text>
                    </Pressable>
                </View>
            ) : null}
        </View>
    );
};
