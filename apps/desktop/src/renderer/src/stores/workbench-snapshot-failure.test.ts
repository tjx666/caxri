import { CaxriError } from '@caxri/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import { dismissToast, getToasts } from './toasts';
import { reportSnapshotFailure } from './workbench-snapshot-failure';

afterEach(() => {
    dismissToast();
});

describe('reportSnapshotFailure', () => {
    it('names a failed first snapshot as a load', () => {
        reportSnapshotFailure(new Error('The Server stopped.'), false);
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unable to load Projects and Sessions from the Server. The Server stopped.',
            }),
        ]);
    });

    it('names a failed later snapshot as a refresh of what is already shown', () => {
        reportSnapshotFailure(new Error('The Server stopped.'), true);
        expect(getToasts()).toEqual([
            expect.objectContaining({
                type: 'error',
                title: 'Unable to refresh Projects and Sessions from the Server. The Server stopped.',
            }),
        ]);
    });

    it('stays silent for a request cancelled by quit', () => {
        reportSnapshotFailure(new CaxriError('CANCELLED', 'Request cancelled'), true);
        expect(getToasts()).toEqual([]);
    });
});
