import { useState } from 'react';
import { ScrollView, Text, TextInput, View } from 'react-native';

import type { FileEntry } from '@caxri/protocol';
import { ChevronLeft } from 'lucide-react-native';

import { Button } from '../../components/button';
import { HighlightedCode } from '../../components/highlighted-code';
import { IconButton } from '../../components/icon-button';
import { ScreenState } from '../../components/screen-state';
import { useTranslation } from '../../i18n';
import type { MobileTheme } from '../../theme/tokens';
import { useMobileClient } from '../connection/mobile-client-provider';
import { MobileGatewayRequestError } from '../connection/mobile-gateway-client';
import { fileLanguage } from './file-language';
import { FilesBreadcrumb } from './files-breadcrumb';
import type { FilesDraft } from './files-navigation';
import { panelsStyles as styles } from './panels-styles';
import { PendingPanelState } from './pending-panel-state';
import { useFileRead } from './use-panels';

/**
 * A previewed text file, and for a control device its editor. The draft lives in the Files navigation store, not here,
 * so leaving the tab and coming back resumes the edit; this view owns only the save request and its error.
 */
export const FilePreview = ({
    deviceRole,
    draft,
    entry,
    folders,
    onChangeDraft,
    onDiscardDraft,
    onRequestBack,
    onSaved,
    onStartEdit,
    sessionId,
    theme,
}: {
    deviceRole: 'view' | 'reply' | 'control' | null;
    draft: FilesDraft | null;
    entry: FileEntry;
    /**
     * The open folder path above the previewed file.
     */
    folders: FileEntry[];
    onChangeDraft: (content: string) => void;
    onDiscardDraft: () => void;
    /**
     * Asks to leave the preview, optionally for an ancestor folder picked from the breadcrumb. The owner confirms first
     * when the draft has unsaved changes.
     */
    onRequestBack: (depth?: number) => void;
    onSaved: () => void;
    onStartEdit: (document: { content: string; contentHash: string }) => void;
    sessionId: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const { request } = useMobileClient();
    const file = useFileRead(sessionId, entry.path);
    const language = fileLanguage(entry.name);
    const [saving, setSaving] = useState(false);
    const [saveError, setSaveError] = useState<string | null>(null);
    const discard = () => {
        onDiscardDraft();
        setSaveError(null);
        void file.refetch();
    };
    const save = async () => {
        if (saving || draft === null) return;
        setSaving(true);
        setSaveError(null);
        try {
            await request('mobile.files.write', {
                sessionId,
                path: entry.path,
                content: draft.content,
                expectedContentHash: draft.baseHash,
            });
            onSaved();
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
    const body = (() => {
        if (file.isPending)
            return <PendingPanelState fetchStatus={file.fetchStatus} theme={theme} />;
        if (file.isError)
            return (
                <ScreenState
                    actionLabel={t('common.retry')}
                    kind="error"
                    onAction={() => {
                        void file.refetch();
                    }}
                    testID="files-preview-error"
                    theme={theme}
                    title={t('panels.openFileFailed')}
                />
            );
        if (file.data.status !== 'available')
            return (
                <ScreenState
                    kind="empty"
                    testID="files-preview-unavailable"
                    theme={theme}
                    title={t('panels.fileUnavailable')}
                />
            );
        const document = file.data;
        const canEdit = deviceRole === 'control' && !document.readOnly;
        return (
            <View style={styles.preview}>
                <View style={[styles.fileActions, { borderColor: theme.border }]}>
                    {canEdit ? (
                        /*
                        Distinct keys prevent the disabled Save native view from becoming Edit after a write.
                        */
                        draft === null ? (
                            <Button
                                key="edit"
                                label={t('panels.edit')}
                                onPress={() => onStartEdit(document)}
                                style={styles.fileAction}
                                testID="files-edit"
                                theme={theme}
                                variant="outline"
                            />
                        ) : (
                            <>
                                <Button
                                    key="save"
                                    isBusy={saving}
                                    label={t('panels.save')}
                                    onPress={async () => {
                                        await save();
                                    }}
                                    style={styles.fileAction}
                                    testID="files-save"
                                    theme={theme}
                                    variant="primary"
                                />
                                <Button
                                    key="discard"
                                    isDisabled={saving}
                                    label={t('panels.discard')}
                                    onPress={discard}
                                    style={styles.fileAction}
                                    testID="files-discard"
                                    theme={theme}
                                    variant="outline"
                                />
                            </>
                        )
                    ) : (
                        <Text
                            style={[styles.fileActionNote, { color: theme.muted }]}
                            testID="files-edit-unavailable"
                        >
                            {t(
                                deviceRole === 'control'
                                    ? 'panels.fileReadOnly'
                                    : 'panels.editNeedsControl',
                            )}
                        </Text>
                    )}
                </View>
                {saveError ? (
                    <Text
                        accessibilityRole="alert"
                        style={[styles.saveError, { color: theme.danger }]}
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
                        onChangeText={onChangeDraft}
                        scrollEnabled
                        style={[styles.previewText, { color: theme.text, flex: 1 }]}
                        testID="files-editor"
                        textAlignVertical="top"
                        /**
                         * The draft stays plain text. Highlighted spans as `TextInput` children re-render per keystroke
                         * and Android moves the caret, so a second typed character lands elsewhere in the file.
                         */
                        value={draft.content}
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
                    onPress={() => onRequestBack()}
                    testID="files-preview-back"
                    theme={theme}
                />
                <FilesBreadcrumb
                    onSelect={onRequestBack}
                    segments={[...folders, entry]}
                    theme={theme}
                />
            </View>
            {body}
        </View>
    );
};
