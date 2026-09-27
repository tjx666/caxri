import { useCallback } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';

import type { MobileTheme } from '../../theme/tokens';
import type { ChangedFile, ChangesViewState } from './changes-model';
import { changePathParts, changeStatusLabel, hasMultipleRepositories } from './changes-model';
import { changesStyles as styles } from './changes-styles';

/**
 * Matches Desktop's Source Control letters, reading from the dedicated `--git-*` roles rather than `success` /
 * `warning` / `danger` / `primary`: those identify pull requests, connection health, and focus, and collapse distinct
 * change kinds onto colors that mean something else. `renamed` shares `gitUntracked` rather than the accent, mirroring
 * Desktop's `gitDecorationClassName` (VS Code's two decoration defaults resolve to the same green).
 */
const statusColor = (status: ChangedFile['status'], theme: MobileTheme): string =>
    ({
        A: theme.gitAdded,
        D: theme.gitDeleted,
        M: theme.gitModified,
        R: theme.gitUntracked,
    })[status];

const ChangeFileRow = ({
    file,
    index,
    onOpen,
    showRepoName,
    theme,
}: {
    file: ChangedFile;
    index: number;
    onOpen: (file: ChangedFile) => void;
    showRepoName: boolean;
    theme: MobileTheme;
}) => {
    const { directory, filename } = changePathParts(file.path);
    return (
        <Pressable
            accessibilityLabel={`${filename}, ${changeStatusLabel[file.status]}${file.originalPath ? ` from ${file.originalPath}` : ''}, directory ${directory || 'root'}, repository ${file.repositoryName}, ${file.additions} lines added, ${file.deletions} lines removed`}
            accessibilityRole="button"
            onPress={() => onOpen(file)}
            style={[styles.fileRow, { borderColor: theme.border }]}
            testID={`changes-file-row-${index}`}
        >
            <Text
                style={[
                    styles.status,
                    {
                        backgroundColor: theme.surface,
                        color: statusColor(file.status, theme),
                    },
                ]}
            >
                {file.status}
            </Text>
            <View style={styles.pathColumn}>
                <Text numberOfLines={2} style={styles.path}>
                    <Text style={[styles.directory, { color: theme.muted }]}>{directory}</Text>
                    <Text style={[styles.filename, { color: theme.text }]}>{filename}</Text>
                </Text>
                {showRepoName ? (
                    <Text numberOfLines={1} style={[styles.repositoryName, { color: theme.muted }]}>
                        {file.repositoryName}
                    </Text>
                ) : null}
            </View>
            <Text style={[styles.stats, { color: theme.muted }]}>
                +{file.additions} −{file.deletions}
            </Text>
        </Pressable>
    );
};

const ChangesStatus = ({
    kind,
    message,
    onRefresh,
    theme,
    title,
}: {
    kind: 'loading' | 'stale-empty' | 'error' | 'empty';
    message: string;
    onRefresh: () => void;
    theme: MobileTheme;
    title?: string;
}) => (
    <View style={styles.state} testID={`changes-${kind}`}>
        {kind === 'loading' ? <ActivityIndicator color={theme.primary} /> : null}
        {title ? <Text style={[styles.stateTitle, { color: theme.text }]}>{title}</Text> : null}
        <Text
            accessibilityRole={kind === 'error' ? 'alert' : undefined}
            style={[styles.stateBody, { color: kind === 'error' ? theme.danger : theme.muted }]}
        >
            {message}
        </Text>
        {kind === 'error' ? (
            <Pressable
                accessibilityRole="button"
                onPress={onRefresh}
                style={[styles.commit, { borderColor: theme.border }]}
            >
                <Text style={[styles.commitText, { color: theme.primary }]}>Retry</Text>
            </Pressable>
        ) : null}
    </View>
);

export const ChangesListContent = ({
    onOpenFile,
    onRefresh,
    state,
    theme,
}: {
    onOpenFile: (file: ChangedFile) => void;
    onRefresh: () => void;
    state: ChangesViewState;
    theme: MobileTheme;
}) => {
    const { snapshot } = state;
    const showRepoName = hasMultipleRepositories(snapshot?.files ?? []);
    const renderItem = useCallback(
        ({ item, index }: ListRenderItemInfo<ChangedFile>) => (
            <ChangeFileRow
                file={item}
                index={index}
                onOpen={onOpenFile}
                showRepoName={showRepoName}
                theme={theme}
            />
        ),
        [onOpenFile, showRepoName, theme],
    );
    const keyExtractor = useCallback(
        (file: ChangedFile) => `${file.repositoryId}:${file.path}`,
        [],
    );
    if (!snapshot) {
        if (state.isStale)
            return (
                <ChangesStatus
                    kind="stale-empty"
                    message="Reconnect to review changes."
                    onRefresh={onRefresh}
                    theme={theme}
                />
            );
        if (state.isLoading)
            return (
                <ChangesStatus
                    kind="loading"
                    message="Loading changes…"
                    onRefresh={onRefresh}
                    theme={theme}
                />
            );
        return (
            <ChangesStatus
                kind="error"
                message="Unable to load changes."
                onRefresh={onRefresh}
                theme={theme}
            />
        );
    }
    if (snapshot.files.length === 0) {
        return (
            <ChangesStatus
                kind="empty"
                title={snapshot.isRepository ? 'No changes' : 'No Git repository'}
                message={
                    snapshot.isRepository
                        ? "This Session's worktree is clean."
                        : 'Open a Session in a Git Project to review changes.'
                }
                onRefresh={onRefresh}
                theme={theme}
            />
        );
    }
    return (
        <FlatList
            data={snapshot.files}
            keyExtractor={keyExtractor}
            renderItem={renderItem}
            style={styles.list}
            ListFooterComponent={
                snapshot.truncated ? (
                    <Text style={[styles.stale, { color: theme.muted }]}>
                        Showing the first {snapshot.files.length} changes.
                    </Text>
                ) : null
            }
        />
    );
};
