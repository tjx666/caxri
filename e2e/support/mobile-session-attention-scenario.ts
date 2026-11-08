import type { BootstrapState, SessionActivityGroupId, SessionRecord } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import {
    adbShell,
    mobileSemantics,
    tapMobileCheck,
    tapMobileCheckByBounds,
    waitForMobile,
} from './mobile-android';
import type { AttentionCommand } from './mobile-attention-fixture';

const GROUPS: readonly SessionActivityGroupId[] = ['attention', 'working', 'idle'];

/**
 * The status group a Session row sits under: the last group heading laid out above it.
 */
function rowGroup(
    nodes: MobileSemanticNode[],
    sessionId: string,
): SessionActivityGroupId | undefined {
    const row = checkBounds(nodes, `session-row-${sessionId}`);
    if (!row) return undefined;
    let found: { group: SessionActivityGroupId; top: number } | undefined;
    for (const group of GROUPS) {
        const heading = checkBounds(nodes, `session-group-${group}`);
        if (heading && heading.top <= row.top && (!found || heading.top > found.top))
            found = { group, top: heading.top };
    }
    return found?.group;
}

/**
 * Whether `upper`'s row is laid out above `lower`'s.
 */
function isAbove(nodes: MobileSemanticNode[], upper: string, lower: string): boolean {
    const top = checkBounds(nodes, `session-row-${upper}`)?.top;
    const bottom = checkBounds(nodes, `session-row-${lower}`)?.top;
    return top !== undefined && bottom !== undefined && top < bottom;
}

async function waitForRowGroup(
    serial: string,
    sessionId: string,
    group: SessionActivityGroupId,
): Promise<void> {
    try {
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => rowGroup(nodes, sessionId) === group,
            30_000,
        );
    } catch {
        throw new Error(`A Session row never showed under the ${group} heading`);
    }
}

/**
 * `MOB-SESSION-ATTENTION-DONE-01`: the Session list groups Sessions into Needs attention, Working, and Idle. A Session
 * whose turn ended stays in Needs attention after the user opens and reads it, and leaves only through the detail
 * menu's Mark as Done, which moves it to the top of Idle. A question ranks above a finished result, and a new turn
 * takes a Session out of Needs attention into Working.
 */
export async function executeMobileSessionAttentionScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'attention', serial });
    try {
        const { page } = fixture.running;
        const { attention } = fixture;
        if (!attention || !fixture.allowedSessionId)
            throw new Error('Attention fixture Session is unavailable');
        await fixture.pair();
        /**
         * Extra Sessions join the paired Project; another Project would not be granted to the phone.
         */
        const createAllowedSession = async () =>
            (
                await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                    projectId: fixture.allowedProjectId,
                    defaultAgent: 'claude',
                })
            ).session.id;
        const [question, working, finished] = [
            fixture.allowedSessionId,
            await createAllowedSession(),
            await createAllowedSession(),
        ];
        // A Shell Session has no Agent turn, so it sits in Idle; the Session marked done must land above it.
        const shell = (
            await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                projectId: fixture.allowedProjectId,
                defaultAgent: 'shell',
            })
        ).session.id;
        const bound = await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) =>
                [question, working, finished].every((id) =>
                    state.terminals.some(({ sessionId }) => sessionId === id),
                ),
        );
        const session = (state: BootstrapState, id: string): SessionRecord | undefined =>
            state.sessions.find((candidate) => candidate.id === id);
        const readState = () => pageRequest<BootstrapState>(page, 'app.bootstrap');
        /**
         * Sends the command once its fixture Agent is ready, then waits for the Desktop to record the expected state.
         */
        const sendAndWait = async (
            sessionId: string,
            command: AttentionCommand,
            isReached: (record: SessionRecord | undefined) => boolean,
            label: string,
        ) => {
            await attention.sendTo(
                bound.terminals.find((terminal) => terminal.sessionId === sessionId)!.id,
                command,
            );
            try {
                await waitForMobile(readState, (state) => isReached(session(state, sessionId)));
            } catch {
                throw new Error(`${label} was never reached`);
            }
        };
        await sendAndWait(
            question,
            'fixture:question',
            (record) => record?.lastAttentionKind === 'waiting' && record.hasPendingAttention,
            'The question Session waiting on the user',
        );
        await sendAndWait(
            working,
            'fixture:start',
            (record) => record?.agentActivityState === 'running',
            'The working Session running',
        );
        try {
            await waitForMobile(
                readState,
                (state) => session(state, finished)?.hasPendingAttention === true,
                30_000,
            );
        } catch {
            throw new Error('The finished Session never held Pending Attention');
        }
        await waitForRowGroup(serial, question, 'attention');
        await waitForRowGroup(serial, finished, 'attention');
        await waitForRowGroup(serial, working, 'working');
        await waitForRowGroup(serial, shell, 'idle');
        // A question outranks a finished result inside Needs attention.
        if (!isAbove(await mobileSemantics(serial), question, finished))
            throw new Error('The question Session is not above the finished one');
        await capture(environment, 'three-groups', artifacts);

        // Reading a finished Session does not resolve it.
        await tapMobileCheck(serial, `session-row-${finished}`);
        await waitForCheck(serial, 'session-detail-back');
        await capture(environment, 'opened', artifacts);
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForRowGroup(serial, finished, 'attention');
        await capture(environment, 'read-stays-in-attention', artifacts);

        await tapMobileCheck(serial, `session-row-${finished}`);
        await waitForCheck(serial, 'session-detail-menu');
        await tapMobileCheck(serial, 'session-detail-menu');
        await waitForCheck(serial, 'session-mark-done');
        await capture(environment, 'menu-mark-done', artifacts);
        await tapMobileCheck(serial, 'session-mark-done');
        await waitForMobile(
            readState,
            (state) => session(state, finished)?.hasPendingAttention === false,
        );
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForRowGroup(serial, finished, 'idle');
        await waitForRowGroup(serial, question, 'attention');
        if (!isAbove(await mobileSemantics(serial), finished, shell))
            throw new Error('The Session marked done is not at the top of Idle');
        await capture(environment, 'marked-done-in-idle', artifacts);

        // A new turn resolves the question's attention too: the Session leaves Needs attention for Working.
        await sendAndWait(
            question,
            'fixture:start',
            (record) => record?.agentActivityState === 'running',
            'The question Session starting a new turn',
        );
        await waitForRowGroup(serial, question, 'working');
        await capture(environment, 'new-turn-leaves-attention', artifacts);
        await finish(environment, artifacts, {
            afterMarkDone: 'idle',
            afterNewTurn: 'working',
            afterRead: 'attention',
            groups: 'attention-working-idle',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}

/**
 * Drags across a Session row's middle between two fractions of its width; the start stays clear of the screen edges,
 * which belong to the system Back gesture.
 */
async function swipeRow(
    serial: string,
    sessionId: string,
    from: number,
    to: number,
): Promise<void> {
    const row = checkBounds(await mobileSemantics(serial), `session-row-${sessionId}`);
    if (!row) throw new Error('The Session row is not laid out');
    const width = row.right - row.left;
    const y = String(Math.floor((row.top + row.bottom) / 2));
    await adbShell(serial, [
        'input',
        'swipe',
        String(Math.floor(row.left + width * from)),
        y,
        String(Math.floor(row.left + width * to)),
        y,
        '300',
    ]);
}

/**
 * The left swipe that reveals a row's actions.
 */
const swipeRowLeft = (serial: string, sessionId: string) => swipeRow(serial, sessionId, 0.9, 0.4);

/**
 * A right swipe across a closed row, which belongs to the Project pager.
 */
const swipeRowRight = (serial: string, sessionId: string) =>
    swipeRow(serial, sessionId, 0.15, 0.85);

/**
 * `MOB-SESSION-ROW-MARK-DONE-01`: swiping a Needs attention row left reveals Mark as Done and Archive, the phone's
 * counterpart of the check on a Desktop Activity row. Done resolves the Session without opening it, so the row moves to
 * the top of Idle; a Session without Pending Attention reveals only Archive, which archives it from the list.
 */
export async function executeMobileSessionRowMarkDoneScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const fixture = await createMobileAcceptanceFixture({ mode: 'attention', serial });
    try {
        const { page } = fixture.running;
        if (!fixture.allowedSessionId) throw new Error('Attention fixture Session is unavailable');
        await fixture.pair();
        const finished = (
            await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                projectId: fixture.allowedProjectId,
                defaultAgent: 'claude',
            })
        ).session.id;
        const shell = (
            await pageRequest<{ session: { id: string } }>(page, 'session.create', {
                projectId: fixture.allowedProjectId,
                defaultAgent: 'shell',
            })
        ).session.id;
        const readState = () => pageRequest<BootstrapState>(page, 'app.bootstrap');
        const pending = (state: BootstrapState): boolean | undefined =>
            state.sessions.find(({ id }) => id === finished)?.hasPendingAttention;
        try {
            await waitForMobile(readState, (state) => pending(state) === true, 30_000);
        } catch {
            throw new Error('The finished Session never held Pending Attention');
        }
        // Work on the Project's own page, so a left drag that paged would visibly leave it.
        const projectChip = `project-filter-${fixture.allowedProjectId}`;
        await tapMobileCheckByBounds(serial, projectChip);
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => nodes.find(({ checkId }) => checkId === projectChip)?.selected === true,
            15_000,
        );
        await waitForRowGroup(serial, finished, 'attention');
        await waitForRowGroup(serial, shell, 'idle');
        const markDone = `session-row-mark-done-${finished}`;
        const restingLeft = checkBounds(
            await mobileSemantics(serial),
            `session-row-${finished}`,
        )?.left;
        await capture(environment, 'attention-row-resting', artifacts);
        await swipeRowLeft(serial, finished);
        try {
            await waitForCheck(serial, `session-row-archive-${finished}`, 10_000);
            await waitForCheck(serial, markDone, 10_000);
        } catch (error) {
            await capture(environment, 'attention-row-swipe-missing', artifacts);
            throw new Error('A left swipe on a Needs attention row revealed no row actions', {
                cause: error,
            });
        }
        const swiped = await mobileSemantics(serial);
        const swipedLeft = checkBounds(swiped, `session-row-${finished}`)?.left;
        if (restingLeft === undefined || swipedLeft === undefined || swipedLeft >= restingLeft)
            throw new Error('The left swipe did not slide the row open');
        if (swiped.find(({ checkId }) => checkId === projectChip)?.selected !== true)
            throw new Error('The left swipe on a row paged away from the Project');
        await capture(environment, 'attention-row-swiped', artifacts);

        // One row is open at a time: opening the idle row closes the Needs attention row, and opening it again closes
        // the idle row.
        const shellResting = checkBounds(swiped, `session-row-${shell}`)?.left;
        await swipeRowLeft(serial, shell);
        try {
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) => {
                    const shellLeft = checkBounds(nodes, `session-row-${shell}`)?.left;
                    return (
                        checkBounds(nodes, `session-row-${finished}`)?.left === restingLeft &&
                        shellResting !== undefined &&
                        shellLeft !== undefined &&
                        shellLeft < shellResting
                    );
                },
                10_000,
            );
        } catch (error) {
            throw new Error('Opening a second row did not close the first', { cause: error });
        }
        await capture(environment, 'second-row-opened', artifacts);
        await swipeRowLeft(serial, finished);
        try {
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) => checkBounds(nodes, `session-row-${shell}`)?.left === shellResting,
                10_000,
            );
        } catch (error) {
            throw new Error('Reopening the first row did not close the second', { cause: error });
        }
        await capture(environment, 'first-row-reopened', artifacts);

        await tapMobileCheckByBounds(serial, markDone);
        try {
            await waitForMobile(readState, (state) => pending(state) === false, 30_000);
        } catch {
            throw new Error('Mark as Done never resolved Pending Attention');
        }
        await waitForRowGroup(serial, finished, 'idle');
        const after = await mobileSemantics(serial);
        if (checkBounds(after, markDone))
            throw new Error('The resolved row still offers Mark as Done');
        if (checkBounds(after, 'session-detail-back'))
            throw new Error('Mark as Done opened the Session');
        if (!isAbove(after, finished, shell))
            throw new Error('The Session marked done is not at the top of Idle');
        await capture(environment, 'marked-done-in-idle', artifacts);

        await swipeRowLeft(serial, shell);
        const archive = `session-row-archive-${shell}`;
        await waitForCheck(serial, archive);
        if (checkBounds(await mobileSemantics(serial), `session-row-mark-done-${shell}`))
            throw new Error('An idle Session row offers Mark as Done');
        await capture(environment, 'idle-row-swiped', artifacts);
        await tapMobileCheckByBounds(serial, archive);
        try {
            await waitForMobile(
                readState,
                (state) => state.sessions.find(({ id }) => id === shell)?.archivedAt !== undefined,
                30_000,
            );
        } catch {
            throw new Error('The swipe Archive never archived the Session');
        }
        await waitForMobile(
            () => mobileSemantics(serial),
            (nodes) => !checkBounds(nodes, `session-row-${shell}`),
            30_000,
        );
        // The swipe archives with the same Undo toast as the long-press sheet, which lasts eight seconds.
        await waitForCheck(serial, 'toast-action', 5000);
        await capture(environment, 'idle-row-archived-with-undo', artifacts);

        // A right drag on a closed row is not the row's own, so the pager still takes it back to All.
        await swipeRowRight(serial, finished);
        try {
            await waitForMobile(
                () => mobileSemantics(serial),
                (nodes) =>
                    nodes.find(({ checkId }) => checkId === 'project-filter-all')?.selected ===
                    true,
                15_000,
            );
        } catch {
            throw new Error('A right swipe on a row no longer pages to the previous Project');
        }
        await capture(environment, 'right-swipe-paged-to-all', artifacts);
        // Records why the other Needs attention row may lose its unread mark after the archive, without asserting it.
        const settledState = await readState();
        const remaining = settledState.sessions.find(({ id }) => id === fixture.allowedSessionId);
        await finish(environment, artifacts, {
            afterArchive: 'removed',
            remainingAttention: remaining?.hasPendingAttention ? 'pending' : 'resolved',
            remainingDesktopSelected:
                settledState.selectedSessionId === fixture.allowedSessionId ? 'yes' : 'no',
            remainingUnread: remaining?.hasUnread ? 'unread' : 'read',
            afterMarkDone: 'idle',
            idleRowDone: 'hidden',
            leftSwipePaged: 'no',
            openedDetail: 'no',
            rightSwipePaged: 'yes',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
