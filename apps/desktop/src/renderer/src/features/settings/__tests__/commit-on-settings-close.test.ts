import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDialogStore } from '../../../stores/dialogs';
import { subscribeSettingsClose } from '../hooks/use-commit-on-settings-close';

describe('subscribeSettingsClose', () => {
    afterEach(() => useDialogStore.setState({ settingsPageOpen: false }));

    it('fires once on close, not on open or unrelated store changes', () => {
        const onClose = vi.fn();
        const unsubscribe = subscribeSettingsClose(onClose);
        useDialogStore.setState({ settingsPageOpen: true });
        expect(onClose).not.toHaveBeenCalled();
        useDialogStore.setState({ settingsPageOpen: true });
        expect(onClose).not.toHaveBeenCalled();
        useDialogStore.setState({ settingsPageOpen: false });
        expect(onClose).toHaveBeenCalledTimes(1);
        useDialogStore.setState({ settingsPageOpen: false });
        expect(onClose).toHaveBeenCalledTimes(1);
        unsubscribe();
        useDialogStore.setState({ settingsPageOpen: true });
        useDialogStore.setState({ settingsPageOpen: false });
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
