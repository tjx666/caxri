import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentThroughput, AgentUsageReadout } from '@caxri/protocol';

import { pageRequest } from './helpers';
import { createMobileAcceptanceFixture } from './mobile-acceptance-fixture';
import type { MobileAgentScenarioEnvironment } from './mobile-agent-actions-scenarios';
import { capture, finish } from './mobile-agent-actions-scenarios';
import { checkBounds, waitForCheck } from './mobile-agent-chat-helpers';
import { adbShell, mobileSemantics, tapMobileCheckByBounds, waitForMobile } from './mobile-android';

/**
 * A synthetic Claude status page in Statuspage's summary shape: the API is degraded by one open incident.
 */
const claudeStatusPage = (now: number) => ({
    page: { name: 'Claude', url: 'https://status.claude.com' },
    components: [
        { id: 'api', name: 'Claude API (api.anthropic.com)', status: 'degraded_performance' },
        { id: 'code', name: 'Claude Code', status: 'operational' },
    ],
    incidents: [
        {
            id: 'fixture-incident',
            name: 'Elevated errors on the Claude API',
            status: 'investigating',
            impact: 'minor',
            updated_at: new Date(now).toISOString(),
            components: [{ id: 'api' }],
            incident_updates: [
                {
                    body: 'We are investigating elevated error rates.',
                    updated_at: new Date(now).toISOString(),
                },
            ],
        },
    ],
});

/**
 * OpenAI's incident.io summary with every Codex component operational.
 */
const openAiStatusPage = {
    summary: {
        name: 'OpenAI',
        public_url: 'https://status.openai.com/',
        structure: {
            items: [
                {
                    group: {
                        name: 'Codex',
                        components: [
                            { component_id: 'cx-api', name: 'Codex API' },
                            { component_id: 'cx-cli', name: 'CLI' },
                        ],
                    },
                },
            ],
        },
        affected_components: [],
        ongoing_incidents: [],
    },
};

/**
 * Drags the Agent usage screen up until `id` is laid out, one drag of half its height per try, inside the scroll area
 * and away from the Back gesture edges.
 */
async function scrollUsageScreenTo(serial: string, id: string, triesLeft = 6): Promise<void> {
    const nodes = await mobileSemantics(serial);
    const target = checkBounds(nodes, id);
    const screen = checkBounds(nodes, 'agent-usage-screen');
    if (!screen) throw new Error('The Agent usage screen is not on screen');
    if (target && target.bottom < screen.bottom) return;
    if (triesLeft === 0) throw new Error(`${id} is not on screen`);
    const x = Math.floor((screen.left + screen.right) / 2);
    const height = screen.bottom - screen.top;
    await adbShell(serial, [
        'input',
        'swipe',
        String(x),
        String(screen.top + Math.floor(height * 0.8)),
        String(x),
        String(screen.top + Math.floor(height * 0.3)),
        '300',
    ]);
    await scrollUsageScreenTo(serial, id, triesLeft - 1);
}

/**
 * `MOB-CHAT-30`: a phone opens Agent usage from the Session list header and sees, per Agent, the plan windows with what
 * is left and when each resets, the latest output speed, and the provider's API status. A running Claude Chat answers
 * `/usage` (the fake reports a behind-pace week), the Claude status page is degraded by an incident, and the Codex page
 * is operational.
 */
export async function executeMobileAgentUsageScenario(
    environment: MobileAgentScenarioEnvironment,
    artifacts: string[],
): Promise<void> {
    const { serial } = environment;
    const statusPages = await mkdtemp(join(tmpdir(), 'caxri-mobile-status-pages-'));
    const claudePage = JSON.stringify(claudeStatusPage(Date.now()));
    await Promise.all([
        writeFile(join(statusPages, 'status.claude.com.json'), claudePage),
        writeFile(join(statusPages, 'status.openai.com.json'), JSON.stringify(openAiStatusPage)),
    ]);
    let fixture: Awaited<ReturnType<typeof createMobileAcceptanceFixture>>;
    try {
        fixture = await createMobileAcceptanceFixture({
            chatProvider: 'claude',
            env: { CAXRI_E2E_PROVIDER_STATUS_DIR: statusPages },
            mode: 'agent-chat',
            serial,
        });
    } catch (error) {
        await rm(statusPages, { force: true, recursive: true });
        throw error;
    }
    try {
        const chat = fixture.agentChat;
        if (!chat || !fixture.allowedSessionId) throw new Error('Chat fixture is unavailable');
        await writeFile(join(fixture.testDirectory, 'plan-behind-pace'), '');
        // `pause` paces the fake reply in 200 ms chunks, so the response lasts long enough to measure its speed.
        await chat.send({ text: 'pause, then answer' });
        await waitForMobile(
            () => chat.read(),
            (snapshot) =>
                !snapshot.activeTurnId &&
                snapshot.items.some((item) => item.type === 'agentMessage'),
        );
        // The running Chat answers `/usage` in the background; the first usage read only asks for it.
        const readout = await waitForMobile(
            () =>
                pageRequest<AgentUsageReadout | null>(fixture.running.page, 'terminal.agentUsage', {
                    terminalId: chat.terminalId,
                }),
            (current) => current?.limit?.windows.length === 2,
        );
        await waitForMobile(
            () =>
                pageRequest<AgentThroughput | null>(
                    fixture.running.page,
                    'terminal.agentThroughput',
                    { terminalId: chat.terminalId },
                ),
            (current) => (current?.recent.responseCount ?? 0) > 0,
        );
        await fixture.pair();
        await waitForCheck(serial, 'agent-usage-action');
        await capture(environment, 'session-list-entry', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-usage-action');
        await waitForCheck(serial, 'agent-usage-limit-claude-10080');
        await waitForCheck(serial, 'agent-usage-pace-claude');
        await waitForCheck(serial, 'agent-usage-status-claude');
        await capture(environment, 'claude-limits', artifacts);

        await scrollUsageScreenTo(serial, 'agent-usage-status-page-claude');
        await waitForCheck(serial, 'agent-usage-speed-claude');
        await waitForCheck(serial, 'agent-usage-incident-claude');
        await capture(environment, 'claude-speed-status', artifacts);

        await scrollUsageScreenTo(serial, 'agent-usage-status-page-codex');
        await waitForCheck(serial, 'agent-usage-status-codex');
        await capture(environment, 'codex-card', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-usage-back');
        await waitForCheck(serial, 'agent-usage-action');
        await finish(environment, artifacts, {
            limitWindows: readout?.limit?.windows.map(({ windowMinutes, usedPercent }) => ({
                windowMinutes,
                usedPercent,
            })),
            serviceStatus: { claude: 'degraded', codex: 'operational' },
        });
    } finally {
        await fixture.stop();
        await rm(statusPages, { force: true, recursive: true });
    }
}
