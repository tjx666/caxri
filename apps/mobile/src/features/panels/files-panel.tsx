import { memo, useCallback, useRef, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

import { HighlightedCode } from '../../components/highlighted-code';
import { IconButton } from '../../components/icon-button';
import { useTranslation } from '../../i18n';
import { formatByteSize } from '../../lib/format-size';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';
import { fileLanguage } from './file-language';
import { FileTypeIcon } from './file-type-icon';
import { FilesBreadcrumb } from './files-breadcrumb';
import { PanelStatus, PendingPanelStatus } from './panel-status';
import { panelsStyles as styles } from './panels-styles';
import { useFileRead, useFilesList } from './use-panels';

const isDirectory = (entry: FileEntry): boolean =>
    entry.kind === 'directory' || (entry.kind === 'symlink' && entry.linkKind === 'directory');

const isBrokenSymlink = (entry: FileEntry): boolean =>
    entry.kind === 'symlink' && entry.linkKind === 'broken';

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
        const { t } = useTranslation();
        const isFolder = isDirectory(entry);
        const isBroken = isBrokenSymlink(entry);
        const isDimmed = entry.gitIgnored ?? isBroken;
        return (
            <Pressable
                accessibilityLabel={t(
                    isBroken
                        ? 'panels.entryBrokenLink'
                        : isFolder
                          ? 'panels.entryFolder'
                          : 'panels.entryFile',
                    { name: entry.name },
                )}
                accessibilityRole="button"
                disabled={isBroken}
                onPress={() => onOpen(entry)}
                style={({ pressed }) => [
                    styles.row,
                    { backgroundColor: pressed ? theme.surface : 'transparent' },
                ]}
                testID={`files-entry-${entry.name}`}
            >
                <FileTypeIcon dimmed={isDimmed} entry={entry} theme={theme} />
                <Text
                    numberOfLines={1}
                    style={[styles.rowText, { color: isDimmed ? theme.muted : theme.text }]}
                >
                    {entry.name}
                </Text>
                {isFolder ? (
                    <ChevronRight color={theme.muted} size={16} />
                ) : (
                    <Text style={[styles.rowMeta, { color: theme.muted }]}>
                        {formatByteSize(entry.size)}
                    </Text>
                )}
            </Pressable>
        );
    },
);

const FilePreview = ({
    deviceRole,
    entry,
    folders,
    onBack,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    entry: FileEntry;
    /**
     * The open folder path above the previewed file.
     */
    folders: FileEntry[];
    /**
     * Closes the preview, optionally returning to an ancestor folder picked from the breadcrumb.
     */
    onBack: (depth?: number) => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request } = useMobileClient();
    const file = useFileRead(sessionId, entry.path);
    const language = fileLanguage(entry.name);
    const [draft, setDraft] = useState<string | null>(null);
    const expectedContentHash = useRef<string | null>(null);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const discard = () => {
        setDraft(null);
        expectedContentHash.current = null;
        setSaveError(null);
        void file.refetch();
    };
    const save = async () => {
        if (saving || draft === null || expectedContentHash.current === null) return;
        setSaving(true);
        setSaveError(null);
        try {
            await request('mobile.files.write', {
                sessionId,
                path: entry.path,
                content: draft,
                expectedContentHash: expectedContentHash.current,
            });
            setDraft(null);
            expectedContentHash.current = null;
            await file.refetch();
        } catch (error) {
            setSaveError(
                t(
                    error instanceof MobileGatewayRequestError && error.code === 'CONFLICT'
                        ? 'panels.saveConflict'
                        : 'panels.saveFailed',
                ),
            );
        } finally {
            setSaving(false);
        }
    };
    /**
     * Leaving the preview with an unsaved draft would discard it silently, so an in-progress edit is confirmed before
     * the Back action or a breadcrumb navigates away.
     */
    const confirmBack = (depth?: number): void => {
        if (draft === null) {
            onBack(depth);
            return;
        }
        Alert.alert(t('panels.discardTitle'), undefined, [
            { text: t('panels.keepEditing'), style: 'cancel' },
            { text: t('panels.discard'), style: 'destructive', onPress: () => onBack(depth) },
        ]);
    };
    const body = (() => {
        if (file.isPending)
            return <PendingPanelStatus fetchStatus={file.fetchStatus} theme={theme} />;
        if (file.isError)
            return (
                <PanelStatus
                    message={t('panels.openFileFailed')}
                    onRetry={() => {
                        void file.refetch();
                    }}
                    theme={theme}
                />
            );
        if (file.data.status !== 'available')
            return (
                <PanelStatus
                    message={t('panels.fileUnavailable')}
                    testID="files-preview-unavailable"
                    theme={theme}
                />
            );
        const document = file.data;
        return (
            <View style={styles.preview}>
                {deviceRole === 'control' && !document.readOnly ? (
                    <View style={[styles.crumbs, styles.fileActions]}>
                        {/* Distinct keys prevent the disabled Save native view from becoming Edit after a write. */}
                        {draft === null ? (
                            <Pressable
                                accessibilityLabel={t('panels.editFile')}
                                accessibilityRole="button"
                                key="edit"
                                onPress={() => {
                                    setDraft(document.content);
                                    expectedContentHash.current = document.contentHash;
                                }}
                                style={styles.fileAction}
                                testID="files-edit"
                            >
                                <Text style={{ color: theme.primary }}>{t('panels.edit')}</Text>
                            </Pressable>
                        ) : (
                            <>
                                <Pressable
                                    accessibilityLabel={t('panels.saveFile')}
                                    accessibilityRole="button"
                                    accessibilityState={{ disabled: saving }}
                                    disabled={saving}
                                    key="save"
                                    onPress={async () => {
                                        await save();
                                    }}
                                    style={styles.fileAction}
                                    testID="files-save"
                                >
                                    <Text style={{ color: theme.primary }}>{t('panels.save')}</Text>
                                </Pressable>
                                <Pressable
                                    accessibilityLabel={t('panels.discardChanges')}
                                    accessibilityRole="button"
                                    onPress={discard}
                                    style={styles.fileAction}
                                    testID="files-discard"
                                >
                                    <Text style={{ color: theme.muted }}>
                                        {t('panels.discard')}
                                    </Text>
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
                                <HighlightedCode code={document.content} language={language} />
                            </Text>
                        </ScrollView>
                    </ScrollView>
                ) : (
                    <TextInput
                        accessibilityLabel={t('panels.fileContents')}
                        autoCapitalize="none"
                        multiline
                        onChangeText={setDraft}
                        scrollEnabled
                        style={[styles.previewText, { color: theme.text, flex: 1 }]}
                        testID="files-editor"
                        textAlignVertical="top"
                        /**
                         * The draft stays plain text. Highlighted spans as `TextInput` children re-render per keystroke
                         * and Android moves the caret, so a second typed character lands elsewhere in the file.
                         */
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
                    accessibilityLabel={t('panels.backToFolder')}
                    icon={ChevronLeft}
                    onPress={() => confirmBack()}
                    testID="files-preview-back"
                    theme={theme}
                />
                <FilesBreadcrumb
                    onSelect={confirmBack}
                    segments={[...folders, entry]}
                    theme={theme}
                />
            </View>
            {body}
        </View>
    );
};

/**
 * Mirrors Desktop's Files explorer: walk folders under the Session's Project and preview text files. A Control device
 * can also edit and save a previewed file (see `FilePreview`); every other device role stays read-only. Entry paths
 * come from the Server listing and are passed back unchanged, so symlinks reached through the Project keep their
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
    const { t } = useTranslation();
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
                folders={stack}
                onBack={(depth) => {
                    setPreview(null);
                    if (depth !== undefined) setStack((current) => current.slice(0, depth));
                }}
                sessionId={sessionId}
                theme={theme}
            />
        );
    return (
        <View style={styles.root} testID="files-panel">
            {directory ? (
                <View style={[styles.crumbs, { borderColor: theme.border }]}>
                    <IconButton
                        accessibilityLabel={t('panels.upOneFolder')}
                        icon={ChevronLeft}
                        onPress={() => setStack((current) => current.slice(0, -1))}
                        testID="files-up"
                        theme={theme}
                    />
                    <FilesBreadcrumb
                        onSelect={(depth) => setStack((current) => current.slice(0, depth))}
                        segments={stack}
                        theme={theme}
                    />
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
                            message={t('panels.listFailed')}
                            onRetry={() => {
                                void listing.refetch();
                            }}
                            testID="files-error"
                            theme={theme}
                        />
                    ) : (
                        <PanelStatus
                            message={t('panels.folderEmpty')}
                            testID="files-empty"
                            theme={theme}
                        />
                    )
                }
                ListFooterComponent={
                    listing.data?.truncated ? (
                        <PanelStatus message={t('panels.listTruncated')} theme={theme} />
                    ) : undefined
                }
                onRefresh={() => {
                    void listing.refetch();
                }}
                refreshing={listing.isRefetching}
                renderItem={renderEntry}
            />
        </View>
    );
};
