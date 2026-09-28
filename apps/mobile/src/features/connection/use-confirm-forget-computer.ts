import { useCallback } from 'react';
import { Alert } from 'react-native';

import { useMobileClient } from './mobile-client-provider';

/**
 * Asks before removing this phone's pairing with a computer; forgetting redirects to pairing on success. Shared by the
 * Session list menu and Settings so both entry points confirm with the same words.
 */
export const useConfirmForgetComputer = (hostDisplayName: string): (() => void) => {
    const { forgetDevice } = useMobileClient();
    return useCallback(() => {
        Alert.alert(
            'Forget this computer?',
            `This phone stops connecting to ${hostDisplayName}. Pair again from Desktop to reconnect.`,
            [
                { style: 'cancel', text: 'Cancel' },
                {
                    onPress: () => {
                        // eslint-disable-next-line no-void -- Forgetting redirects to pairing on success.
                        void forgetDevice();
                    },
                    style: 'destructive',
                    text: 'Forget',
                },
            ],
        );
    }, [forgetDevice, hostDisplayName]);
};
