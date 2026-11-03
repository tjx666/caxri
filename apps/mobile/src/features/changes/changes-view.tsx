import { Text, View } from 'react-native';

import { RotateCw } from 'lucide-react-native';

import { Button } from '../../components/button';
import { Chip } from '../../components/chip';
import { IconButton } from '../../components/icon-button';
import { NoticeBanner } from '../../components/notice-banner';
import { Spinner } from '../../components/spinner';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { ChangesDiffStat } from './changes-diff-stat';
import { ChangesListContent } from './changes-list-content';
import type { ChangedFile, ChangesMode, ChangesViewState } from './changes-model';
import {
    changedFilesSummary,
    CHANGES_MODES,
    changesContextLine,
    changesModeLabel,
    changesSummaryLabel,
} from './changes-model';
import { changesStyles as styles } from './changes-styles';

/**
 * The prompt the commit shortcut puts in the composer. It stays English on purpose: it is an instruction to the Agent,
 * which the user can edit before sending, not interface copy.
 */
export const COMMIT_DRAFT = 'Commit the current changes with a clear message.';

export const ChangesView = ({
    canAskAgent,
    mode,
    onAskAgentToCommit,
    onModeChange,
    onOpenFile,
    onRefresh,
    state,
    theme,
}: {
    canAskAgent: boolean;
    mode: ChangesMode;
    onAskAgentToCommit: () => void;
    onModeChange: (mode: ChangesMode) => void;
    onOpenFile: (file: ChangedFile) => void;
    onRefresh: () => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isRepo = state.snapshot?.isRepository !== false;
    const contextLine = state.snapshot ? changesContextLine(state.snapshot.contexts) : null;
    const hiddenUncommitted = mode === 'working' ? 0 : (state.snapshot?.uncommittedCount ?? 0);
    return (
        <View style={styles.root} testID="changes-view">
            {isRepo ? (
                <View
                    accessibilityLabel={t('changes.modeGroup')}
                    accessibilityRole="tablist"
                    style={styles.modes}
                    testID="changes-modes"
                >
                    {CHANGES_MODES.map((candidate) => (
                        <Chip
                            key={candidate}
                            label={changesModeLabel(candidate, t)}
                            onPress={() => onModeChange(candidate)}
                            selected={candidate === mode}
                            testID={`changes-mode-${candidate}`}
                            theme={theme}
                        />
                    ))}
                </View>
            ) : null}
            {/* Outside a Git repository a "0 files changed" summary contradicts the empty state below it. */}
            {!isRepo ? null : (
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
            {contextLine ? (
                <Text
                    numberOfLines={1}
                    style={[styles.context, { borderColor: theme.border, color: theme.muted }]}
                    testID="changes-context"
                >
                    {contextLine}
                </Text>
            ) : null}
            {hiddenUncommitted > 0 && !state.isStale && !state.error ? (
                <NoticeBanner
                    actionLabel={t('changes.showUncommitted')}
                    message={t(
                        hiddenUncommitted === 1
                            ? 'changes.uncommittedHiddenOne'
                            : 'changes.uncommittedHiddenOther',
                        { count: hiddenUncommitted },
                    )}
                    onAction={() => onModeChange('working')}
                    testID="changes-uncommitted"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
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
                mode={mode}
                onOpenFile={onOpenFile}
                onRefresh={onRefresh}
                state={state}
                theme={theme}
            />
            {/* Only uncommitted work can be committed; the other modes show work that already is. */}
            {canAskAgent &&
            mode === 'working' &&
            state.snapshot &&
            state.snapshot.files.length > 0 ? (
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
