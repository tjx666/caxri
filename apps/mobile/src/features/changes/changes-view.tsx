import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { draculaTheme } from '@caxri/protocol';

import type { MobileTheme } from '../../theme/tokens';
import { ChangesListContent } from './changes-list-content';
import type { ChangedFile, ChangesViewState } from './changes-model';
import { changesSummary } from './changes-model';
import { changesStyles as styles } from './changes-styles';

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
}) => (
    <View style={styles.root} testID="changes-view">
        <View style={[styles.toolbar, { borderColor: theme.border }]}>
            <Text
                accessibilityRole="header"
                style={[styles.summary, { color: theme.text }]}
                testID="changes-summary"
            >
                {state.snapshot
                    ? changesSummary(
                          state.snapshot.changedFileCount,
                          state.snapshot.additions,
                          state.snapshot.deletions,
                      )
                    : 'Changes'}
            </Text>
            <Pressable
                accessibilityLabel="Refresh changes"
                accessibilityRole="button"
                accessibilityState={{ busy: state.isRefreshing }}
                onPress={onRefresh}
                style={styles.refresh}
                testID="changes-refresh"
            >
                {state.isRefreshing ? (
                    <ActivityIndicator color={theme.primary} />
                ) : (
                    <Text style={[styles.refreshText, { color: theme.primary }]}>↻</Text>
                )}
            </Pressable>
        </View>
        {state.isStale ? (
            <Text
                style={[styles.stale, { borderColor: theme.border, color: theme.muted }]}
                testID="changes-stale"
            >
                Connection lost. Showing the last known changes.
            </Text>
        ) : null}
        {state.snapshot && state.error ? (
            <Text
                accessibilityRole="alert"
                style={[styles.stale, { borderColor: theme.border, color: theme.danger }]}
            >
                Unable to refresh changes. Showing the last known changes.
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
                    accessibilityLabel="Ask Agent to commit"
                    accessibilityHint="Fills the message draft. Nothing is sent until you tap Send."
                    accessibilityRole="button"
                    onPress={onAskAgentToCommit}
                    style={[styles.commit, { borderColor: draculaTheme.colors.success }]}
                    testID="changes-ask-agent-commit"
                >
                    <Text style={[styles.commitText, { color: draculaTheme.colors.success }]}>
                        Ask Agent to commit
                    </Text>
                </Pressable>
            </View>
        ) : null}
    </View>
);
