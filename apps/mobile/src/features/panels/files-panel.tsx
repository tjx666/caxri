import { memo, useCallback, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, ScrollView, Text, View } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronLeft, ChevronRight, File, Folder, FolderSymlink } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { PanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
import { useFileRead, useFilesList } from './use-panels';

const isDirectory = (entry: FileEntry): boolean =>
    entry.kind === 'directory' || (entry.kind === 'symlink' && entry.linkKind === 'directory');

const formatSize = (size: number | undefined): string | null => {
    if (size === undefined) return null;
    if (size < 1_024) return `${size} B`;
    if (size < 1_024 * 1_024) return `${Math.round(size / 1_024)} KB`;
    return `${(size / 1_024 / 1_024).toFixed(1)} MB`;
};

const FileRow = memo(
    ({
        entry,
        onOpen,
        theme,
    }: {
        entry: FileEntry;
        onOpen: (entry: FileEntry) => void;
        theme: MobileTheme;
    }) => {
        const isFolder = isDirectory(entry);
        const Icon = isFolder ? (entry.kind === 'symlink' ? FolderSymlink : Folder) : File;
        return (
            <Pressable
                accessibilityLabel={`${entry.name}, ${isFolder ? 'folder' : 'file'}`}
                accessibilityRole="button"
                disabled={entry.kind === 'symlink' && entry.linkKind === 'broken'}
                onPress={() => onOpen(entry)}
                style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: pressed ? theme.surface : 'transparent' },
                ]}
                testID={`files-entry-${entry.name}`}
            >
                <Icon color={isFolder ? theme.primary : theme.muted} size={18} strokeWidth={1.75} />
                <Text
                    numberOfLines={1}
                    style={[styles.rowText, { color: entry.gitIgnored ? theme.muted : theme.text }]}
                >
                    {entry.name}
                </Text>
                {isFolder ? (
                    <ChevronRight color={theme.muted} size={16} />
                ) : (
                    <Text style={[styles.rowMeta, { color: theme.muted }]}>
                        {formatSize(entry.size)}
                    </Text>
                )}
            </Pressable>
        );
    },
);

const FilePreview = ({
    entry,
    onBack,
    sessionId,
    theme,
}: {
    entry: FileEntry;
    onBack: () => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const file = useFileRead(sessionId, entry.path);
    const body = (() => {
        if (file.isPending) return <PanelStatus isLoading theme={theme} />;
        if (file.isError)
            return (
                <PanelStatus
                    message="Unable to open this file."
                    onRetry={() => {
                        // eslint-disable-next-line no-void -- The query renders its own error state.
                        void file.refetch();
                    }}
                    theme={theme}
                />
            );
        if (file.data.status !== 'available')
            return (
                <PanelStatus
                    message="This file is too large or not text. Open it on your computer."
                    testID="files-preview-unavailable"
                    theme={theme}
                />
            );
        return (
            <ScrollView style={styles.preview}>
                <ScrollView horizontal>
                    <Text
                        selectable
                        style={[styles.previewText, { color: theme.text }]}
                        testID="files-preview-text"
                    >
                        {file.data.content}
                    </Text>
                </ScrollView>
            </ScrollView>
        );
    })();
    return (
        <View style={styles.root}>
            <View style={[styles.crumbs, { borderColor: theme.border }]}>
                <IconButton
                    accessibilityLabel="Back to folder"
                    icon={ChevronLeft}
                    onPress={onBack}
                    testID="files-preview-back"
                    theme={theme}
                />
                <Text numberOfLines={1} style={[styles.crumbText, { color: theme.text }]}>
                    {entry.name}
                </Text>
            </View>
            {body}
        </View>
    );
};

/**
 * Read-only mirror of Desktop's Files explorer: walk folders under the Session's Project and preview text files. Entry
 * paths come from the Server listing and are passed back unchanged, so symlinks reached through the Project keep their
 * workspace identity.
 */
export const FilesPanel = ({ sessionId, theme }: { sessionId: string; theme: MobileTheme }) => {
    const [stack, setStack] = useState<FileEntry[]>([]);
    const [preview, setPreview] = useState<FileEntry | null>(null);
    const directory = stack.at(-1);
    const listing = useFilesList(sessionId, directory?.path);
    const openEntry = useCallback((entry: FileEntry) => {
        if (isDirectory(entry)) setStack((current) => [...current, entry]);
        else setPreview(entry);
    }, []);
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<FileEntry>) => (
            <FileRow entry={item} onOpen={openEntry} theme={theme} />
        ),
        [openEntry, theme],
    );
    if (preview)
        return (
            <FilePreview
                entry={preview}
                onBack={() => setPreview(null)}
                sessionId={sessionId}
                theme={theme}
            />
        );
    return (
        <View style={styles.root} testID="files-panel">
            {directory ? (
                <View style={[styles.crumbs, { borderColor: theme.border }]}>
                    <IconButton
                        accessibilityLabel="Up one folder"
                        icon={ChevronLeft}
                        onPress={() => setStack((current) => current.slice(0, -1))}
                        testID="files-up"
                        theme={theme}
                    />
                    <Text numberOfLines={1} style={[styles.crumbText, { color: theme.text }]}>
                        {stack.map((entry) => entry.name).join(' / ')}
                    </Text>
                </View>
            ) : null}
            <FlatList
                data={listing.data?.entries ?? []}
                keyExtractor={(entry) => entry.path}
                ListEmptyComponent={
                    listing.isPending ? (
                        <PanelStatus isLoading theme={theme} />
                    ) : listing.isError ? (
                        <PanelStatus
                            message="Unable to list this folder."
                            onRetry={() => {
                                // eslint-disable-next-line no-void -- The query renders its own error state.
                                void listing.refetch();
                            }}
                            theme={theme}
                        />
                    ) : (
                        <PanelStatus message="This folder is empty." theme={theme} />
                    )
                }
                ListFooterComponent={
                    listing.data?.truncated ? (
                        <PanelStatus
                            message="Showing the first entries. Open the rest on your computer."
                            theme={theme}
                        />
                    ) : null
                }
                onRefresh={() => {
                    // eslint-disable-next-line no-void -- The query renders its own error state.
                    void listing.refetch();
                }}
                refreshing={listing.isRefetching}
                renderItem={renderEntry}
            />
        </View>
    );
};
