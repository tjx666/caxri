import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import type { AgentProvider } from '@caxri/protocol';
import { agentProviderIds } from '@caxri/protocol';
import { createE2EAgentIsolationEnvironment } from '@caxri/system';

interface FakeAgentInputCapture {
    encoding: 'hex' | 'raw' | 'utf8';
    /**
     * Mirrors encoded input to the fake Terminal for interaction assertions.
     */
    echoPrefix?: string;
    path: string;
}

export interface FakeAgentDefinition {
    /**
     * Complete executable source for provider-specific state or lifecycle behavior.
     */
    executableSource?: string;
    /**
     * Deterministic text emitted after startup by the standard fake executable.
     */
    startupOutput?: string;
    /**
     * Appends each interactive launch's arguments as one JSON line, for tests that assert what Caxri launched with.
     */
    argumentsCapturePath?: string;
    /**
     * Optional raw input capture used by tests that assert Terminal input mappings.
     */
    inputCapture?: FakeAgentInputCapture;
    /**
     * Delays raw mode and its ready marker to reproduce a slow hosted PTY startup boundary.
     */
    readinessDelayMs?: number;
}

export interface FakeAgentMode {
    mode: 'fake';
    environment: NodeJS.ProcessEnv;
    executables: Partial<Record<AgentProvider, string>>;
}

/**
 * Structured argv accepted by the Runtime's manual, Codex-only real Agent smoke boundary.
 */
export function realCodexSmokeArguments(prompt: string): string[] {
    return [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--ephemeral',
        '--ignore-rules',
        '--color',
        'never',
        prompt,
    ];
}

function standardExecutableSource(
    provider: AgentProvider,
    definition: FakeAgentDefinition,
): string {
    const capture = definition.inputCapture;
    return String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const provider = ${JSON.stringify(provider)};
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(provider === 'grok' ? 'grok 1.0.24\n' : provider === 'codex' ? 'codex-cli 0.151.0\n' : '2.1.251 (Claude Code)\n')});
  process.exit(0);
}
const resumeIndex = process.argv.indexOf('--resume');
const renameCommand = process.argv.at(-1) ?? '';
if (provider === 'claude' && resumeIndex >= 0 && renameCommand.startsWith('/rename ')) {
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + renameCommand.slice('/rename '.length),
    session_id: process.argv[resumeIndex + 1],
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}
const isCodexAppServer = provider === 'codex' && process.argv[2] === 'app-server' && process.argv[3] === '--stdio';
if (isCodexAppServer) {
  const quote = (value) => "'" + String(value).replaceAll("'", "''") + "'";
  require('node:readline').createInterface({ input: process.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id === 1) {
      process.stdout.write(JSON.stringify({ id: 1, result: {} }) + '\n');
      return;
    }
    if (message.id !== 2) return;
    try {
      const stateDirectory = process.env.CODEX_SQLITE_HOME;
      const database = fs.readdirSync(stateDirectory).find((name) => /^state_\d+\.sqlite$/.test(name));
      if (database) {
        childProcess.execFileSync('/usr/bin/sqlite3', [
          path.join(stateDirectory, database),
          'UPDATE threads SET name = ' + quote(message.params.name) + ' WHERE id = ' + quote(message.params.threadId),
        ]);
      }
    } catch {}
    process.stdout.write(JSON.stringify({ id: 2, result: {} }) + '\n');
  });
} else {
  ${definition.argumentsCapturePath ? String.raw`fs.appendFileSync(${JSON.stringify(definition.argumentsCapturePath)}, JSON.stringify(process.argv.slice(2)) + '\n');` : ''}
  function becomeReady() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  ${
      capture
          ? `process.stdin.on('data', (chunk) => {
  ${
      capture.encoding === 'raw'
          ? `fs.appendFileSync(${JSON.stringify(capture.path)}, chunk);`
          : String.raw`const value = chunk.toString(${JSON.stringify(capture.encoding)});
  fs.appendFileSync(${JSON.stringify(capture.path)}, value + '\n');
  ${capture.echoPrefix ? String.raw`process.stdout.write(${JSON.stringify(capture.echoPrefix)} + value + '\r\n');` : ''}`
  }
});`
          : ''
  }
  process.stdout.write(${JSON.stringify(definition.startupOutput ?? `Fake ${provider} ready\r\n`)});
}
  ${definition.readinessDelayMs ? `setTimeout(becomeReady, ${definition.readinessDelayMs});` : 'becomeReady();'}
}
`;
}

/**
 * Creates provider executables and state homes under one E2E user-data directory. The returned object is passed
 * directly as `launchCaxri({ agentMode })`, keeping fake authority explicit and preventing tests from rediscovering a
 * developer's real CLI through PATH or a login shell.
 */
export async function createFakeAgentMode(options: {
    userDataDir: string;
    providers: Partial<Record<AgentProvider, FakeAgentDefinition>>;
}): Promise<FakeAgentMode> {
    const fixtureRoot = join(options.userDataDir, 'e2e-agents');
    const bin = join(fixtureRoot, 'bin');
    const environment = await createE2EAgentIsolationEnvironment(fixtureRoot);
    await mkdir(bin, { recursive: true });

    const providerEntries = Object.entries(options.providers) as Array<
        [AgentProvider, FakeAgentDefinition]
    >;
    for (const [provider, definition] of providerEntries) {
        if (!agentProviderIds.includes(provider))
            throw new Error(`Unsupported fake Agent provider: ${provider}`);
        if (
            definition.readinessDelayMs !== undefined &&
            (!Number.isSafeInteger(definition.readinessDelayMs) ||
                definition.readinessDelayMs < 1 ||
                definition.readinessDelayMs > 5_000)
        ) {
            throw new RangeError('Fake Agent readiness delay must be an integer from 1 to 5000ms');
        }
    }
    const executables: Partial<Record<AgentProvider, string>> = {};
    await Promise.all(
        providerEntries.map(async ([provider, definition]) => {
            const executable = join(bin, provider);
            await writeFile(
                executable,
                definition.executableSource ?? standardExecutableSource(provider, definition),
                'utf8',
            );
            await chmod(executable, 0o700);
            executables[provider] = executable;
        }),
    );

    return {
        mode: 'fake',
        executables,
        environment,
    };
}
