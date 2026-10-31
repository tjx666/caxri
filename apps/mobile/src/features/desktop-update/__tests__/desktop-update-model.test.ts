import type { MobileDesktopUpdateResult, UpdateState } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import {
    desktopUpdateConfirmDetail,
    desktopUpdateView,
    isDesktopUpdateMoving,
} from '../desktop-update-model';

const online = (state: UpdateState): MobileDesktopUpdateResult => ({ desktop: 'online', state });

const ready: UpdateState = {
    status: 'ready',
    currentVersion: '0.0.3',
    version: '0.0.4',
    fileName: 'Caxri-0.0.4-arm64.dmg',
    installMode: 'restart',
};

describe('desktop update model', () => {
    it('hides the rows for an SSH Host window and before the first read', () => {
        expect(desktopUpdateView({ desktop: 'unsupported' }, { kind: 'idle' })).toBeNull();
        expect(desktopUpdateView(undefined, { kind: 'idle' })).toBeNull();
    });

    it('shows the computer version and asks to open Caxri when it is closed', () => {
        expect(
            desktopUpdateView(online({ status: 'up-to-date', currentVersion: '0.0.3' }), {
                kind: 'idle',
            }),
        ).toEqual({ version: { canCheck: true, isFailure: false, value: '0.0.3 · Up to date' } });
        expect(desktopUpdateView({ desktop: 'offline' }, { kind: 'idle' })?.version.value).toBe(
            'Open Caxri on your computer to update it',
        );
    });

    it('does not offer a check on a development build', () => {
        expect(
            desktopUpdateView(
                online({ status: 'unavailable', currentVersion: '0.0.3', reason: 'unpackaged' }),
                { kind: 'idle' },
            ),
        ).toEqual({
            version: {
                canCheck: false,
                isFailure: false,
                value: '0.0.3 · Development build, updates off',
            },
        });
    });

    it('moves an available update through download to a confirmed restart', () => {
        expect(
            desktopUpdateView(
                online({
                    status: 'available',
                    currentVersion: '0.0.3',
                    version: '0.0.4',
                } as UpdateState),
                { kind: 'idle' },
            )?.update,
        ).toMatchObject({ action: 'download', label: 'Update computer to 0.0.4' });
        expect(
            desktopUpdateView(
                online({
                    status: 'downloading',
                    currentVersion: '0.0.3',
                    version: '0.0.4',
                    receivedBytes: 50,
                    totalBytes: 200,
                } as UpdateState),
                { kind: 'idle' },
            )?.update,
        ).toMatchObject({ action: null });
        expect(desktopUpdateView(online(ready), { kind: 'idle' })?.update).toMatchObject({
            action: 'confirm-install',
            label: 'Restart to update to 0.0.4',
        });
        expect(
            desktopUpdateView(online(ready), { kind: 'restarting', version: '0.0.4' })?.update,
        ).toMatchObject({ action: null, label: 'Updating your computer to 0.0.4…' });
    });

    it('keeps data-resetting and manual installs on the computer', () => {
        for (const state of [
            { ...ready, resetsData: true },
            { ...ready, installMode: 'manual' },
        ] as UpdateState[])
            expect(desktopUpdateView(online(state), { kind: 'idle' })?.update?.action).toBeNull();
    });

    it('explains a refused restart as a failure on the update row', () => {
        expect(
            desktopUpdateView(online(ready), {
                kind: 'blocked',
                reason: 'unsaved-editors',
                unsavedEditorCount: 2,
            })?.update,
        ).toMatchObject({
            detail: '2 files are unsaved on your computer. Save or close them there, then try again.',
            isFailure: true,
        });
    });

    it('polls only while a check or download is moving', () => {
        expect(isDesktopUpdateMoving(online({ status: 'checking', currentVersion: '0.0.3' }))).toBe(
            true,
        );
        expect(isDesktopUpdateMoving(online(ready))).toBe(false);
        expect(isDesktopUpdateMoving({ desktop: 'offline' })).toBe(false);
    });

    it('names what the restart stops and caps the working Session list', () => {
        const detail = desktopUpdateConfirmDetail(
            '0.0.4',
            { terminals: 1, chats: 2, pendingReviewComments: 3 },
            ['a', 'b', 'c', 'd', 'e', 'f', 'g'],
        );

        expect(detail.split('\n')).toEqual([
            'Caxri on your computer restarts into version 0.0.4.',
            'This stops 1 Terminal and 2 Chats.',
            'Agents still working: a, b, c, d, e, 2 more.',
            '3 unsent review comments will be lost.',
        ]);
        expect(desktopUpdateConfirmDetail('0.0.4', undefined, [])).toBe(
            'Caxri on your computer restarts into version 0.0.4.',
        );
    });
});
