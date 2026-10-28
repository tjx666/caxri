import { memo, useCallback, useMemo, useState } from 'react';
import type { ListRenderItemInfo } from 'react-native';
import { FlatList, Pressable, Text, View } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronLeft, ChevronRight } from 'lucide-react-native';

import { ConfirmSheet } from '../../components/confirm-sheet';
import { IconButton } from '../../components/icon-button';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import { formatByteSize } from '../../lib/format-size';
import { useSessionViewState } from '../../lib/session-view-store';
import { useHardwareBack } from '../../lib/use-hardware-back';
import type { MobileTheme } from '../../theme/tokens';
import { FilePreview } from './file-preview';
import { FileTypeIcon } from './file-type-icon';
import { FilesBreadcrumb } from './files-breadcrumb';
import {
    closePreview,
    discardDraft,
    editDraft,
    filesNavigationStore,
    isDraftDirty,
    keepFolders,
    startDraft,
    stepBack,
} from './files-navigation';
import { panelsStyles as styles } from './panels-styles';
import { PendingPanelState } from './pending-panel-state';
import { useFilesList } from './use-panels';

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

/**
 * Mirrors Desktop's Files explorer: walk folders under the Session's Project and preview text files. A Control device
 * can also edit and save a previewed file (see `FilePreview`); every other device role stays read-only. Entry paths
 * come from the Server listing and are passed back unchanged, so symlinks reached through the Project keep their
 * workspace identity.
 *
 * Where the reader stands (folders, previewed file, unsaved draft) lives in `filesNavigationStore`, so a tab switch
 * does not lose it, and hardware Back walks out one level at a time instead of dropping the whole view.
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
    const [navigation, update] = useSessionViewState(filesNavigationStore, sessionId);
    const { draft, preview, stack } = navigation;
    /**
     * What a confirmed discard does next: leave for `depth` folders (or the current folder), or stay and close the
     * editor (hardware Back from the editor).
     */
    const [pendingDiscard, setPendingDiscard] = useState<
        { kind: 'leave'; depth?: number } | { kind: 'editor' } | null
    >(null);
    const directory = stack.at(-1);
    const listing = useFilesList(sessionId, directory?.path);
    const openEntry = useCallback(
        (entry: FileEntry) =>
            update((current) =>
                isDirectory(entry)
                    ? { ...current, stack: [...current.stack, entry] }
                    : { ...current, draft: null, preview: entry },
            ),
        [update],
    );
    const renderEntry = useCallback(
        ({ item }: ListRenderItemInfo<FileEntry>) => (
            <FileRow entry={item} onOpen={openEntry} theme={theme} />
        ),
        [openEntry, theme],
    );
    /**
     * Leaving the preview with an unsaved edit would discard it silently, so the on-screen Back and the breadcrumb ask
     * first. A draft nobody typed in leaves without asking.
     */
    const requestLeave = (depth?: number): void => {
        if (isDraftDirty(draft)) setPendingDiscard({ kind: 'leave', depth });
        else update((current) => closePreview(current, depth));
    };
    const onHardwareBack = useMemo(() => {
        if (preview === null && stack.length === 0) return null;
        return (): boolean => {
            const step = stepBack(navigation);
            if (step.kind === 'unhandled') return false;
            if (step.kind === 'confirm-discard') setPendingDiscard({ kind: 'editor' });
            else update(() => step.next);
            return true;
        };
    }, [navigation, preview, stack.length, update]);
    useHardwareBack(onHardwareBack);
    const discardSheet = pendingDiscard ? (
        <ConfirmSheet
            confirmLabel={t('panels.discard')}
            detail={t('panels.discardDetail')}
            onClose={() => setPendingDiscard(null)}
            onConfirm={() => {
                // Unmount with the view: a leave closes the preview this sheet belongs to.
                setPendingDiscard(null);
                update((current) =>
                    pendingDiscard.kind === 'leave'
                        ? closePreview(current, pendingDiscard.depth)
                        : discardDraft(current),
                );
            }}
            testID="files-discard-confirm"
            theme={theme}
            title={t('panels.discardTitle')}
            tone="danger"
        />
    ) : null;
    if (preview)
        return (
            <>
                <FilePreview
                    deviceRole={deviceRole}
                    draft={draft}
                    entry={preview}
                    folders={stack}
                    onChangeDraft={(content) => update((current) => editDraft(current, content))}
                    onDiscardDraft={() => update(discardDraft)}
                    onRequestBack={requestLeave}
                    onSaved={() => update(discardDraft)}
                    onStartEdit={(document) => update((current) => startDraft(current, document))}
                    sessionId={sessionId}
                    theme={theme}
                />
                {discardSheet}
            </>
        );
    return (
        <View style={styles.root} testID="files-panel">
            {directory ? (
                <View style={[styles.crumbs, { borderColor: theme.border }]}>
                    <IconButton
                        accessibilityLabel={t('panels.upOneFolder')}
                        icon={ChevronLeft}
                        onPress={() =>
                            update((current) => keepFolders(current, current.stack.length - 1))
                        }
                        testID="files-up"
                        theme={theme}
                    />
                    <FilesBreadcrumb
                        onSelect={(depth) => update((current) => keepFolders(current, depth))}
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
                        <PendingPanelState fetchStatus={listing.fetchStatus} theme={theme} />
                    ) : listing.isError ? (
                        <ScreenState
                            actionLabel={t('common.retry')}
                            kind="error"
                            onAction={() => {
                                void listing.refetch();
                            }}
                            testID="files-error"
                            theme={theme}
                            title={t('panels.listFailed')}
                        />
                    ) : (
                        <ScreenState
                            kind="empty"
                            testID="files-empty"
                            theme={theme}
                            title={t('panels.folderEmpty')}
                        />
                    )
                }
                ListFooterComponent={
                    listing.data?.truncated ? (
                        <Text style={[styles.listNote, { color: theme.muted }]}>
                            {t('panels.listTruncated')}
                        </Text>
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
