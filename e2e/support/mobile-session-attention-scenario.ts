import type { BootstrapState, SessionActivityGroupId, SessionRecord } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck } from './mobile-agent-chat-helpers';
import type { MobileSemanticNode } from './mobile-android';
import { mobileSemantics, tapMobileCheck, waitForMobile } from './mobile-android';
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
        if (!fixture.allowedSessionId) throw new Error('Attention fixture Session is unavailable');
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
        const send = (sessionId: string, command: AttentionCommand) =>
            pageRequest(page, 'terminal.input', {
                terminalId: bound.terminals.find((terminal) => terminal.sessionId === sessionId)!
                    .id,
                data: `${command}\r`,
            });
        const session = (state: BootstrapState, id: string): SessionRecord | undefined =>
            state.sessions.find((candidate) => candidate.id === id);
        const readState = () => pageRequest<BootstrapState>(page, 'app.bootstrap');
        /**
         * A freshly launched fixture Agent may not read its Terminal yet, so a command is resent until the Desktop
         * records the expected state.
         */
        const sendUntil = async (
            sessionId: string,
            command: AttentionCommand,
            isReached: (record: SessionRecord | undefined) => boolean,
            label: string,
        ) => {
            for (let attempt = 0; attempt < 4; attempt += 1) {
                // eslint-disable-next-line no-await-in-loop -- each attempt waits for the previous one to settle.
                await send(sessionId, command);
                try {
                    // eslint-disable-next-line no-await-in-loop -- see above.
                    await waitForMobile(
                        readState,
                        (state) => isReached(session(state, sessionId)),
                        10_000,
                    );
                    return;
                } catch {
                    // Resend: the Agent had not taken the command yet.
                }
            }
            throw new Error(`${label} was never reached`);
        };
        await sendUntil(
            question,
            'fixture:question',
            (record) => record?.lastAttentionKind === 'waiting' && record.hasPendingAttention,
            'The question Session waiting on the user',
        );
        await sendUntil(
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
        await sendUntil(
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
