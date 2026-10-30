import { useRef } from 'react';

import { Camera, ClipboardPaste, FolderOpen, Images } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel } from '../../../components/bottom-sheet';
import type { TranslationKey } from '../../../i18n';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';

/**
 * Where the next composer attachment comes from. The library offers photos and videos; `files` is the system document
 * picker, for any other file.
 */
export type AttachmentSource = 'camera' | 'clipboard' | 'files' | 'library';

const sources: Array<{
    icon: typeof Images;
    labelKey: TranslationKey;
    source: AttachmentSource;
}> = [
    { icon: Images, labelKey: 'sessions.image.sourceLibrary', source: 'library' },
    { icon: Camera, labelKey: 'sessions.image.sourceCamera', source: 'camera' },
    { icon: FolderOpen, labelKey: 'sessions.image.sourceFiles', source: 'files' },
    { icon: ClipboardPaste, labelKey: 'sessions.image.sourceClipboard', source: 'clipboard' },
];

/**
 * The composer's attachment sources. A choice slides the sheet away like every other exit, and only then opens the
 * picker or camera so the system UI never stacks over the sheet. `hidden` leaves out a source the composer cannot take,
 * such as a pasted image for a provider without image input.
 */
export const AttachmentSourceSheet = ({
    hidden = [],
    onClose,
    onPick,
    theme,
}: {
    hidden?: readonly AttachmentSource[];
    onClose: () => void;
    onPick: (source: AttachmentSource) => void;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    const picked = useRef<AttachmentSource | null>(null);
    return (
        <BottomSheet
            closeLabel={t('sessions.image.closeSources')}
            onClose={() => {
                onClose();
                if (picked.current) onPick(picked.current);
            }}
            testID="image-source-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    {sources
                        .filter(({ source }) => !hidden.includes(source))
                        .map(({ icon, labelKey, source }) => (
                            <SheetAction
                                icon={icon}
                                key={source}
                                label={t(labelKey)}
                                onPress={() => {
                                    picked.current = source;
                                    dismiss();
                                }}
                                testID={`image-source-${source}`}
                                theme={theme}
                            />
                        ))}
                    <SheetCancel onPress={dismiss} testID="image-source-cancel" theme={theme} />
                </>
            )}
        </BottomSheet>
    );
};
