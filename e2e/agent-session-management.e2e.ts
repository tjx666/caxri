import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { BootstrapState } from '@caxri/protocol';

import { delegationFixtureSource } from '../scripts/agent-delegation-fixture.ts';
import { createFakeAgentMode } from './support/agent-fixture.ts';
import { allowE2EErrors, expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest, sessionCard } from './support/helpers.ts';
import { chooseContextMenuItem } from './support/native-context-menu.ts';

/**
 * An ordinary Agent starts work in a new Session through the real CLI, then tidies it up: renames it, archives it, and
 * restores it. Its own Session stays out of reach. The Workbench opens the creating Session from the new Session's
 * context menu.
 */
test('an Agent manages the Session it created, and the Workbench opens the creator', async () => {
    /**
     * The Agent's attempt to archive its own Session is refused on purpose.
     */
    allowE2EErrors([
        { source: 'server-core', event: 'ipc.request_failed', code: 'NOT_FOUND', count: 1 },
    ]);
    const directory = await mkdtemp(join(tmpdir(), 'caxri-agent-session-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'project');
    const contextPath = join(directory, 'context.json');
    const resultPath = join(directory, 'result.json');
    const cliPath = join(import.meta.dirname, '..', 'apps/cli/dist/caxri.cjs');
    await mkdir(root);
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
// The synthetic caller drives the real CLI through its inherited Endpoint and records only exit codes and IDs.
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
if(process.argv.includes('--version')) { console.log('codex-cli 0.153.4'); process.exit(0); }
const cli = args => spawnSync(process.execPath, [${JSON.stringify(cliPath)}, ...args, '--json'], {encoding:'utf8',env:process.env,timeout:45000});
const contextCall = cli(['agent-context']);
if(contextCall.status !== 0) process.exit(1);
const context = JSON.parse(contextCall.stdout);
fs.writeFileSync(${JSON.stringify(contextPath)}, JSON.stringify(context));
process.stdin.setRawMode?.(true);
let launched = false;
process.stdin.on('data', chunk => {
  if(launched || !chunk.toString().includes('delegate')) return;
  launched = true;
  const taskPath = ${JSON.stringify(join(directory, 'task.md'))};
  fs.writeFileSync(taskPath, 'Synthetic task');
  const created = cli(['agent','delegate','create','--project',context.endpoint.projectId,'--new-session','--title','Review README','--provider','claude','--prompt-file',taskPath]);
  if(created.status !== 0){fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({created:created.status}));return;}
  const receipt = JSON.parse(created.stdout);
  const waited = cli(['agent','delegate','wait',receipt.delegationId,'--timeout','20000']);
  const renamed = cli(['agent','session','rename',receipt.sessionId,'--title','Reviewed README']);
  const own = cli(['agent','session','archive',context.endpoint.sessionId]);
  const archived = cli(['agent','session','archive',receipt.sessionId]);
  const unarchived = cli(['agent','session','unarchive',receipt.sessionId]);
  fs.writeFileSync(${JSON.stringify(resultPath)},JSON.stringify({created:0,sessionId:receipt.sessionId,waited:waited.status,renamed:renamed.status,ownRefused:own.status!==0,archived:archived.status,unarchived:unarchived.status}));
});
process.stdin.resume();
process.stdout.write('Synthetic caller ready\r\n');
`,
            },
            claude: { executableSource: delegationFixtureSource('claude') },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        const callerSessionId = await createProjectSession(running.page, 'codex');
        await pageRequest(running.page, 'session.rename', {
            sessionId: callerSessionId,
            title: 'Coordinator',
        });
        await expect(running.page.locator('.xterm-rows')).toContainText('Synthetic caller ready');
        const context = JSON.parse(await readFile(contextPath, 'utf8')) as {
            endpoint: { terminalId: string };
        };
        await pageRequest(running.page, 'terminal.input', {
            terminalId: context.endpoint.terminalId,
            data: 'delegate\r',
        });
        await expect
            .poll(
                async () => {
                    try {
                        return JSON.parse(await readFile(resultPath, 'utf8')) as unknown;
                    } catch (error) {
                        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
                        throw error;
                    }
                },
                { timeout: 60_000 },
            )
            .toMatchObject({
                created: 0,
                waited: 0,
                renamed: 0,
                ownRefused: true,
                archived: 0,
                unarchived: 0,
            });
        const { sessionId } = JSON.parse(await readFile(resultPath, 'utf8')) as {
            sessionId: string;
        };
        const state = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(state.sessions.find((session) => session.id === sessionId)).toMatchObject({
            title: 'Reviewed README',
            createdBySessionId: callerSessionId,
        });
        expect(
            state.sessions.find((session) => session.id === sessionId)?.archivedAt,
        ).toBeUndefined();
        expect(
            state.sessions.find((session) => session.id === callerSessionId)?.archivedAt,
        ).toBeUndefined();

        await pageRequest(running.page, 'session.select', { sessionId });
        await expect
            .poll(
                async () =>
                    (await pageRequest<BootstrapState>(running.page, 'app.bootstrap'))
                        .selectedSessionId,
            )
            .toBe(sessionId);
        await sessionCard(running.page, sessionId).click({ button: 'right' });
        await chooseContextMenuItem(running.app, 'Go to Creating Session');
        await expect
            .poll(
                async () =>
                    (await pageRequest<BootstrapState>(running.page, 'app.bootstrap'))
                        .selectedSessionId,
            )
            .toBe(callerSessionId);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
