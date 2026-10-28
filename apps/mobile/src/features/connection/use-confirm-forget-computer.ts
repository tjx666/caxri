import { useCallback, useState } from 'react';

import { useMobileClient } from './mobile-client-provider';

/**
 * Drives the Forget this computer confirmation, which only Settings offers. The caller mounts a `ConfirmSheet` while
 * `isOpen`, titled and worded from the `connection.forget.*` strings; confirming removes this phone's pairing and
 * redirects to pairing on success.
 */
export const useConfirmForgetComputer = (): {
    close: () => void;
    confirm: () => void;
    isOpen: boolean;
    open: () => void;
} => {
    const { forgetDevice } = useMobileClient();
    const [isOpen, setOpen] = useState(false);
    const open = useCallback(() => setOpen(true), []);
    const close = useCallback(() => setOpen(false), []);
    const confirm = useCallback(() => {
        void forgetDevice();
    }, [forgetDevice]);
    return { close, confirm, isOpen, open };
};
