/* eslint-disable no-use-before-define, @typescript-eslint/no-use-before-define -- React Native styles stay after the component they describe. */
import { useRef } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { LucideIcon } from 'lucide-react-native';
import { Camera, ChevronRight, ClipboardPaste, FolderOpen, Images } from 'lucide-react-native';

import { BottomSheet, SheetCancel, SheetTitle } from '../../../components/bottom-sheet';
import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import { mobileRadius, mobileSpace, mobileType, PRESSED_OPACITY } from '../../../theme/scale';
import type { MobileTheme } from '../../../theme/tokens';

/**
 * Where the next composer attachment comes from. The library offers photos and videos; `files` is the system document
 * picker, for any other file.
 */
export type AttachmentSource = 'camera' | 'clipboard' | 'files' | 'library';

const sources: Array<{
    icon: LucideIcon;
    /**
     * The tile's short caption; the full name is its accessible label.
     */
    captionKey: TranslationKey;
    labelKey: TranslationKey;
    source: AttachmentSource;
}> = [
    {
        icon: Images,
        captionKey: 'sessions.image.tileLibrary',
        labelKey: 'sessions.image.sourceLibrary',
        source: 'library',
    },
    {
        icon: Camera,
        captionKey: 'sessions.image.tileCamera',
        labelKey: 'sessions.image.sourceCamera',
        source: 'camera',
    },
    {
        icon: FolderOpen,
        captionKey: 'sessions.image.sourceFiles',
        labelKey: 'sessions.image.sourceFiles',
        source: 'files',
    },
    {
        icon: ClipboardPaste,
        captionKey: 'sessions.image.tileClipboard',
        labelKey: 'sessions.image.sourceClipboard',
        source: 'clipboard',
    },
];

/**
 * A row under the attachment tiles that opens one of the composer's own sheets, such as the Chat's model or usage. It
 * names the setting and shows its current value, so the collapsed composer still tells the reader where it stands.
 */
export interface ComposerAddSetting {
    accessibilityLabel?: string;
    /**
     * A read-only row: the value still shows, but the row takes no press (the device may not configure the Chat now).
     */
    disabled?: boolean;
    icon: LucideIcon;
    label: string;
    onPress: () => void;
    testID: string;
    value?: string;
}

type Picked =
    { kind: 'setting'; setting: ComposerAddSetting } | { kind: 'source'; source: AttachmentSource };

/**
 * The composer's `+` sheet, as LobeHub's mobile "Add to conversation" sheet: attachment sources as tiles across the
 * top, then the composer's settings as rows with their current value. A choice slides the sheet away like every other
 * exit, and only then opens the picker, camera, or the setting's own sheet, so two sheets or a system UI never stack.
 * `hidden` leaves out a source the composer cannot take, such as a pasted image for a provider without image input;
 * `canAttach` false (a device without reply access, or the attachment limit) leaves out every tile.
 */
export const ComposerAddSheet = ({
    canAttach = true,
    hidden = [],
    onClose,
    onPick,
    settings = [],
    theme,
    title,
}: {
    canAttach?: boolean;
    hidden?: readonly AttachmentSource[];
    onClose: () => void;
    onPick: (source: AttachmentSource) => void;
    settings?: readonly ComposerAddSetting[];
    theme: MobileTheme;
    title: string;
}) => {
    const { t } = useTranslation();
    const picked = useRef<Picked | null>(null);
    const hiddenSources = new Set(hidden);
    const tiles = canAttach ? sources.filter(({ source }) => !hiddenSources.has(source)) : [];
    return (
        <BottomSheet
            closeLabel={t('sessions.image.closeSources')}
            onClose={() => {
                onClose();
                const choice = picked.current;
                if (choice?.kind === 'source') onPick(choice.source);
                if (choice?.kind === 'setting') choice.setting.onPress();
            }}
            testID="image-source-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <SheetTitle theme={theme} title={title} />
                    {tiles.length > 0 ? (
                        <View style={styles.tiles}>
                            {tiles.map(({ captionKey, icon: Icon, labelKey, source }) => (
                                <Pressable
                                    accessibilityLabel={t(labelKey)}
                                    accessibilityRole="button"
                                    key={source}
                                    onPress={() => {
                                        picked.current = { kind: 'source', source };
                                        dismiss();
                                    }}
                                    style={({ pressed }) => [
                                        styles.tile,
                                        {
                                            backgroundColor: theme.elevated,
                                            opacity: pressed ? PRESSED_OPACITY : 1,
                                        },
                                    ]}
                                    testID={`image-source-${source}`}
                                >
                                    <Icon color={theme.text} size={24} />
                                    <Text
                                        numberOfLines={1}
                                        style={[styles.tileCaption, { color: theme.text }]}
                                    >
                                        {t(captionKey)}
                                    </Text>
                                </Pressable>
                            ))}
                        </View>
                    ) : null}
                    {settings.length > 0 ? (
                        <View style={[styles.settings, { backgroundColor: theme.elevated }]}>
                            {settings.map((setting, index) => (
                                <SettingRow
                                    hasDivider={index > 0}
                                    key={setting.testID}
                                    onPress={() => {
                                        picked.current = { kind: 'setting', setting };
                                        dismiss();
                                    }}
                                    setting={setting}
                                    theme={theme}
                                />
                            ))}
                        </View>
                    ) : null}
                    <SheetCancel onPress={dismiss} testID="image-source-cancel" theme={theme} />
                </>
            )}
        </BottomSheet>
    );
};

const SettingRow = ({
    hasDivider,
    onPress,
    setting,
    theme,
}: {
    hasDivider: boolean;
    onPress: () => void;
    setting: ComposerAddSetting;
    theme: MobileTheme;
}) => {
    const { disabled = false, icon: Icon, label, value } = setting;
    return (
        <Pressable
            accessibilityLabel={
                setting.accessibilityLabel ?? (value ? `${label}, ${value}` : label)
            }
            accessibilityRole="button"
            accessibilityState={{ disabled }}
            disabled={disabled}
            onPress={onPress}
            style={({ pressed }) => [styles.row, { opacity: pressed ? PRESSED_OPACITY : 1 }]}
            testID={setting.testID}
        >
            <Icon color={theme.muted} opacity={disabled ? 0.4 : 1} size={20} />
            <View
                style={[
                    styles.rowBody,
                    hasDivider
                        ? { borderColor: theme.border, borderTopWidth: StyleSheet.hairlineWidth }
                        : null,
                ]}
            >
                <Text
                    numberOfLines={1}
                    style={[styles.rowLabel, { color: theme.text, opacity: disabled ? 0.4 : 1 }]}
                >
                    {label}
                </Text>
                {value ? (
                    <Text numberOfLines={1} style={[styles.rowValue, { color: theme.muted }]}>
                        {value}
                    </Text>
                ) : null}
                {disabled ? null : <ChevronRight color={theme.muted} size={18} />}
            </View>
        </Pressable>
    );
};

const styles = StyleSheet.create({
    tiles: { flexDirection: 'row', gap: mobileSpace.sm, marginBottom: mobileSpace.md },
    tile: {
        alignItems: 'center',
        borderRadius: mobileRadius.lg,
        flex: 1,
        gap: mobileSpace.sm,
        justifyContent: 'center',
        minHeight: 80,
        paddingHorizontal: mobileSpace.xs,
    },
    tileCaption: { ...mobileType.meta },
    settings: { borderRadius: mobileRadius.lg, overflow: 'hidden' },
    row: {
        alignItems: 'center',
        flexDirection: 'row',
        gap: mobileSpace.md,
        paddingLeft: mobileSpace.lg,
    },
    rowBody: {
        alignItems: 'center',
        flex: 1,
        flexDirection: 'row',
        gap: mobileSpace.sm,
        minHeight: 52,
        paddingRight: mobileSpace.md,
    },
    rowLabel: { ...mobileType.body, flexShrink: 0 },
    rowValue: { ...mobileType.meta, flex: 1, textAlign: 'right' },
});

/* eslint-enable no-use-before-define, @typescript-eslint/no-use-before-define */
