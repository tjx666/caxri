import { beforeEach, describe, expect, it } from 'vitest';

import { useDialogStore } from '../../stores/dialogs';
import { openEnvironmentPage } from './environment-monitor-page-request';

describe('openEnvironmentPage', () => {
    beforeEach(() => {
        useDialogStore.setState({
            environmentPageRequestId: 0,
            sessionlessEnvironmentDismissedId: 0,
        });
    });

    it('requests the Environment page through its own request revision', () => {
        openEnvironmentPage();

        expect(useDialogStore.getState().environmentPageRequestId).toBe(1);
    });
});
