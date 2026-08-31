import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider, AppSettings, BootstrapState } from '@caxri/protocol';

import { createFakeAgentMode } from './support/agent-fixture.ts';
import { expect, test } from './support/fixtures.ts';
import { createProjectSession, launchCaxri, pageRequest } from './support/helpers.ts';

async function enableAutomaticNaming(
    page: Parameters<typeof pageRequest>[0],
    provider: AgentProvider,
): Promise<void> {
    const current = await pageRequest<{ value: AppSettings }>(page, 'settings.get');
    const settings = structuredClone(current.value);
    settings['agents.providers'][provider].hooks.enabled = true;
    settings['agents.providers'][provider].naming.enabled = true;
    await pageRequest(page, 'settings.update', { source: JSON.stringify(settings, null, 2) });
}

function namingCallArguments(contents: string): string[] {
    const parsed: unknown = JSON.parse(contents);
    if (typeof parsed !== 'object' || parsed === null || !('arguments' in parsed)) return [];
    const argumentsValue: unknown = parsed.arguments;
    return Array.isArray(argumentsValue)
        ? argumentsValue.filter((value): value is string => typeof value === 'string')
        : [];
}

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Claude Code applies a Caxri-generated Session title after Stop', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-claude-auto-name-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const sessionId = 'claude-auto-name-session';
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
const resumeIndex = process.argv.indexOf('--resume');
const renameCommand = process.argv.at(-1) ?? '';
const metadataPath = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions', 'session.json');
if (resumeIndex >= 0 && renameCommand.startsWith('/rename ')) {
  const displayTitle = renameCommand.slice('/rename '.length);
  const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  fs.writeFileSync(metadataPath, JSON.stringify({ ...metadata, name: displayTitle, nameSource: 'custom' }));
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + displayTitle,
    session_id: process.argv[resumeIndex + 1],
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}
if (process.argv.includes('--print') && process.argv.includes('--model')) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    fs.appendFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'naming-calls.jsonl'), JSON.stringify({
      arguments: process.argv.slice(2),
      hasPrivatePrompt: input.includes('Implement lifecycle-safe automatic naming'),
    }) + '\n');
    process.stdout.write('Claude Automatic Naming');
  });
} else {
fs.mkdirSync(path.dirname(metadataPath), { recursive: true });
fs.writeFileSync(metadataPath, JSON.stringify({
  cwd: process.cwd(),
  name: path.basename(process.cwd()),
  nameSource: 'derived',
  sessionId,
  startedAt: new Date().toISOString(),
  status: 'completed',
  updatedAt: new Date().toISOString(),
}));
const projectDirectory = path.join(
  process.env.CLAUDE_CONFIG_DIR,
  'projects',
  process.cwd().replaceAll(/[^a-z0-9]/gi, '-'),
);
fs.mkdirSync(projectDirectory, { recursive: true });
fs.writeFileSync(path.join(projectDirectory, sessionId + '.jsonl'), [
  JSON.stringify({ type: 'user', message: { content: 'Implement lifecycle-safe automatic naming' } }),
  JSON.stringify({ type: 'assistant', message: { content: 'The provider boundary is ready.' } }),
].join('\n') + '\n');
function invokeHook(event) {
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json'), 'utf8'));
  const group = settings.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ session_id: sessionId }),
  });
}
setTimeout(() => {
  invokeHook('UserPromptSubmit');
  setTimeout(() => invokeHook('Stop'), 100);
}, 250);
process.stdin.resume();
process.stdout.write('Fake Claude automatic naming ready\r\n');
}
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        testRootPath: root,
        userDataDir: userData,
    });

    try {
        await enableAutomaticNaming(running.page, 'claude');
        await expect
            .poll(async () =>
                readFile(join(userData, 'e2e-agents', 'claude', 'settings.json'), 'utf8'),
            )
            .toContain('UserPromptSubmit');
        const sessionId = await createProjectSession(running.page, 'claude');

        await expect(running.page.locator('.session-card strong')).toHaveText(
            'Claude Automatic Naming',
        );
        const bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.sessions.find((session) => session.id === sessionId)).toMatchObject({
            autoNamingState: 'active',
            displayTitle: 'Claude Automatic Naming',
            titleMode: 'automatic',
        });
        const modelCalls = await readFile(
            join(userData, 'e2e-agents', 'claude', 'naming-calls.jsonl'),
            'utf8',
        );
        expect(modelCalls.trim().split('\n')).toHaveLength(1);
        expect(modelCalls).toContain('"hasPrivatePrompt":true');
        expect(namingCallArguments(modelCalls).join(' ')).not.toContain(
            'Implement lifecycle-safe automatic naming',
        );
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});

// eslint-disable-next-line no-empty-pattern -- Playwright requires the first test argument to use object destructuring
test('Codex applies a native thread name and keeps manual ownership explicit', async ({}) => {
    const directory = await mkdtemp(join(tmpdir(), 'caxri-codex-auto-name-e2e-'));
    const userData = join(directory, 'user-data');
    const root = join(directory, 'project');
    await mkdir(root, { recursive: true });
    const agentMode = await createFakeAgentMode({
        userDataDir: userData,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const threadId = 'codex-auto-name-thread';
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv[2] === 'exec') {
  fs.writeFileSync(path.join(process.env.CODEX_HOME, 'unexpected-naming-call'), 'called');
  process.exit(7);
} else {
const databasePath = path.join(process.env.CODEX_SQLITE_HOME, 'state_9.sqlite');
if (process.argv[2] === 'app-server' && process.argv[3] === '--stdio') {
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      return;
    }
    if (message.id !== 2) return;
    childProcess.execFileSync('/usr/bin/sqlite3', [
      databasePath,
      'UPDATE threads SET name = ' + quote(message.params.name) + ' WHERE id = ' + quote(message.params.threadId),
    ]);
    process.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
  });
} else {
const rolloutDirectory = path.join(process.env.CODEX_HOME, 'sessions', '2026', '08', '30');
const rolloutPath = path.join(rolloutDirectory, 'rollout-2026-08-30-' + threadId + '.jsonl');
fs.mkdirSync(rolloutDirectory, { recursive: true });
fs.writeFileSync(rolloutPath, [
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Implement immediate Codex thread naming' }],
    },
  }),
  JSON.stringify({
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'The thread naming path is ready.' }],
    },
  }),
].join('\n') + '\n');
childProcess.execFileSync('/usr/bin/sqlite3', [databasePath, [
  'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, git_branch TEXT, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER);',
  'DELETE FROM threads;',
  'INSERT INTO threads VALUES (' + [
    quote(threadId), quote(process.cwd()), quote('Derived Codex title'), 'NULL',
    quote('feat/auto-name'), quote(rolloutPath), Date.now(), Date.now(), 0, 0,
  ].join(', ') + ');',
].join('\n')]);
function invokeHook(event) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ session_id: threadId }),
  });
}
setTimeout(() => {
  invokeHook('SessionStart');
  invokeHook('UserPromptSubmit');
  setTimeout(() => {
    childProcess.execFileSync('/usr/bin/sqlite3', [
      databasePath,
      'UPDATE threads SET name = ' + quote('Codex Native Naming') + ' WHERE id = ' + quote(threadId),
    ]);
    invokeHook('Stop');
  }, 100);
}, 250);
process.stdin.resume();
process.stdout.write('Fake Codex automatic naming ready\r\n');
}
}
`,
            },
        },
    });
    const running = await launchCaxri({
        agentMode,
        env: { CAXRI_E2E_AGENT_HOOKS: '1' },
        testRootPath: root,
        userDataDir: userData,
    });

    try {
        await enableAutomaticNaming(running.page, 'codex');
        await expect
            .poll(async () => readFile(join(userData, 'e2e-agents', 'codex', 'hooks.json'), 'utf8'))
            .toContain('SessionStart');
        const sessionId = await createProjectSession(running.page, 'codex');

        await expect(running.page.locator('.session-card strong')).toHaveText(
            'Codex Native Naming',
        );
        await pageRequest(running.page, 'session.rename', {
            displayTitle: 'Manual title wins',
            sessionId,
        });
        await expect(running.page.locator('.session-card strong')).toHaveText('Manual title wins');
        let bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.sessions.find((session) => session.id === sessionId)).toMatchObject({
            autoNamingState: 'stopped',
            titleMode: 'manual',
        });

        const row = running.page.locator(`.session-card[data-session-id="${sessionId}"]`);
        await expect(
            running.page.getByRole('button', {
                name: `Resume automatic naming for Manual title wins`,
            }),
        ).toHaveCount(0);
        await row.focus();
        await row.press('r');
        bootstrap = await pageRequest<BootstrapState>(running.page, 'app.bootstrap');
        expect(bootstrap.sessions.find((session) => session.id === sessionId)).toMatchObject({
            autoNamingState: 'stopped',
            displayTitle: 'Manual title wins',
            titleMode: 'manual',
        });
        await expect(
            readFile(join(userData, 'e2e-agents', 'codex', 'unexpected-naming-call'), 'utf8'),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
        await running.app.close();
        await rm(directory, { recursive: true, force: true });
    }
});
