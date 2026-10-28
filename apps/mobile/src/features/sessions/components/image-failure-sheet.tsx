import { RotateCw, Trash2 } from 'lucide-react-native';

import {
    BottomSheet,
    SheetAction,
    SheetCancel,
    SheetTitle,
} from '../../../components/bottom-sheet';
import { useTranslation } from '../../../i18n';
import type { MobileTheme } from '../../../theme/tokens';

/**
 * Why one image failed to upload, with Retry and Remove. It replaces the system dialog the strip used to raise, so the
 * choice looks like every other sheet and the reason sits under its title.
 */
export const ImageFailureSheet = ({
    onClose,
    onRemove,
    onRetry,
    reason,
    theme,
}: {
    onClose: () => void;
    onRemove: () => void;
    onRetry: () => void;
    reason: string;
    theme: MobileTheme;
}) => {
    const { t } = useTranslation();
    return (
        <BottomSheet
            closeLabel={t('sessions.image.closeFailure')}
            onClose={onClose}
            testID="image-failure-sheet"
            theme={theme}
        >
            {(dismiss) => (
                <>
                    <SheetTitle
                        detail={reason}
                        theme={theme}
                        title={t('sessions.image.uploadFailedTitle')}
                    />
                    <SheetAction
                        icon={RotateCw}
                        label={t('common.retry')}
                        onPress={() => {
                            onRetry();
                            dismiss();
                        }}
                        testID="image-failure-retry"
                        theme={theme}
                    />
                    <SheetAction
                        icon={Trash2}
                        label={t('sessions.image.remove')}
                        onPress={() => {
                            onRemove();
                            dismiss();
                        }}
                        testID="image-failure-remove"
                        theme={theme}
                    />
                    <SheetCancel onPress={dismiss} testID="image-failure-cancel" theme={theme} />
                </>
            )}
        </BottomSheet>
    );
};
