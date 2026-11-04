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
    hasChangesSubject,
} from './changes-model';
import { changesStyles as styles } from './changes-styles';

/**
 * The prompt the commit shortcut puts in the composer. It stays English on purpose: it is an instruction to the Agent,
 * which the user can edit before sending, not interface copy.
 */
export const COMMIT_DRAFT = 'Commit the current changes with a clear message.';

/**
 * The prompt the empty Pull Request state puts in the composer; English for the same reason as {@link COMMIT_DRAFT}.
 */
export const OPEN_PULL_REQUEST_DRAFT = 'Open a pull request for the current branch.';

/**
 * The mode chips and the summary with its refresh action. Hidden outside a Git repository, where a "0 files changed"
 * summary would contradict the empty state below it.
 */
const ChangesToolbar = ({
    mode,
    onModeChange,
    onRefresh,
    state,
    theme,
}: {
    mode: ChangesMode;
    onModeChange: (mode: ChangesMode) => void;
    onRefresh: () => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const snapshot =
        state.snapshot && hasChangesSubject(mode, state.snapshot) ? state.snapshot : undefined;
    return (
        <>
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
                        role="tab"
                        selected={candidate === mode}
                        testID={`changes-mode-${candidate}`}
                        theme={theme}
                    />
                ))}
            </View>
            <View style={[styles.toolbar, { borderColor: theme.border }]}>
                <Text
                    accessibilityRole="header"
                    accessibilityLabel={
                        snapshot
                            ? changesSummaryLabel(
                                  snapshot.changedFileCount,
                                  snapshot.additions,
                                  snapshot.deletions,
                                  t,
                              )
                            : undefined
                    }
                    style={[styles.summary, { color: theme.text }]}
                    testID="changes-summary"
                >
                    {snapshot ? (
                        <>
                            {changedFilesSummary(snapshot.changedFileCount, t)} ·{' '}
                            <ChangesDiffStat
                                additions={snapshot.additions}
                                deletions={snapshot.deletions}
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
        </>
    );
};

/**
 * Outside Working Tree: the commit or pull request being shown, and the uncommitted work the mode hides.
 */
const ChangesModeNotices = ({
    mode,
    onModeChange,
    state,
    theme,
}: {
    mode: ChangesMode;
    onModeChange: (mode: ChangesMode) => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const contextLine = state.snapshot ? changesContextLine(state.snapshot.contexts) : null;
    const hiddenUncommitted =
        mode === 'working' || state.isStale || state.error
            ? 0
            : (state.snapshot?.uncommittedCount ?? 0);
    return (
        <>
            {contextLine ? (
                <Text
                    numberOfLines={1}
                    style={[styles.context, { borderColor: theme.border, color: theme.muted }]}
                    testID="changes-context"
                >
                    {contextLine}
                </Text>
            ) : null}
            {hiddenUncommitted > 0 ? (
                <NoticeBanner
                    actionLabel={t('changes.showUncommitted')}
                    message={t(
                        hiddenUncommitted === 1
                            ? 'changes.uncommittedHiddenOne'
                            : 'changes.uncommittedHiddenOther',
                        { count: hiddenUncommitted },
                    )}
                    onAction={() => onModeChange('working')}
                    actionTestID="changes-uncommitted-action"
                    testID="changes-uncommitted"
                    theme={theme}
                    tone="muted"
                />
            ) : null}
        </>
    );
};

export const ChangesView = ({
    canAskAgent,
    mode,
    onAskAgentToCommit,
    onAskAgentToOpenPullRequest,
    onModeChange,
    onOpenFile,
    onRefresh,
    state,
    theme,
}: {
    canAskAgent: boolean;
    mode: ChangesMode;
    onAskAgentToCommit: () => void;
    onAskAgentToOpenPullRequest: () => void;
    onModeChange: (mode: ChangesMode) => void;
    onOpenFile: (file: ChangedFile) => void;
    onRefresh: () => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const isRepo = state.snapshot?.isRepository !== false;
    return (
        <View style={styles.root} testID="changes-view">
            {isRepo ? (
                <ChangesToolbar
                    mode={mode}
                    onModeChange={onModeChange}
                    onRefresh={onRefresh}
                    state={state}
                    theme={theme}
                />
            ) : null}
            <ChangesModeNotices
                mode={mode}
                onModeChange={onModeChange}
                state={state}
                theme={theme}
            />
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
                onAskAgent={
                    canAskAgent && mode === 'pull-request' ? onAskAgentToOpenPullRequest : undefined
                }
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
