import { beforeEach, describe, expect, it } from 'vitest';

import { useDialogStore } from '../../stores/dialogs';
import { openEnvironmentPage } from './environment-monitor-page-request';

describe('openEnvironmentPage', () => {
    beforeEach(() => {
        useDialogStore.setState({
            environmentPageRequestId: 0,
            sessionlessEnvironmentDismissedId: 0,
            settingsPageOpen: false,
        });
    });

    it('requests the Environment page through its own request revision', () => {
        openEnvironmentPage();

        expect(useDialogStore.getState().environmentPageRequestId).toBe(1);
    });

    it('closes the Settings page so the Environment page is not opened behind it', () => {
        useDialogStore.setState({ settingsPageOpen: true });

        openEnvironmentPage();

        expect(useDialogStore.getState().settingsPageOpen).toBe(false);
        expect(useDialogStore.getState().environmentPageRequestId).toBe(1);
    });
});
