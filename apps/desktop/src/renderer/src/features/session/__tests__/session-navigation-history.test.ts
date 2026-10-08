import type { BootstrapState } from '@caxri/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkbenchStore } from '../../../stores/workbench';
import type { SessionNavigationHistorySnapshot } from '../session-navigation-history';
import {
    EMPTY_SESSION_HISTORY,
    pruneSessionHistory,
    recordSessionVisit,
    sessionHistorySnapshot,
    sessionHistoryTarget,
    useSessionNavigationHistoryStore,
} from '../session-navigation-history';

function history() {
    return useSessionNavigationHistoryStore.getState();
}

/**
 * Every Session the Workbench displayed, in order, as the controls see it.
 */
function visible(): SessionNavigationHistorySnapshot {
    const { back, current, forward } = history();
    return { back, current, forward };
}

function snapshot(
    overrides: Partial<SessionNavigationHistorySnapshot> = {},
): SessionNavigationHistorySnapshot {
    return { back: [], current: undefined, forward: [], ...overrides };
}

/**
 * Drives the store the way the Workbench does: each id is a Session the Server reported as selected.
 */
function visit(...sessionIds: string[]): void {
    for (const sessionId of sessionIds) history().recordWorkbenchSelection(sessionId);
}

/**
 * The Session the Workbench itself reports as selected, which is what a settling selection reconciles against.
 */
function selectWorkbenchSession(sessionId: string): void {
    useWorkbenchStore.setState({
        bootstrap: {
            selectedSessionId: sessionId,
            sessions: [{ id: sessionId }],
        } as unknown as BootstrapState,
    });
}

describe('Session history timeline', () => {
    it('stacks ordinary visits and drops the forward entries', () => {
        let timeline = recordSessionVisit(EMPTY_SESSION_HISTORY, 'session-a');
        timeline = recordSessionVisit(timeline, 'session-b');
        expect(sessionHistorySnapshot(timeline)).toEqual(
            snapshot({ back: ['session-a'], current: 'session-b' }),
        );

        timeline = { ...timeline, index: 0 };
        expect(sessionHistorySnapshot(timeline)).toEqual(
            snapshot({ current: 'session-a', forward: ['session-b'] }),
        );

        timeline = recordSessionVisit(timeline, 'session-c');
        expect(sessionHistorySnapshot(timeline)).toEqual(
            snapshot({ back: ['session-a'], current: 'session-c' }),
        );
    });

    it('ignores a re-observed current Session', () => {
        const timeline = recordSessionVisit(EMPTY_SESSION_HISTORY, 'session-a');
        expect(recordSessionVisit(timeline, 'session-a')).toBe(timeline);
    });

    /**
     * Losing the selection is not the same as never having had one: the Session that was on screen has to stay
     * reachable, or deleting a Session would strand the user with a dead `Go Back`.
     */
    it('keeps the last displayed Session as the next back target when nothing is selected', () => {
        let timeline = recordSessionVisit(EMPTY_SESSION_HISTORY, 'session-a');
        timeline = recordSessionVisit(timeline, undefined);
        expect(sessionHistorySnapshot(timeline)).toEqual(snapshot({ back: ['session-a'] }));
        expect(sessionHistoryTarget(timeline, 'back')).toBe(0);

        // Re-selecting it restores the cursor instead of recording the same Session twice.
        expect(recordSessionVisit(timeline, 'session-a').entries).toEqual(['session-a']);
        expect(sessionHistorySnapshot(recordSessionVisit(timeline, 'session-a'))).toEqual(
            snapshot({ current: 'session-a' }),
        );
    });

    it('reports the next position in each direction', () => {
        const timeline = { entries: ['a', 'b', 'c'], hasCurrent: true, index: 1 };
        expect(sessionHistoryTarget(timeline, 'back')).toBe(0);
        expect(sessionHistoryTarget(timeline, 'forward')).toBe(2);
        expect(sessionHistoryTarget({ ...timeline, index: 0 }, 'back')).toBeUndefined();
        expect(sessionHistoryTarget({ ...timeline, index: 2 }, 'forward')).toBeUndefined();
    });

    it('caps the remembered visits', () => {
        let timeline = EMPTY_SESSION_HISTORY;
        for (let index = 0; index <= 60; index++) {
            timeline = recordSessionVisit(timeline, `session-${index}`);
        }
        expect(timeline.entries).toHaveLength(50);
        expect(timeline.entries[0]).toBe('session-11');
        expect(timeline.entries[timeline.index]).toBe('session-60');
    });

    it('drops archived Sessions and reports where the survivors moved', () => {
        const timeline = { entries: ['a', 'gone', 'c'], hasCurrent: true, index: 2 };
        const pruned = pruneSessionHistory(timeline, ['a', 'c']);
        expect(pruned.positions).toEqual([0, -1, 1]);
        expect(pruned.timeline).toEqual({ entries: ['a', 'c'], hasCurrent: true, index: 1 });
        expect(pruneSessionHistory(timeline, ['a', 'gone', 'c']).timeline).toBe(timeline);
    });

    /**
     * `A → B → A` minus B leaves `A` next to itself. Navigating to that repeat would re-select the Session already on
     * screen, so the control would stay enabled forever and every press would do nothing.
     */
    it('collapses a repeat that pruning left behind', () => {
        const pruned = pruneSessionHistory(
            { entries: ['a', 'b', 'a'], hasCurrent: true, index: 2 },
            ['a'],
        );
        expect(pruned.timeline).toEqual({ entries: ['a'], hasCurrent: true, index: 0 });
        expect(pruned.positions).toEqual([0, -1, 0]);
    });

    it('falls back to the newest surviving entry when the current Session is archived', () => {
        const pruned = pruneSessionHistory(
            { entries: ['a', 'b', 'c'], hasCurrent: true, index: 2 },
            ['a', 'b'],
        );
        expect(pruned.timeline).toEqual({ entries: ['a', 'b'], hasCurrent: false, index: 1 });
        expect(sessionHistorySnapshot(pruned.timeline)).toEqual(snapshot({ back: ['a', 'b'] }));
    });
});

describe('Session navigation requests', () => {
    beforeEach(() => {
        history().reset();
        useWorkbenchStore.setState({ bootstrap: undefined });
    });

    it('records every observed selection and offers the previous Session', () => {
        visit('session-a', 'session-b');
        expect(visible()).toEqual(snapshot({ back: ['session-a'], current: 'session-b' }));
        expect(history().canGoBack).toBe(true);
        expect(history().canGoForward).toBe(false);
    });

    /**
     * The Server confirms a Session switch asynchronously, so a second navigation routinely lands before the first is
     * confirmed. Both compute from the state the user can already see, which is why the requests are projected on top
     * of the confirmed timeline.
     */
    it('lets a second navigation build on the first before the Runtime confirms it', () => {
        visit('session-a', 'session-b', 'session-c');
        const first = history().request('back');
        const second = history().request('back');
        expect([first?.target, second?.target]).toEqual(['session-b', 'session-a']);
        const navigated = snapshot({ current: 'session-a', forward: ['session-c', 'session-b'] });
        expect(visible()).toEqual(navigated);

        history().confirm(first!);
        history().confirm(second!);
        expect(visible()).toEqual(navigated);
        expect(history().pending).toEqual([]);
    });

    /**
     * `refreshWorkbench` folds a burst of refreshes into a single snapshot, so the Workbench may never report the
     * intermediate Session at all. Confirmations therefore carry the position they claimed instead of being matched
     * against what the snapshot happens to show.
     */
    it('lands correctly when the Workbench snapshot skips the intermediate Session', () => {
        visit('session-a', 'session-b', 'session-c');
        const first = history().request('back');
        const second = history().request('back');

        // The folded snapshot only ever reports the final Session, and it arrives before either confirmation.
        history().recordWorkbenchSelection('session-a');
        history().confirm(first!);
        history().confirm(second!);
        expect(visible()).toEqual(
            snapshot({ current: 'session-a', forward: ['session-c', 'session-b'] }),
        );
    });

    /**
     * `A → B → A → C`: two of the three Backs name `session-a`, so a request has to be identified by more than its
     * target.
     */
    it('walks a timeline that visits the same Session twice', () => {
        visit('session-a', 'session-b', 'session-a', 'session-c');
        const requests = [
            history().request('back'),
            history().request('back'),
            history().request('back'),
        ];
        expect(requests.map((request) => request?.target)).toEqual([
            'session-a',
            'session-b',
            'session-a',
        ]);
        for (const request of requests) history().confirm(request!);
        expect(visible()).toEqual(
            snapshot({ current: 'session-a', forward: ['session-c', 'session-a', 'session-b'] }),
        );
    });

    /**
     * The Server's selection queue keeps running after a failure, so a request queued behind a refused one still lands.
     * Dropping it here would leave the user unable to go Forward to a Session that is on screen.
     */
    it('keeps a queued navigation when the one before it is refused', () => {
        visit('session-a', 'session-b', 'session-c');
        const refused = history().request('back');
        const landed = history().request('back');

        history().abandon(refused!);
        expect(history().pending).toHaveLength(1);
        history().confirm(landed!);
        expect(visible()).toEqual(
            snapshot({ current: 'session-a', forward: ['session-c', 'session-b'] }),
        );
    });

    /**
     * An old refusal must not cut a newer request that happens to name the same Session.
     */
    it('refuses only the request that failed, not a later one with the same target', () => {
        visit('session-a', 'session-b', 'session-c');
        const stale = history().request('back');

        // A Session created and selected from the PrimarySidebar overtakes the navigation and clears the queue.
        history().beginSelection();
        history().settleSelection('session-d', true);
        const toC = history().request('back');
        const toB = history().request('back');
        expect([toC?.target, toB?.target]).toEqual(['session-c', 'session-b']);

        history().abandon(stale!);
        expect(history().pending).toHaveLength(2);
        history().confirm(toC!);
        history().confirm(toB!);
        expect(visible().current).toBe('session-b');
    });

    /**
     * Archiving the Session a queued navigation targets must not take the requests behind it down as well: their
     * selections are already on the wire and will still land.
     */
    it('keeps a queued navigation whose target survives an archive', () => {
        visit('session-a', 'session-b', 'session-c');
        const toB = history().request('back');
        const toA = history().request('back');

        history().prune(['session-a', 'session-c']);
        expect(history().pending).toHaveLength(1);
        history().abandon(toB!);
        history().confirm(toA!);
        expect(visible()).toEqual(snapshot({ current: 'session-a', forward: ['session-c'] }));
    });

    /**
     * A Session the user genuinely reached must survive even when it arrives out of order: the confirmed timeline is
     * what the Workbench really showed, so the late confirmation stacks on top of it rather than on the projection the
     * overtaking selection already invalidated.
     */
    it('records a navigation an ordinary selection overtook as a visit', () => {
        visit('session-a', 'session-b');
        const toA = history().request('back');

        history().beginSelection();
        history().settleSelection('session-c', true);
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b'], current: 'session-c' }),
        );

        history().confirm(toA!);
        expect(visible()).toEqual(
            snapshot({ back: ['session-a', 'session-b', 'session-c'], current: 'session-a' }),
        );
    });

    it('ignores a snapshot that reports a Session a request is already heading to', () => {
        visit('session-a', 'session-b');
        const toA = history().request('back');
        const pending = visible();

        history().recordWorkbenchSelection('session-a');
        expect(visible()).toEqual(pending);
        expect(history().pending).toHaveLength(1);
        history().confirm(toA!);
        expect(visible()).toEqual(snapshot({ current: 'session-a', forward: ['session-b'] }));
    });

    /**
     * A stalled Server must not accumulate navigations it replays all at once on recovery, and the controls have to say
     * so rather than staying lit while every press does nothing.
     */
    it('stops queueing navigations a stalled Runtime never confirms', () => {
        for (let index = 0; index <= 40; index++) visit(`session-${index}`);

        const requests = Array.from({ length: 20 }, () => history().request('back'));
        expect(requests.filter(Boolean)).toHaveLength(16);
        expect(requests.at(-1)).toBeUndefined();
        expect(history().pending).toHaveLength(16);
        expect(history().canGoBack).toBe(false);
        expect(history().canGoForward).toBe(false);
    });

    /**
     * The PrimarySidebar click is dispatched after two Backs, so the Server applies `C → B → C` and the Workbench ends
     * on the Session the user clicked. Attribution is what makes that recoverable: the folded snapshot only ever
     * reports `C`, and without it the two confirmations would leave the cursor on `B` while the screen shows `C`.
     */
    it('ends where the newest selection landed when one races two navigations', () => {
        visit('session-a', 'session-b', 'session-c', 'session-d');
        const toC = history().request('back');
        const toB = history().request('back');

        history().beginSelection();
        history().recordWorkbenchSelection('session-c');
        history().confirm(toC!);
        history().confirm(toB!);
        history().settleSelection('session-c', true);

        expect(visible().current).toBe('session-c');
        expect(history().inFlight).toBe(0);
    });

    /**
     * The Server can apply a selection just before the Session is archived. Recording it afterwards would put an
     * archived Session back into a history that was already pruned, and nothing would prune it again.
     */
    it('does not write back a Session archived while its navigation was in flight', () => {
        visit('session-a', 'session-b', 'session-c');
        const toB = history().request('back');

        history().prune(['session-a', 'session-c']);
        history().confirm(toB!);
        expect(history().timeline.entries).toEqual(['session-a', 'session-c']);
        expect(visible().current).toBe('session-c');
    });

    /**
     * A settled selection rewrites the entries after the cursor, so a queued `Forward` can end up pointing at the
     * Session that replaced its target. It has to land as an ordinary visit rather than move the cursor onto a Session
     * the user never navigated to.
     */
    it('drops a queued navigation whose position was overwritten', () => {
        visit('session-a', 'session-b', 'session-c');
        const toB = history().request('back');
        history().confirm(toB!);

        history().beginSelection();
        const toC = history().request('forward');
        history().settleSelection('session-d', true);
        expect(history().pending).toEqual([]);

        history().confirm(toC!);
        expect(history().timeline.entries).toEqual([
            'session-a',
            'session-b',
            'session-d',
            'session-c',
        ]);
        expect(visible().current).toBe('session-c');
    });

    it('ignores the Workbench snapshot while a selection is still in flight', () => {
        visit('session-a', 'session-b');
        history().beginSelection();
        history().recordWorkbenchSelection('session-a');
        expect(visible().current).toBe('session-b');

        history().settleSelection('session-a', false);
        expect(history().inFlight).toBe(0);
        expect(visible().current).toBe('session-b');
    });

    /**
     * The mirror of the archived-navigation case. An ordinary click resolves through the same late window, so it can
     * also succeed after its Session was archived and pruned.
     */
    it('does not write back a Session archived while an ordinary selection was in flight', () => {
        visit('session-a', 'session-b');
        history().beginSelection();
        history().prune(['session-a', 'session-b']);

        history().settleSelection('session-c', true);
        expect(history().timeline.entries).toEqual(['session-a', 'session-b']);
        expect(visible().current).toBe('session-b');
    });

    /**
     * An ordinary selection drops the queued navigations without cancelling their IPCs, so the cap counts every
     * unsettled selection. Counting only the queue would let each click reopen it.
     */
    it('keeps the navigation cap closed while an ordinary selection clears the queue', () => {
        visit(...Array.from({ length: 32 }, (_, index) => `session-${index}`));
        let claimed = 0;
        while (history().request('back') !== undefined) claimed += 1;
        expect(claimed).toBeGreaterThan(0);
        expect(history().canGoBack).toBe(false);

        history().beginSelection();
        expect(history().pending).toEqual([]);
        expect(history().canGoBack).toBe(false);
        expect(history().request('back')).toBeUndefined();
    });

    /**
     * The Server switches Sessions on its own (an archived current Session, a Terminal moved to a new Session) and that
     * snapshot arrives while a dispatched selection is still settling, where it is ignored as that selection's own
     * echo. The Session id never changes again, so the settlement is the only chance left to record where the Workbench
     * really ended up.
     */
    it('records where the Workbench ended up when the Runtime switched during a selection', () => {
        visit('session-a');
        selectWorkbenchSession('session-a');
        history().beginSelection();
        history().recordWorkbenchSelection('session-n');
        selectWorkbenchSession('session-n');

        history().settleSelection('session-b', true);
        expect(history().timeline.entries).toEqual(['session-a', 'session-b', 'session-n']);
        expect(visible().current).toBe('session-n');
    });

    it('leaves the history alone when the Workbench is where the selection landed', () => {
        visit('session-a');
        history().beginSelection();
        selectWorkbenchSession('session-b');

        history().settleSelection('session-b', true);
        expect(history().timeline.entries).toEqual(['session-a', 'session-b']);
        expect(visible().current).toBe('session-b');
    });

    /**
     * The live Session set belongs to the Workbench that was torn down. Carrying it over would measure the next
     * Workbench's Sessions against a set they were never in, and every visit would be discarded as archived.
     */
    it('forgets the previous live Sessions on reset', () => {
        visit('session-a');
        history().prune(['session-a']);
        history().reset();

        history().beginSelection();
        history().settleSelection('session-b', true);
        expect(visible().current).toBe('session-b');
    });

    it('reports both directions as unavailable on an empty history', () => {
        expect(history().request('back')).toBeUndefined();
        expect(history().request('forward')).toBeUndefined();
        expect(visible()).toEqual(snapshot());
    });
});
