import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { createE2EAgentEnvironment } from '@caxri/system';

import { delegationFixtureSource } from '../../../../scripts/agent-delegation-fixture';
import { grokAcceptanceSource } from './grok-fixture';

export const acceptanceAgentFixtureIds = [
    'agent-features-v1',
    'grok-build-v1',
    'agent-delegation-v1',
] as const;
type AcceptanceAgentFixtureId = (typeof acceptanceAgentFixtureIds)[number];

export interface PreparedAcceptanceAgentFixture<Provider extends AgentProvider = never> {
    environment: NodeJS.ProcessEnv;
    executables: Partial<Record<AgentProvider, string>> & Record<Provider, string>;
    fixtureId: AcceptanceAgentFixtureId;
    root: string;
}

export function validateAcceptanceAgentFixture(
    caseId: string,
    plannedFixture: string | undefined,
    requestedFixture: string | undefined,
): void {
    if (plannedFixture === requestedFixture) return;
    throw new Error(
        plannedFixture
            ? `Acceptance case ${caseId} requires --agent-fixture ${plannedFixture}`
            : `Acceptance case ${caseId} does not declare an Agent fixture`,
    );
}

function sharedSource(provider: AgentProvider): string {
    return String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
function main() {
const provider = ${JSON.stringify(provider)};
if (process.argv.includes('--version')) {
  process.stdout.write(provider === 'claude' ? '2.1.251 (Claude Code)\n' : 'codex-cli 0.151.0\n');
  process.exit(0);
}
const stateRoot = provider === 'claude' ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME;
const sqliteRoot = process.env.CODEX_SQLITE_HOME;
const receiptPath = path.join(stateRoot, 'acceptance-receipts.jsonl');
const modePath = path.join(stateRoot, 'acceptance-next-generation.json');
const releasePath = path.join(stateRoot, 'acceptance-release-generation');
const echoTerminalInputPath = path.join(stateRoot, 'acceptance-echo-terminal-input');
const counterPath = path.join(stateRoot, 'acceptance-generation-count');
const privateMarker = 'CAXRI_ACCEPTANCE_PRIVATE_' + provider.toUpperCase();
const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
const appendReceipt = (value) => fs.appendFileSync(receiptPath, JSON.stringify({ provider, ...value }) + '\n');
const readJson = (target) => JSON.parse(fs.readFileSync(target, 'utf8'));
const writeJson = (target, value) => fs.writeFileSync(target, JSON.stringify(value));
const nextCount = () => {
  let value = 0;
  try { value = Number(fs.readFileSync(counterPath, 'utf8')); } catch {}
  value += 1;
  fs.writeFileSync(counterPath, String(value));
  return value;
};
const consumeMode = () => {
  try {
    const value = readJson(modePath);
    fs.rmSync(modePath);
    return value;
  } catch {
    return { kind: 'normal' };
  }
};
const setMode = (value) => writeJson(modePath, value);
const waitForRelease = (callback) => {
  const poll = setInterval(() => {
    if (!fs.existsSync(releasePath)) return;
    clearInterval(poll);
    fs.rmSync(releasePath, { force: true });
    callback();
  }, 25);
};
const claudeSessions = () => path.join(stateRoot, 'sessions');
const findClaudeMetadata = (sessionId) => {
  for (const name of fs.readdirSync(claudeSessions())) {
    const target = path.join(claudeSessions(), name);
    try {
      if (readJson(target).sessionId === sessionId) return target;
    } catch {}
  }
};
const currentTitle = (sessionId) => {
  if (provider === 'claude') {
    const target = findClaudeMetadata(sessionId);
    return target ? readJson(target).name : undefined;
  }
  const database = path.join(sqliteRoot, 'state_9.sqlite');
  try {
    return childProcess.execFileSync('/usr/bin/sqlite3', [database, 'SELECT name FROM threads WHERE id = ' + quote(sessionId) + ';'], { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
};
// Codex is the only provider whose fixture writes a title: it generates its thread name natively.
const nativeCodexTitle = (count) => count === 1 ? 'Codex Native Title' : 'Codex Renewed Title';
const generatedPasteSummary = 'Actual error: build failed with code E42 at src/task.ts:17; repeated progress lines were omitted.';

const resumeIndex = process.argv.indexOf('--resume');
const renameCommand = process.argv.at(-1) ?? '';
if (provider === 'claude' && resumeIndex >= 0 && renameCommand.startsWith('/rename ')) {
  const sessionId = process.argv[resumeIndex + 1];
  const title = renameCommand.slice('/rename '.length);
  const target = findClaudeMetadata(sessionId);
  if (!target) process.exit(2);
  writeJson(target, { ...readJson(target), name: title, nameSource: 'custom', updatedAt: new Date().toISOString() });
  appendReceipt({ kind: 'providerRename', sessionIdHash: sessionId.length, title });
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + title,
    session_id: sessionId,
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}

const isClaudeGeneration = provider === 'claude' && process.argv.includes('--print') && process.argv.includes('--model');
const isCodexGeneration = provider === 'codex' && process.argv[2] === 'exec';
if (isClaudeGeneration || isCodexGeneration) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    // The long-paste summary is Caxri's only low-cost model call for either provider, so a call
    // without those instructions is a regression that must fail the Acceptance run loudly.
    if (!input.includes('If the text is a log, build trace, test output, or diagnostic dump:')) {
      appendReceipt({ kind: 'unexpectedTextGeneration', provider });
      process.exit(7);
      return;
    }
    const mode = consumeMode();
    const count = nextCount();
    const sessionId = mode.sessionId ?? '';
    const text = mode.kind === 'same' ? currentTitle(sessionId) : (mode.title ?? generatedPasteSummary);
    appendReceipt({
      argumentContainsPrivateInput: process.argv.join(' ').includes(privateMarker),
      call: count,
      inputContainsPrivateMarker: input.includes(privateMarker),
      kind: 'generate',
      mode: mode.kind,
    });
    const finish = () => {
      if (mode.kind === 'fail') process.exit(7);
      if (provider === 'claude') process.stdout.write(text || generatedPasteSummary);
      else process.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: text || generatedPasteSummary } }) + '\n');
    };
    if (mode.kind === 'hold') waitForRelease(finish);
    else finish();
  });
  return;
}

if (provider === 'codex' && process.argv[2] === 'app-server' && process.argv[3] === '--stdio') {
  const database = path.join(sqliteRoot, 'state_9.sqlite');
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      return;
    }
    if (message.id !== 2) return;
    childProcess.execFileSync('/usr/bin/sqlite3', [
      database,
      'UPDATE threads SET name = ' + quote(message.params.name) + ' WHERE id = ' + quote(message.params.threadId),
    ]);
    appendReceipt({ kind: 'providerRename', sessionIdHash: String(message.params.threadId).length, title: message.params.name });
    process.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
  });
  return;
}

const sessionId = provider + '-acceptance-' + process.pid;
let transcriptPath;
let metadataPath;
if (provider === 'claude') {
  fs.mkdirSync(claudeSessions(), { recursive: true });
  metadataPath = path.join(claudeSessions(), sessionId + '.json');
  writeJson(metadataPath, {
    cwd: process.cwd(),
    name: path.basename(process.cwd()),
    nameSource: 'derived',
    sessionId,
    startedAt: new Date().toISOString(),
    status: 'busy',
    updatedAt: new Date().toISOString(),
  });
  const projectDirectory = path.join(stateRoot, 'projects', process.cwd().replaceAll(/[^a-z0-9]/gi, '-'));
  fs.mkdirSync(projectDirectory, { recursive: true });
  transcriptPath = path.join(projectDirectory, sessionId + '.jsonl');
} else {
  const database = path.join(sqliteRoot, 'state_9.sqlite');
  const rolloutDirectory = path.join(stateRoot, 'sessions', '2026', '08', '30');
  fs.mkdirSync(rolloutDirectory, { recursive: true });
  transcriptPath = path.join(rolloutDirectory, 'rollout-2026-08-30-' + sessionId + '.jsonl');
  childProcess.execFileSync('/usr/bin/sqlite3', [database, [
    'CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, cwd TEXT, title TEXT, name TEXT, git_branch TEXT, rollout_path TEXT, created_at_ms INTEGER, updated_at_ms INTEGER, tokens_used INTEGER, archived INTEGER);',
    'INSERT OR REPLACE INTO threads VALUES (' + [
      quote(sessionId), quote(process.cwd()), quote('Private first prompt must stay private'), 'NULL',
      quote('feat/acceptance'), quote(transcriptPath), Date.now(), Date.now(), 0, 0,
    ].join(', ') + ');',
  ].join('\n')]);
}

const appendTranscript = (topic, includePrivate) => {
  const privateText = includePrivate ? privateMarker + '_PROMPT ' + privateMarker + '_RESPONSE ' : '';
  const filler = ' bounded acceptance context'.repeat(40);
  const records = provider === 'claude'
    ? [
        { type: 'user', message: { content: privateText + topic + filler } },
        { type: 'assistant', message: { content: privateText + 'The deterministic provider boundary completed.' } },
      ]
    : [
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: privateText + topic + filler }] } },
        { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: privateText + 'The deterministic provider boundary completed.' }] } },
      ];
  fs.appendFileSync(transcriptPath, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
};
const hookDocument = () => readJson(path.join(stateRoot, provider === 'claude' ? 'settings.json' : 'hooks.json'));
const invokeHook = (event) => {
  const group = hookDocument().hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify({ hook_event_name: event, session_id: sessionId }),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  appendReceipt({ event, kind: 'hook', sessionIdHash: sessionId.length });
};
const setClaudeStatus = (status) => {
  if (!metadataPath) return;
  writeJson(metadataPath, { ...readJson(metadataPath), status, updatedAt: new Date().toISOString() });
};
let hasCodexSessionStarted = false;
const startTurn = (topic, includePrivate = false) => {
  appendTranscript(topic, includePrivate);
  setClaudeStatus('busy');
  if (provider === 'codex' && !hasCodexSessionStarted) {
    invokeHook('SessionStart');
    hasCodexSessionStarted = true;
  }
  invokeHook('UserPromptSubmit');
};
const finishTurn = () => {
  setClaudeStatus('completed');
  const notifyFinished = () => invokeHook('Stop');
  if (provider !== 'codex') {
    notifyFinished();
    return;
  }
  const mode = consumeMode();
  const count = nextCount();
  const title = mode.kind === 'same' ? currentTitle(sessionId) : (mode.title ?? nativeCodexTitle(count));
  const applyNativeTitle = () => {
    if (mode.kind !== 'fail' && title) {
      const database = path.join(sqliteRoot, 'state_9.sqlite');
      childProcess.execFileSync('/usr/bin/sqlite3', [
        database,
        'UPDATE threads SET name = ' + quote(title) + ' WHERE id = ' + quote(sessionId),
      ]);
      appendReceipt({ kind: 'providerNativeTitle', sessionIdHash: sessionId.length, title });
    }
    notifyFinished();
  };
  if (mode.kind === 'hold') waitForRelease(applyNativeTitle);
  else applyNativeTitle();
};
const requestAttention = () => {
  setClaudeStatus('idle');
  invokeHook('PermissionRequest');
};

const requiredInitialHooks = ['SessionStart', 'UserPromptSubmit', 'Stop'];
const initialHooksReady = () => {
  try {
    const hooks = hookDocument().hooks;
    return requiredInitialHooks.every((event) => hooks[event]?.[0]?.hooks?.[0]?.command);
  } catch {
    return false;
  }
};
const startInitialTurn = () => {
  if (!initialHooksReady()) {
    setTimeout(startInitialTurn, 50);
    return;
  }
  try {
    startTurn('Initial acceptance topic');
    setTimeout(() => {
      try { finishTurn(); } catch (error) { appendReceipt({ kind: 'fixtureError', message: error.name }); }
    }, 150);
  } catch (error) {
    appendReceipt({ kind: 'fixtureError', message: error.name });
  }
};

appendTranscript('Initial acceptance topic', false);
setTimeout(startInitialTurn, 50);

const bracketedPasteStart = '\u001b[200~';
const bracketedPasteEnd = '\u001b[201~';
let input = '';
let isBracketedPaste = false;
process.stdin.setRawMode?.(true);
process.stdin.setEncoding('utf8');
const handleCommand = (raw) => {
  const command = raw.trim();
  try {
    if (command === 'fixture:start') startTurn('Long completion notification topic');
    else if (command === 'fixture:finish') finishTurn();
    else if (command === 'fixture:waiting') requestAttention();
    else if (command === 'fixture:release') fs.writeFileSync(releasePath, 'release');
    else if (command === 'fixture:hold-next') setMode({ kind: 'hold', sessionId });
    else if (command === 'fixture:fail-next') setMode({ kind: 'fail', sessionId });
    else if (command === 'fixture:same-next') setMode({ kind: 'same', sessionId });
    else if (command.startsWith('fixture:title:')) setMode({ kind: 'normal', sessionId, title: command.slice('fixture:title:'.length) });
    else if (command === 'fixture:turn') { startTurn('A changed acceptance topic'); setTimeout(finishTurn, 150); }
    else if (command === 'fixture:private-turn') { startTurn('Private acceptance topic', true); setTimeout(finishTurn, 150); }
    else if (command === 'fixture:exit') {
      appendReceipt({ kind: 'fixtureExit' });
      process.stdout.write('Fixture Agent exiting\r\n');
      process.exit(0);
    }
    else if (command) appendReceipt({ kind: 'terminalInput', length: command.length });
    process.stdout.write('Fixture command accepted\r\n');
  } catch (error) {
    appendReceipt({ kind: 'fixtureError', message: error.name });
    process.stdout.write('Fixture command failed\r\n');
  }
};
const markerSuffixLength = (value, marker) => {
  for (let length = Math.min(value.length, marker.length - 1); length > 0; length -= 1) {
    if (value.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
};
const processInput = () => {
  while (input.length > 0) {
    if (isBracketedPaste) {
      const endIndex = input.indexOf(bracketedPasteEnd);
      if (endIndex === -1) {
        const suffixLength = markerSuffixLength(input, bracketedPasteEnd);
        input = suffixLength === 0 ? '' : input.slice(-suffixLength);
        return;
      }
      input = input.slice(endIndex + bracketedPasteEnd.length);
      isBracketedPaste = false;
      continue;
    }
    const startIndex = input.indexOf(bracketedPasteStart);
    const newline = /\r\n|\r|\n/u.exec(input);
    if (startIndex !== -1 && (newline?.index === undefined || startIndex < newline.index)) {
      input = input.slice(startIndex + bracketedPasteStart.length);
      isBracketedPaste = true;
      continue;
    }
    if (newline?.index !== undefined) {
      handleCommand(input.slice(0, newline.index));
      input = input.slice(newline.index + newline[0].length);
      continue;
    }
    return;
  }
};
process.stdin.on('data', (chunk) => {
  // Opt-in echo makes unsent PTY input observable without exposing a host Agent process.
  if (fs.existsSync(echoTerminalInputPath)) {
    appendReceipt({
      inputContainsPrivateMarker: chunk.includes(privateMarker),
      kind: 'terminalChunk',
      length: chunk.length,
    });
    const visibleInput = chunk
      .replaceAll(bracketedPasteStart, '')
      .replaceAll(bracketedPasteEnd, '')
      .replaceAll(/\r\n|\r|\n/gu, '\r\n');
    process.stdout.write(visibleInput);
  }
  input += chunk;
  processInput();
});
process.stdin.resume();
// Real Agent TUIs enable bracketed paste so embedded newlines remain unsent editor input.
process.stdout.write('\u001b[?2004hFake ' + provider + ' Acceptance fixture ready\r\n');
}
main();
`;
}

function assertFixtureId(value: string): asserts value is AcceptanceAgentFixtureId {
    if (!acceptanceAgentFixtureIds.includes(value as AcceptanceAgentFixtureId)) {
        throw new Error(`Unknown Acceptance Agent fixture: ${value}`);
    }
}

/**
 * Creates one repository-owned fake-provider fixture beneath the isolated Acceptance profile. The CLI accepts only a
 * fixed id, so no caller can inject an executable, source body, environment variable, or host provider path.
 */
interface PrepareAcceptanceAgentFixtureOptions {
    fixtureId: string;
    sourceEnvironment?: NodeJS.ProcessEnv;
    userDataDir: string;
}

export function prepareAcceptanceAgentFixture(
    options: PrepareAcceptanceAgentFixtureOptions & {
        fixtureId: 'agent-features-v1' | 'agent-delegation-v1';
    },
): Promise<PreparedAcceptanceAgentFixture<'claude' | 'codex'>>;
export function prepareAcceptanceAgentFixture(
    options: PrepareAcceptanceAgentFixtureOptions & { fixtureId: 'grok-build-v1' },
): Promise<PreparedAcceptanceAgentFixture<'grok'>>;
export function prepareAcceptanceAgentFixture(
    options: PrepareAcceptanceAgentFixtureOptions,
): Promise<PreparedAcceptanceAgentFixture>;
export async function prepareAcceptanceAgentFixture(
    options: PrepareAcceptanceAgentFixtureOptions,
): Promise<PreparedAcceptanceAgentFixture> {
    assertFixtureId(options.fixtureId);
    const root = join(options.userDataDir, 'acceptance-agents');
    const bin = join(root, 'bin');
    await mkdir(bin, { recursive: true });
    const executables = Object.fromEntries(
        await Promise.all(
            (options.fixtureId === 'grok-build-v1'
                ? (['grok'] as const)
                : (['claude', 'codex'] as const)
            ).map(async (provider) => {
                const executable = join(bin, provider);
                await writeFile(
                    executable,
                    provider === 'grok'
                        ? grokAcceptanceSource()
                        : options.fixtureId === 'agent-delegation-v1'
                          ? delegationFixtureSource(provider)
                          : sharedSource(provider),
                    'utf8',
                );
                await chmod(executable, 0o700);
                return [provider, executable] as const;
            }),
        ),
    ) as Partial<Record<AgentProvider, string>>;
    const environment = await createE2EAgentEnvironment({
        fixtureRoot: root,
        mode: { mode: 'fake', executables },
        sourceEnvironment: options.sourceEnvironment ?? process.env,
    });
    await writeFile(join(environment.CODEX_HOME!, 'config.toml'), 'notify = ["/usr/bin/true"]\n', {
        encoding: 'utf8',
        mode: 0o600,
    });
    return {
        environment: { ...environment, CAXRI_E2E_AGENT_HOOKS: '1' },
        executables,
        fixtureId: options.fixtureId,
        root,
    };
}

export async function prepareAcceptanceAgentEnvironment(options: {
    fixtureId?: string;
    sourceEnvironment?: NodeJS.ProcessEnv;
    userDataDir: string;
}): Promise<NodeJS.ProcessEnv> {
    if (options.fixtureId) {
        return (
            await prepareAcceptanceAgentFixture({
                fixtureId: options.fixtureId,
                sourceEnvironment: options.sourceEnvironment,
                userDataDir: options.userDataDir,
            })
        ).environment;
    }
    return createE2EAgentEnvironment({
        fixtureRoot: join(options.userDataDir, 'acceptance-agents'),
        mode: { mode: 'blocked' },
        sourceEnvironment: options.sourceEnvironment ?? process.env,
    });
}
