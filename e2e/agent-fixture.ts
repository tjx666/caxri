import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { agentProviderIds, type AgentProvider } from '../src/shared/agents';

interface FakeAgentInputCapture {
    encoding: 'hex' | 'raw' | 'utf8';
    /** Mirrors encoded input to the fake Terminal for interaction assertions. */
    echoPrefix?: string;
    path: string;
}

export interface FakeAgentDefinition {
    /** Complete executable source for provider-specific state or lifecycle behavior. */
    executableSource?: string;
    /** Deterministic text emitted after startup by the standard fake executable. */
    startupOutput?: string;
    /** Optional raw input capture used by tests that assert Terminal input mappings. */
    inputCapture?: FakeAgentInputCapture;
    /** Delays raw mode and its ready marker to reproduce a slow hosted PTY startup boundary. */
    readinessDelayMs?: number;
}

export interface FakeAgentMode {
    mode: 'fake';
    environment: NodeJS.ProcessEnv;
    executables: Partial<Record<AgentProvider, string>>;
}

/** Structured argv accepted by the Runtime's manual, Codex-only real Agent smoke boundary. */
export function realCodexSmokeArgs(prompt: string): string[] {
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
    return `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write(${JSON.stringify(`caxri-fake-${provider} 1.0.0\n`)});
  process.exit(0);
}
function becomeReady() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  ${
      capture
          ? `process.stdin.on('data', (chunk) => {
  ${
      capture.encoding === 'raw'
          ? `fs.appendFileSync(${JSON.stringify(capture.path)}, chunk);`
          : `const value = chunk.toString(${JSON.stringify(capture.encoding)});
  fs.appendFileSync(${JSON.stringify(capture.path)}, value + '\\n');
  ${capture.echoPrefix ? `process.stdout.write(${JSON.stringify(capture.echoPrefix)} + value + '\\r\\n');` : ''}`
  }
});`
          : ''
  }
  process.stdout.write(${JSON.stringify(definition.startupOutput ?? `Fake ${provider} ready\r\n`)});
}
${definition.readinessDelayMs ? `setTimeout(becomeReady, ${definition.readinessDelayMs});` : 'becomeReady();'}
`;
}

/**
 * Creates provider executables and state homes under one E2E user-data directory. The returned
 * object is passed directly as `launchCaxri({ agentMode })`, keeping fake authority explicit and
 * preventing tests from rediscovering a developer's real CLI through PATH or a login shell.
 */
export async function createFakeAgentMode(options: {
    userDataDir: string;
    providers: Partial<Record<AgentProvider, FakeAgentDefinition>>;
}): Promise<FakeAgentMode> {
    const fixtureRoot = join(options.userDataDir, 'e2e-agents');
    const bin = join(fixtureRoot, 'bin');
    const home = join(fixtureRoot, 'home');
    const codexState = join(fixtureRoot, 'codex');
    const claudeState = join(fixtureRoot, 'claude');
    const xdg = join(fixtureRoot, 'xdg');
    await Promise.all([
        mkdir(bin, { recursive: true }),
        mkdir(home, { recursive: true }),
        mkdir(codexState, { recursive: true }),
        mkdir(claudeState, { recursive: true }),
        mkdir(xdg, { recursive: true }),
    ]);

    const executables: Partial<Record<AgentProvider, string>> = {};
    for (const [provider, definition] of Object.entries(options.providers) as Array<
        [AgentProvider, FakeAgentDefinition]
    >) {
        if (!agentProviderIds.includes(provider))
            throw new Error(`Unsupported fake Agent provider: ${provider}`);
        if (
            definition.readinessDelayMs !== undefined &&
            (!Number.isInteger(definition.readinessDelayMs) ||
                definition.readinessDelayMs < 1 ||
                definition.readinessDelayMs > 5_000)
        ) {
            throw new RangeError('Fake Agent readiness delay must be an integer from 1 to 5000ms');
        }
        const executable = join(bin, provider);
        await writeFile(
            executable,
            definition.executableSource ?? standardExecutableSource(provider, definition),
            'utf8',
        );
        await chmod(executable, 0o700);
        executables[provider] = executable;
    }

    return {
        mode: 'fake',
        executables,
        environment: {
            HOME: home,
            CODEX_HOME: codexState,
            CODEX_SQLITE_HOME: codexState,
            CLAUDE_CONFIG_DIR: claudeState,
            XDG_CACHE_HOME: join(xdg, 'cache'),
            XDG_CONFIG_HOME: join(xdg, 'config'),
            XDG_DATA_HOME: join(xdg, 'data'),
        },
    };
}
