import { beforeEach, describe, expect, it } from 'vitest';

import { useDialogStore } from '../../stores/dialogs';
import { openEnvironmentPage } from './environment-monitor-page-request';

describe('openEnvironmentPage', () => {
    beforeEach(() => {
        useDialogStore.setState({
            workbenchPageRequest: { id: 0, surface: 'settings' },
            sessionlessWorkbenchPageDismissedId: 0,
        });
    });

    it('requests the Environment page through the global Workbench channel', () => {
        openEnvironmentPage();

        expect(useDialogStore.getState().workbenchPageRequest).toEqual({
            id: 1,
            surface: 'environment',
        });
    });
});
