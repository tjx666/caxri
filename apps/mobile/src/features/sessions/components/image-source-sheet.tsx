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
 * Where the next composer image comes from. The sheet closes before the picker or camera opens so the system UI never
 * stacks over it.
 */
export const ImageSourceSheet = ({
    onClose,
    onPick,
    theme,
}: {
    onClose: () => void;
    onPick: (source: ImageSource) => void;
    theme: MobileTheme;
}) => (
    <BottomSheet
        closeLabel="Close image sources"
        onClose={onClose}
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
                            onClose();
                            onPick(source);
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
