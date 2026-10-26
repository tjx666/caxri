import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AgentUsageReadout } from '@caxri/protocol';

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
 * Drags the Agent usage screen up by half its height, inside the scroll area and away from the Back gesture edges.
 */
async function scrollUsageScreen(serial: string): Promise<void> {
    const screen = checkBounds(await mobileSemantics(serial), 'agent-usage-screen');
    if (!screen) throw new Error('The Agent usage screen is not on screen');
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
}

/**
 * `MOB-CHAT-29`: a phone opens Agent usage from the Session list header and sees, per Agent, the plan windows with what
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
        await chat.send({ text: 'hi there' });
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
        await fixture.pair();
        await waitForCheck(serial, 'agent-usage-action');
        await capture(environment, 'session-list-entry', artifacts);

        await tapMobileCheckByBounds(serial, 'agent-usage-action');
        await waitForCheck(serial, 'agent-usage-limit-claude-300');
        await waitForCheck(serial, 'agent-usage-status-claude');
        await capture(environment, 'claude-card', artifacts);

        await scrollUsageScreen(serial);
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
