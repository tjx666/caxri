import { useRef } from 'react';

import { Camera, ClipboardPaste, Images } from 'lucide-react-native';

import { BottomSheet, SheetAction, SheetCancel } from '../../../components/bottom-sheet';
import type { MobileTheme } from '../../../theme/tokens';
import type { ImageSource } from '../hooks/use-image-attachments';

const sources: Array<{ icon: typeof Images; label: string; source: ImageSource }> = [
    { icon: Images, label: 'Photo library', source: 'library' },
    { icon: Camera, label: 'Take photo', source: 'camera' },
    { icon: ClipboardPaste, label: 'Paste from clipboard', source: 'clipboard' },
];

/**
 * Where the next composer image comes from. A choice slides the sheet away like every other exit, and only then opens
 * the picker or camera so the system UI never stacks over the sheet.
 */
export const ImageSourceSheet = ({
    onClose,
    onPick,
    theme,
}: {
    onClose: () => void;
    onPick: (source: ImageSource) => void;
    theme: MobileTheme;
}) => {
    const picked = useRef<ImageSource | null>(null);
    return (
        <BottomSheet
            closeLabel="Close image sources"
            onClose={() => {
                onClose();
                if (picked.current) onPick(picked.current);
            }}
            testID="image-source-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    {sources.map(({ icon, label, source }) => (
                        <SheetAction
                            icon={icon}
                            key={source}
                            label={label}
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
