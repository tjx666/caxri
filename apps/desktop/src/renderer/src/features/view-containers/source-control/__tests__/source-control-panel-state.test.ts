import { CaxriError } from '@caxri/protocol';
import { describe, expect, it } from 'vitest';

import { translate } from '../../../../i18n';
import {
    isSupersededSnapshotError,
    resolveSourceControlPanelState,
} from '../source-control-panel-state';

describe('resolveSourceControlPanelState', () => {
    it('keeps no Session distinct from loading', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: false,
                hasSnapshotError: false,
                t: translate,
            }),
        ).toEqual({
            status: 'no-session',
        });
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: false,
                t: translate,
            }),
        ).toEqual({
            status: 'loading',
        });
    });

    it('distinguishes a missing repository from an unavailable Git operation', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: false,
                model: {
                    emptyKind: 'no-repository',
                    emptyMessage: 'This folder is not a Git repository.',
                },
                t: translate,
            }),
        ).toEqual({ status: 'no-repository' });
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: false,
                model: {
                    emptyKind: 'unavailable',
                    emptyMessage:
                        'Source Control is unavailable right now. The Git operation timed out.',
                },
                t: translate,
            }),
        ).toEqual({
            status: 'unavailable',
            message: 'Source Control is unavailable right now. The Git operation timed out.',
        });
    });

    it('offers recovery after a snapshot failure without provider data', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: true,
                t: translate,
            }),
        ).toEqual({
            status: 'unavailable',
            message: 'Source Control is unavailable right now.',
        });
    });

    it('does not leave cached content visible after a failed refresh', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: true,
                model: { emptyKind: 'no-repository', emptyMessage: 'Old result' },
                t: translate,
            }),
        ).toEqual({
            status: 'unavailable',
            message: 'Source Control is unavailable right now.',
        });
    });

    it('stays ready when a superseded refetch errors over a healthy snapshot', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: true,
                isSnapshotSuperseded: true,
                model: { emptyKind: undefined, emptyMessage: undefined },
                t: translate,
            }),
        ).toEqual({ status: 'ready' });
    });

    it('shows a superseded refetch as unavailable when nothing is cached', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: true,
                isSnapshotSuperseded: true,
                t: translate,
            }).status,
        ).toBe('unavailable');
    });

    it('recognizes only the wire CANCELLED a retired read answers with as superseded', () => {
        expect(isSupersededSnapshotError(new CaxriError('CANCELLED', 'superseded'))).toBe(true);
        expect(isSupersededSnapshotError(new CaxriError('GIT', 'git failed'))).toBe(false);
        expect(isSupersededSnapshotError({ code: 'GENERATION_EXPIRED' })).toBe(false);
        expect(isSupersededSnapshotError(null)).toBe(false);
    });

    it('keeps a healthy snapshot ready', () => {
        expect(
            resolveSourceControlPanelState({
                hasSession: true,
                hasSnapshotError: false,
                model: {},
                t: translate,
            }),
        ).toEqual({ status: 'ready' });
    });
});
