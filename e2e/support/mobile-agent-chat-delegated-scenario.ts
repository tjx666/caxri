import { join } from 'node:path';

import { delegatedTaskPointer } from '@caxri/protocol';

import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { waitForCheck } from './mobile-agent-chat-helpers';
import { tapMobileCheck, waitForMobile } from './mobile-android';

const RECORDED_DELEGATION = `dispatch-${'a'.repeat(64)}`;

/**
 * Longer than the bubble's six-line clamp on a phone, so the bubble offers Show more.
 */
const DELEGATED_PROMPT = [
    'Fix the flaky login test in the synthetic fixture.',
    'Run the focused suite three times before reporting.',
    'Keep the public API unchanged.',
    'Explain the root cause in two sentences.',
    'List every file you touched.',
    'Do not update snapshots.',
    'Stop and ask if the fix needs a schema change.',
    'Reply with the final test output last.',
].join('\n');

/**
 * Saves the delegation record a real launch would have written for `RECORDED_DELEGATION`, so Server Core names the task
 * the caller wrote when the pointer arrives. A real launch needs a delegated Agent; the bubble only reads the record.
 */
async function seedDelegationRecord(
    userData: string,
    projectId: string,
    sessionId: string,
): Promise<void> {
    const { CaxriDatabase } = await import('../../apps/server/src/domains/db');
    const database = new CaxriDatabase(join(userData, 'caxri.db'));
    try {
        const now = Date.now();
        database.agentDelegations.insert({
            receipt: {
                delegationId: RECORDED_DELEGATION,
                projectId,
                sessionId,
                provider: 'codex',
                status: 'completed',
                revision: 1,
                createdAt: now,
                updatedAt: now,
            },
            principal: { kind: 'human-cli', id: 'acceptance' },
            input: { projectId, sessionId, provider: 'codex', prompt: DELEGATED_PROMPT },
            fingerprint: 'acceptance',
            promptDigest: '0'.repeat(64),
            frozenLaunch: { executable: 'codex', args: [] },
        });
    } finally {
        database.close();
    }
}

/**
 * `MOB-CHAT-19`: a delegated task reads as a "Delegated task" bubble, and the Session list labels its groups. With its
 * delegation record, the bubble shows the task the caller wrote, clamped with Show more (#2307); without one, it shows
 * the source-less fallback with the raw instruction collapsed.
 */
export async function executeMobileChatDelegatedTaskScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const fixture = await createMobileAcceptanceFixture({
        mode: 'agent-chat',
        serial: environment.serial,
    });
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await seedDelegationRecord(
            join(fixture.testDirectory, 'user-data'),
            fixture.allowedProjectId,
            fixture.allowedSessionId,
        );
        await chat.send({
            text: delegatedTaskPointer('/tmp/caxri-delegation/recorded.md', RECORDED_DELEGATION),
        });
        await waitForMobile(
            () => chat.read(),
            (value) =>
                !value.activeTurnId &&
                value.items.some(
                    (item) => item.type === 'userMessage' && item.delegatedTask?.prompt,
                ),
        );
        await chat.send({
            text: delegatedTaskPointer('/tmp/caxri-delegation/task.md', 'delegation-synthetic-1'),
        });
        const snapshot = await waitForMobile(
            () => chat.read(),
            (value) =>
                !value.activeTurnId &&
                value.items.filter((item) => item.type === 'userMessage' && item.delegatedTask)
                    .length === 2,
        );
        const delegated = snapshot.items.filter(
            (item): item is Extract<typeof item, { type: 'userMessage' }> =>
                item.type === 'userMessage' && Boolean(item.delegatedTask),
        );
        const recorded = delegated.find((item) => item.delegatedTask?.prompt)!;
        const pointer = delegated.find((item) => !item.delegatedTask?.prompt);
        if (!pointer) throw new Error('The unrecorded pointer was stamped with a task');
        await fixture.pair();
        // The finished reply leaves the Session unread, so it sits under Needs attention.
        await waitForCheck(environment.serial, 'session-group-attention');
        await capture(environment, 'session-groups', artifacts);
        await tapMobileCheck(environment.serial, `session-row-${fixture.allowedSessionId}`);
        await waitForCheck(environment.serial, `agent-chat-delegated-${pointer.id}`);
        await capture(environment, 'delegated-collapsed', artifacts);
        await tapMobileCheck(environment.serial, `agent-chat-delegated-toggle-${pointer.id}`);
        // Semantics wait for an idle screen, so the capture shows where the unfolded row settles.
        await waitForCheck(environment.serial, `agent-chat-delegated-toggle-${pointer.id}`);
        await capture(environment, 'delegated-expanded', artifacts);
        // Fold the pointer again so the recorded task above it is back on screen.
        await tapMobileCheck(environment.serial, `agent-chat-delegated-toggle-${pointer.id}`);
        const promptToggle = `agent-chat-delegated-prompt-${recorded.id}-toggle`;
        await waitForCheck(environment.serial, promptToggle);
        await capture(environment, 'delegated-prompt-clamped', artifacts);
        await tapMobileCheck(environment.serial, promptToggle);
        await waitForCheck(environment.serial, promptToggle);
        await capture(environment, 'delegated-prompt-expanded', artifacts);
        await finish(environment, artifacts, {
            delegatedTask: 'collapsed-and-expanded-visible',
            delegatedPrompt: 'clamped-and-expanded-visible',
            source: 'synthetic-pointer-and-record',
        });
    } finally {
        await fixture.stop();
    }
}
