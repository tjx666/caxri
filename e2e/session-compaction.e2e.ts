import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AppSettings, BootstrapState, MethodResult } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

test('Batch compaction submits warm Sessions and preserves cold contexts and drafts', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-batch-compaction-e2e-'));
    const userData = join(directory, 'profile');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
if (process.argv.includes('--version')) { process.stdout.write('codex 0.149.0\n'); process.exit(0); }
const date = new Date();
const hex = date.getTime().toString(16).padStart(12, '0');
const id = hex.slice(0,8) + '-' + hex.slice(8) + '-7000-8000-' + process.pid.toString(16).padStart(12,'0');
const folder = path.join(process.env.CODEX_HOME, 'sessions', String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0'));
fs.mkdirSync(folder, { recursive: true });
const file = path.join(folder, 'rollout-2026-01-01T00-00-00-' + id + '.jsonl');
function append(entry) { fs.appendFileSync(file, JSON.stringify(entry) + '\n'); }
function hook(event) {
 const config = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
 const group = config.hooks[event];
 if (!group) return;
 for (const item of group) for (const h of item.hooks) cp.execFileSync('/bin/sh', ['-c', h.command], {
  env: process.env, input: JSON.stringify({session_id: id, turn_id:'fixture-turn', cwd:process.cwd()}), stdio:['pipe','ignore','ignore']
 });
}
hook('SessionStart');
let draft = '';
process.stdin.setRawMode?.(true);
process.stdin.on('data', data => {
 for (const character of data.toString()) {
  if (character !== '\r') { draft += character; continue; }
  if (draft === '/compact') {
   hook('PreCompact'); append({type:'compacted', timestamp:new Date().toISOString(), payload:{}}); hook('PostCompact');
   process.stdout.write('COMPACTED\r\n');
  } else {
   hook('UserPromptSubmit');
   append({type:'event_msg',timestamp:new Date(Date.now()-(draft === 'cold' ? 31*60000 : 0)).toISOString(),payload:{type:'token_count',info:{last_token_usage:{input_tokens:150000}}}});
   hook('Stop'); process.stdout.write('TURN_COMPLETE\r\n');
  }
  draft = '';
 }
});
process.stdin.resume();
process.stdout.write('READY\r\n');
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        userDataDir: userData,
        testRootPath: root,
        windowMode: 'hidden',
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
    });
    try {
        const settings = await pageRequest<{ value: AppSettings }>(running.page, 'settings.get');
        settings.value['agents.providers'].codex.hooks.enabled = true;
        await pageRequest(running.page, 'settings.update', {
            source: JSON.stringify(settings.value, null, 2),
        });
        await createProjectSession(running.page, 'codex');
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        const warm = bootstrap.terminals[0];
        await expect(running.page.locator('.xterm-rows')).toContainText('READY');
        async function submit(terminalId: string, text: string) {
            await pageRequest(running.page, 'terminal.input', { terminalId, data: text });
            await pageRequest(running.page, 'terminal.input', { terminalId, data: '\r' });
            await expect
                .poll(async () => {
                    const current = await pageRequest<BootstrapState>(
                        running.page,
                        'app.bootstrap',
                    );
                    return current.sessions.find(
                        ({ id }) =>
                            id ===
                            current.terminals.find((terminal) => terminal.id === terminalId)
                                ?.sessionId,
                    )?.lastActivityState;
                })
                .toBe('completed');
        }
        await submit(warm.id, 'warm');
        const cold = await pageRequest<MethodResult<'session.create'>>(
            running.page,
            'session.create',
            {
                projectId:
                    warm.sessionId === bootstrap.sessions[0]?.id
                        ? bootstrap.sessions[0].projectId
                        : bootstrap.projects[0].id,
                defaultAgent: 'codex',
            },
        );
        await expect
            .poll(
                async () =>
                    (
                        await pageRequest<BootstrapState>(running.page, 'app.bootstrap')
                    ).terminals.find(({ id }) => id === cold.terminal!.id)?.agentSessionId,
            )
            .toBeTruthy();
        await submit(cold.terminal!.id, 'cold');
        const draft = await pageRequest<MethodResult<'session.create'>>(
            running.page,
            'session.create',
            { projectId: cold.session.projectId, defaultAgent: 'codex' },
        );
        await expect
            .poll(
                async () =>
                    (
                        await pageRequest<BootstrapState>(running.page, 'app.bootstrap')
                    ).terminals.find(({ id }) => id === draft.terminal!.id)?.agentSessionId,
            )
            .toBeTruthy();
        await submit(draft.terminal!.id, 'warm');
        await pageRequest(running.page, 'terminal.input', {
            terminalId: draft.terminal!.id,
            data: 'unfinished draft',
        });
        await running.page.keyboard.press('Meta+Shift+P');
        const search = running.page.getByPlaceholder('Search projects, sessions, and commands…');
        await search.fill('Compact Recently Idle');
        await expect(
            running.page.getByRole('option', { name: /Compact Recently Idle Sessions/ }),
        ).toBeVisible();
        await search.press('Enter');
        await expect(
            running.page
                .locator('[data-sonner-toast]')
                .filter({ hasText: 'Compaction requested for 1 Session.' }),
        ).toBeVisible();
        await expect(
            running.page
                .locator('[data-sonner-toast]')
                .filter({ hasText: '1 cache estimated expired' }),
        ).toBeVisible();
        await expect(
            running.page
                .locator('[data-sonner-toast]')
                .filter({ hasText: '1 draft or idle state unverified' }),
        ).toBeVisible();
        await expect(search).toBeHidden();
        await running.page.screenshot({
            animations: 'disabled',
            path: test.info().outputPath('batch-compaction.png'),
        });
        const repeat = await pageRequest<MethodResult<'session.compactWarm'>>(
            running.page,
            'session.compactWarm',
            {},
        );
        expect(repeat.items.every(({ outcome }) => outcome !== 'submitted')).toBe(true);
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
