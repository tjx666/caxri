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

const waitForRowGroup = (serial: string, sessionId: string, group: SessionActivityGroupId) =>
    waitForMobile(
        () => mobileSemantics(serial),
        (nodes) => rowGroup(nodes, sessionId) === group,
        30_000,
    );

/**
 * `MOB-SESSION-ATTENTION-DONE-01`: the Session list groups Sessions into Needs attention, Working, and Idle. A Session
 * whose turn ended stays in Needs attention after the user opens and reads it, and leaves only through the detail
 * menu's Mark as Done, which moves it to the top of Idle.
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
        await send(question, 'fixture:question');
        await send(working, 'fixture:start');
        const session = (state: BootstrapState, id: string): SessionRecord | undefined =>
            state.sessions.find((candidate) => candidate.id === id);
        await waitForMobile(
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) =>
                session(state, question)?.hasPendingAttention === true &&
                session(state, working)?.agentActivityState === 'running' &&
                session(state, finished)?.hasPendingAttention === true,
            60_000,
        );
        await waitForRowGroup(serial, question, 'attention');
        await waitForRowGroup(serial, finished, 'attention');
        await waitForRowGroup(serial, working, 'working');
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
            () => pageRequest<BootstrapState>(page, 'app.bootstrap'),
            (state) => session(state, finished)?.hasPendingAttention === false,
        );
        await tapMobileCheck(serial, 'session-detail-back');
        await waitForRowGroup(serial, finished, 'idle');
        await waitForRowGroup(serial, question, 'attention');
        await capture(environment, 'marked-done-in-idle', artifacts);
        await finish(environment, artifacts, {
            afterMarkDone: 'idle',
            afterRead: 'attention',
            groups: 'attention-working-idle',
            status: 'passed',
        });
    } finally {
        await fixture.stop();
    }
}
