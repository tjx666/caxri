import { describe, expect, it } from 'vitest';

import {
    createRevisionConvergence,
    MAX_HELD_REVISION_PATCHES,
    shouldAdoptRead,
} from '../agent-chat-revision-convergence.js';

interface Snapshot {
    revision: number;
    text: string;
}
interface Patch {
    baseRevision: number;
    revision: number;
    delta: string;
}

const snap = (revision: number, text = ''): Snapshot => ({ revision, text });
const patch = (baseRevision: number, delta = String(baseRevision + 1)): Patch => ({
    baseRevision,
    revision: baseRevision + 1,
    delta,
});

const make = (maxHeld?: number) =>
    createRevisionConvergence<Patch, Snapshot>({
        apply: (snapshot, next) =>
            next.baseRevision === snapshot.revision
                ? { revision: next.revision, text: snapshot.text + next.delta }
                : undefined,
        maxHeld,
    });

describe('revision convergence core', () => {
    it('does nothing for a patch when there is no read and no projection (initial read)', () => {
        const core = make();
        expect(core.receivePatch(undefined, patch(0), false)).toEqual({ reread: false });
        expect(core.hasHeld()).toBe(false);
    });

    it('settles an initial read with nothing to replay', () => {
        const core = make();
        core.beginRead();
        expect(core.settleRead(snap(3))).toEqual({ reread: false });
    });

    it('applies a continuous patch directly', () => {
        const core = make();
        expect(core.receivePatch(snap(1, 'a'), patch(1, 'b'), false)).toEqual({
            publish: snap(2, 'ab'),
            reread: false,
        });
    });

    it('ignores a stale patch the projection already includes', () => {
        const core = make();
        expect(core.receivePatch(snap(5), patch(2), false)).toEqual({ reread: false });
    });

    it('asks for a fresh read on a gap without publishing', () => {
        const core = make();
        expect(core.receivePatch(snap(1), patch(4), false)).toEqual({ reread: true });
    });

    it('holds a patch that arrives during a read and replays it on the result', () => {
        const core = make();
        core.beginRead();
        expect(core.receivePatch(snap(1), patch(3, 'c'), true)).toEqual({ reread: false });
        expect(core.hasHeld()).toBe(true);
        expect(core.settleRead(snap(3, 'ab'))).toEqual({
            publish: snap(4, 'abc'),
            reread: false,
        });
        expect(core.hasHeld()).toBe(false);
    });

    it('skips held patches the read already contains', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1), true);
        core.receivePatch(undefined, patch(2), true);
        expect(core.settleRead(snap(3))).toEqual({ reread: false });
    });

    it('replays a held chain and keeps the progress made before a gap', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1, 'b'), true);
        core.receivePatch(undefined, patch(2, 'c'), true);
        core.receivePatch(undefined, patch(9, 'z'), true);
        expect(core.settleRead(snap(1, 'a'))).toEqual({
            publish: snap(3, 'abc'),
            reread: true,
        });
    });

    it('requires a read when held patches do not continue the result', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(5), true);
        expect(core.settleRead(snap(1))).toEqual({ reread: true });
    });

    it('bounds held patches and re-reads after a 200-patch overflow', () => {
        const core = make();
        expect(MAX_HELD_REVISION_PATCHES).toBe(200);
        core.beginRead();
        for (let revision = 0; revision < 5000; revision += 1) {
            expect(core.receivePatch(undefined, patch(revision), true)).toEqual({
                reread: false,
            });
        }
        // Memory stays bounded: the overflowed state keeps no patches, only the marker.
        expect(core.hasHeld()).toBe(true);
        expect(core.settleRead(snap(5000))).toEqual({ reread: true });
        expect(core.hasHeld()).toBe(false);
    });

    it('keeps exactly the limit before overflowing', () => {
        const core = make(3);
        core.beginRead();
        for (let revision = 1; revision <= 3; revision += 1) {
            core.receivePatch(undefined, patch(revision - 1, 'x'), true);
        }
        expect(core.settleRead(snap(0))).toEqual({ publish: snap(3, 'xxx'), reread: false });
        core.beginRead();
        for (let revision = 0; revision < 4; revision += 1) {
            core.receivePatch(undefined, patch(revision), true);
        }
        expect(core.settleRead(snap(0))).toEqual({ reread: true });
    });

    it('discards held patches when a read fails, so a retry starts a fresh chain', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1, 'b'), true);
        core.abandonRead();
        expect(core.hasHeld()).toBe(false);
        core.beginRead();
        expect(core.settleRead(snap(1, 'a'))).toEqual({ reread: false });
    });

    it('clears the overflow marker when a read is abandoned', () => {
        const core = make(1);
        core.beginRead();
        core.receivePatch(undefined, patch(0), true);
        core.receivePatch(undefined, patch(1), true);
        core.abandonRead();
        core.beginRead();
        expect(core.settleRead(snap(9))).toEqual({ reread: false });
    });

    it('drops patches held for an earlier read when a new read begins', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1, 'b'), true);
        core.beginRead();
        expect(core.settleRead(snap(1, 'a'))).toEqual({ reread: false });
    });

    it('treats an untrusted patch as a broken chain and forgets held patches', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1), true);
        expect(core.receiveUntrustedPatch()).toEqual({ reread: true });
        expect(core.hasHeld()).toBe(false);
    });

    it('requires a fresh read on reconnect or resync and forgets held patches', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1), true);
        expect(core.reset()).toEqual({ reread: true });
        expect(core.hasHeld()).toBe(false);
    });

    it('decides nothing after dispose and releases held patches', () => {
        const core = make();
        core.beginRead();
        core.receivePatch(undefined, patch(1), true);
        core.dispose();
        expect(core.hasHeld()).toBe(false);
        expect(core.settleRead(snap(1))).toEqual({ reread: false });
        expect(core.receivePatch(snap(1), patch(1), false)).toEqual({ reread: false });
        expect(core.receivePatch(snap(1), patch(1), true)).toEqual({ reread: false });
        expect(core.receiveUntrustedPatch()).toEqual({ reread: false });
        expect(core.reset()).toEqual({ reread: false });
        expect(core.hasHeld()).toBe(false);
    });

    it('does not move a projection backwards with a late read', () => {
        expect(shouldAdoptRead(undefined, snap(1))).toBe(true);
        expect(shouldAdoptRead(snap(2), snap(2))).toBe(true);
        expect(shouldAdoptRead(snap(3), snap(2))).toBe(false);
    });
});
