import { memo, useCallback, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

import { IconButton } from '../../components/icon-button';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';
import { FileTypeIcon } from './file-type-icon';
import { PanelStatus, PendingPanelStatus } from './panel-status';
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
                <FileTypeIcon entry={entry} theme={theme} />
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
    deviceRole,
    entry,
    onBack,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    entry: FileEntry;
    onBack: () => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { request } = useMobileClient();
    const file = useFileRead(sessionId, entry.path);
    const [draft, setDraft] = useState<string | null>(null);
    const [expectedContentHash, setExpectedContentHash] = useState<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const discard = () => {
        setDraft(null);
        setExpectedContentHash(null);
        setSaveError(null);
        // eslint-disable-next-line no-void -- Query state owns the refreshed file result.
        void file.refetch();
    };
    const save = async () => {
        if (draft === null || expectedContentHash === null || saving) return;
        setSaving(true);
        setSaveError(null);
        try {
            await request('mobile.files.write', {
                sessionId,
                path: entry.path,
                content: draft,
                expectedContentHash,
            });
            setDraft(null);
            setExpectedContentHash(null);
            await file.refetch();
        } catch (error) {
            setSaveError(
                error instanceof MobileGatewayRequestError && error.code === 'CONFLICT'
                    ? 'This file changed on your computer. Discard and reload before editing again.'
                    : 'Unable to save this file. Try again.',
            );
        } finally {
            setSaving(false);
        }
    };
    const body = (() => {
        if (file.isPending)
            return <PendingPanelStatus fetchStatus={file.fetchStatus} theme={theme} />;
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
        const document = file.data;
        return (
            <View style={styles.preview}>
                {deviceRole === 'control' && !document.readOnly ? (
                    <View style={[styles.crumbs, styles.fileActions]}>
                        {draft === null ? (
                            <Pressable
                                accessibilityLabel="Edit file"
                                accessibilityRole="button"
                                onPress={() => {
                                    setDraft(document.content);
                                    setExpectedContentHash(document.contentHash);
                                }}
                                style={styles.fileAction}
                                testID="files-edit"
                            >
                                <Text style={{ color: theme.primary }}>Edit</Text>
                            </Pressable>
                        ) : (
                            <>
                                <Pressable
                                    accessibilityLabel="Save file"
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: saving }}
                                    disabled={saving}
                                    onPress={async () => {
                                        await save();
                                    }}
                                    style={styles.fileAction}
                                    testID="files-save"
                                >
                                    <Text style={{ color: theme.primary }}>Save</Text>
                                </Pressable>
                                <Pressable
                                    accessibilityLabel="Discard changes"
                                    accessibilityRole="button"
                                    onPress={discard}
                                    style={styles.fileAction}
                                    testID="files-discard"
                                >
                                    <Text style={{ color: theme.muted }}>Discard</Text>
                                </Pressable>
                            </>
                        )}
                    </View>
                ) : null}
                {saveError ? (
                    <Text
                        accessibilityRole="alert"
                        style={{ color: theme.danger }}
                        testID="files-save-error"
                    >
                        {saveError}
                    </Text>
                ) : null}
                {draft === null ? (
                    <ScrollView style={styles.preview}>
                        <ScrollView horizontal>
                            <Text
                                selectable
                                style={[styles.previewText, { color: theme.text }]}
                                testID="files-preview-text"
                            >
                                {document.content}
                            </Text>
                        </ScrollView>
                    </ScrollView>
                ) : (
                    <TextInput
                        accessibilityLabel="File contents"
                        autoCapitalize="none"
                        multiline
                        onChangeText={setDraft}
                        scrollEnabled
                        style={[styles.previewText, { color: theme.text, flex: 1 }]}
                        testID="files-editor"
                        textAlignVertical="top"
                        value={draft}
                    />
                )}
            </View>
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
                <FileTypeIcon entry={entry} size={18} theme={theme} />
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
export const FilesPanel = ({
    deviceRole,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    sessionId: string;
    theme: MobileTheme;
}) => {
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
                deviceRole={deviceRole}
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
                        <PendingPanelStatus fetchStatus={listing.fetchStatus} theme={theme} />
                    ) : listing.isError ? (
                        <PanelStatus
                            message="Unable to list this folder."
                            onRetry={() => {
                                // eslint-disable-next-line no-void -- The query renders its own error state.
                                void listing.refetch();
                            }}
                            testID="files-error"
                            theme={theme}
                        />
                    ) : (
                        <PanelStatus
                            message="This folder is empty."
                            testID="files-empty"
                            theme={theme}
                        />
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
