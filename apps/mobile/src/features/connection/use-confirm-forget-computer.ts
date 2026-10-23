import { useCallback } from 'react';
import { Alert } from 'react-native';

import { useTranslation } from '../../i18n';
import { useMobileClient } from './mobile-client-provider';

/**
 * Asks before removing this phone's pairing with a computer; forgetting redirects to pairing on success. Shared by the
 * Session list menu and Settings so both entry points confirm with the same words.
 */
export const useConfirmForgetComputer = (hostDisplayName: string): (() => void) => {
    const { forgetDevice } = useMobileClient();
    const { t } = useTranslation();
    return useCallback(() => {
        Alert.alert(
            t('connection.forget.title'),
            t('connection.forget.message', { host: hostDisplayName }),
            [
                { style: 'cancel', text: t('common.cancel') },
                {
                    onPress: () => {
                        void forgetDevice();
                    },
                    style: 'destructive',
                    text: t('connection.forget.confirm'),
                },
            ],
        );
    }, [forgetDevice, hostDisplayName, t]);
};
