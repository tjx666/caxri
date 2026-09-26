import { memo, useCallback } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { ActivityIndicator, FlatList, Pressable, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import type { MethodResult } from '@caxri/protocol';
import { useRouter } from 'expo-router';
import { ChevronLeft, ChevronRight, Folder, FolderGit2, Plus, X } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileTheme } from '../../theme/use-mobile-theme';
import { addProjectStyles as styles } from './add-project-styles';
import { canAddProjectBrowserEntry, canAddProjectBrowserLevel } from './project-browser-model';
import { useProjectBrowser } from './use-project-browser';

type BrowseEntry = MethodResult<'mobile.project.browse'>['entries'][number];

const FolderRow = memo(
    ({
        entry,
        isAdding,
        onAdd,
        onOpen,
        theme,
    }: {
        entry: BrowseEntry;
        isAdding: boolean;
        onAdd: (path: string) => Promise<void>;
        onOpen: (level: { name: string; path: string }) => void;
        theme: MobileTheme;
    }) => {
        const Icon = entry.isGitRepository ? FolderGit2 : Folder;
        return (
            <View style={styles.row}>
                <Pressable
                    accessibilityHint={entry.hasChildren ? 'Opens this folder.' : undefined}
                    accessibilityLabel={`${entry.name}${entry.isGitRepository ? ', Git repository' : ''}`}
                    accessibilityRole="button"
                    disabled={!entry.hasChildren}
                    onPress={() => onOpen({ name: entry.name, path: entry.relativePath })}
                    style={({ pressed }) => [styles.rowMain, { opacity: pressed ? 0.6 : 1 }]}
                    testID={`add-project-folder-${entry.relativePath}`}
                >
                    <Icon color={entry.isGitRepository ? theme.primary : theme.muted} size={20} />
                    <Text numberOfLines={1} style={[styles.rowTitle, { color: theme.text }]}>
                        {entry.name}
                    </Text>
                    {entry.hasChildren ? <ChevronRight color={theme.muted} size={18} /> : null}
                </Pressable>
                {canAddProjectBrowserEntry(entry) ? (
                    <Pressable
                        accessibilityLabel={`Add ${entry.name} as a Project`}
                        accessibilityRole="button"
                        disabled={isAdding}
                        onPress={() => {
                            // eslint-disable-next-line no-void -- The hook renders add failures.
                            void onAdd(entry.relativePath);
                        }}
                        style={[styles.addPill, { borderColor: theme.primary }]}
                        testID={`add-project-add-${entry.relativePath}`}
                    >
                        {isAdding ? (
                            <ActivityIndicator color={theme.primary} size="small" />
                        ) : (
                            <Plus color={theme.primary} size={16} />
                        )}
                        <Text style={[styles.addPillText, { color: theme.primary }]}>Add</Text>
                    </Pressable>
                ) : null}
            </View>
        );
    },
);

const AddProjectFooter = ({
    browser,
    onAdd,
    theme,
}: {
    browser: ReturnType<typeof useProjectBrowser>;
    onAdd: (path: string) => Promise<void>;
    theme: MobileTheme;
}) => (
    <View style={[styles.footer, { borderColor: theme.border }]}>
        {browser.addError ? (
            <Text
                accessibilityRole="alert"
                style={[styles.error, { color: theme.danger }]}
                testID="add-project-error"
            >
                {browser.addError}
            </Text>
        ) : null}
        {canAddProjectBrowserLevel(browser.level) ? (
            <Pressable
                accessibilityRole="button"
                disabled={browser.addingPath !== null || !browser.isConnected}
                onPress={() => {
                    const { path } = browser.level;
                    // eslint-disable-next-line no-void -- The hook renders add failures.
                    if (path !== null) void onAdd(path);
                }}
                style={[
                    styles.primary,
                    {
                        backgroundColor: theme.primary,
                        opacity: browser.addingPath === null ? 1 : 0.6,
                    },
                ]}
                testID="add-project-add-current"
            >
                <Text style={[styles.primaryText, { color: theme.primaryForeground }]}>
                    {browser.addingPath === browser.level.path
                        ? 'Adding…'
                        : `Add “${browser.level.name}”`}
                </Text>
            </Pressable>
        ) : (
            <Text style={[styles.hint, { color: theme.muted }]}>
                Open a folder to add it, or tap Add beside one.
            </Text>
        )}
    </View>
);

/**
 * Browses folders under the computer's home directory and adds one as a Project granted to this device. The Server owns
 * every path check; this screen only walks the listing it returns.
 */
export const AddProjectScreen = () => {
    const router = useRouter();
    const theme = useMobileTheme();
    const browser = useProjectBrowser();
    const { add, addingPath, enter } = browser;
    const addAndClose = useCallback(
        async (path: string): Promise<void> => {
            if (await add(path)) router.back();
        },
        [add, router],
    );
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<BrowseEntry>) => (
            <FolderRow
                entry={item}
                isAdding={addingPath === item.relativePath}
                onAdd={addAndClose}
                onOpen={enter}
                theme={theme}
            />
        ),
        [addAndClose, addingPath, enter, theme],
    );
    const entries = browser.listing.data?.entries ?? [];
    return (
        <SafeAreaView
            edges={['top', 'right', 'bottom', 'left']}
            style={[styles.root, { backgroundColor: theme.background }]}
            testID="add-project-screen"
        >
            <View style={styles.header}>
                <IconButton
                    accessibilityLabel={browser.canGoUp ? 'Up one folder' : 'Close'}
                    icon={browser.canGoUp ? ChevronLeft : X}
                    onPress={browser.canGoUp ? browser.up : () => router.back()}
                    size={24}
                    testID="add-project-back"
                    theme={theme}
                />
                <View style={styles.headerCopy}>
                    <Text accessibilityRole="header" style={[styles.title, { color: theme.text }]}>
                        Add Project
                    </Text>
                    <Text numberOfLines={1} style={[styles.subtitle, { color: theme.muted }]}>
                        {browser.level.path === null ? 'Home' : `~/${browser.level.path}`}
                    </Text>
                </View>
            </View>
            <FlatList
                contentContainerStyle={styles.listContent}
                data={entries}
                keyExtractor={(entry) => entry.relativePath}
                ListEmptyComponent={
                    <View style={styles.empty}>
                        {browser.listing.isPending ? (
                            <ActivityIndicator color={theme.muted} />
                        ) : (
                            <Text style={[styles.emptyText, { color: theme.muted }]}>
                                {browser.listing.isError
                                    ? 'Unable to list this folder.'
                                    : 'No folders here.'}
                            </Text>
                        )}
                    </View>
                }
                ListFooterComponent={
                    browser.listing.data?.truncated ? (
                        <Text style={[styles.emptyText, { color: theme.muted }]}>
                            Showing the first {entries.length} folders.
                        </Text>
                    ) : null
                }
                renderItem={renderEntry}
                style={styles.list}
            />
            <AddProjectFooter browser={browser} onAdd={addAndClose} theme={theme} />
        </SafeAreaView>
    );
};
