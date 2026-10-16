/**
 * Executable sources that turn the deterministic Agent Chat fakes in this directory into stand-alone provider binaries.
 * Electron E2E (`e2e/support/agent-chat-fixture.ts`, `e2e/support/mobile-acceptance-agents.ts`) and the desktop
 * Acceptance `agent-chat-v1` fixture (`.agents/skills/acceptance/scripts/agent-fixtures.ts`) write these sources as the
 * fake `claude`, `codex`, and `grok` targets, so every surface drives one protocol implementation instead of drifting
 * copies.
 */
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FAKE_CLAUDE_CLI = join(import.meta.dirname, 'fake-claude-cli.ts');
const FAKE_CODEX_APP_SERVER = join(import.meta.dirname, 'fake-codex-app-server.ts');
const FAKE_GROK_ACP = join(import.meta.dirname, 'fake-grok-acp.ts');

/**
 * A fake `claude` speaking the Claude Agent SDK's stream-json protocol. Transcripts land under `CLAUDE_CONFIG_DIR`,
 * which the isolated Agent environment already points at a fixture-owned directory; `claudeConfigDirectory` overrides
 * it for tests that read the transcript from a known path. `controlDirectory` is where a test drops the files that turn
 * on the fake's injected failures (see `FAKE_CLAUDE_CONTROL_DIR` in `fake-claude-cli.ts`).
 */
export function fakeClaudeChatExecutableSource(
    options: { claudeConfigDirectory?: string; controlDirectory?: string } = {},
): string {
    return `#!${process.execPath}
${options.claudeConfigDirectory ? `process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(options.claudeConfigDirectory)};\n` : ''}${options.controlDirectory ? `process.env.FAKE_CLAUDE_CONTROL_DIR = ${JSON.stringify(options.controlDirectory)};\n` : ''}import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});
`;
}

/**
 * A fake `codex` whose `app-server` is the JSON-RPC fixture. Threads persist under `stateDirectory`, so a resumed Chat
 * reads real history.
 */
export function fakeCodexChatExecutableSource(options: {
    stateDirectory: string;
    /**
     * App-only E2E flags are not inherited by providers, so native usage writes require an explicitly owned home.
     */
    nativeUsageHome?: string;
}): string {
    return String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(options.stateDirectory)};
process.env.FAKE_CODEX_NATIVE_USAGE_HOME = ${JSON.stringify(options.nativeUsageHome ?? '')};
import(${JSON.stringify(pathToFileURL(FAKE_CODEX_APP_SERVER).href)});
`;
}

/**
 * A fake `grok` whose `agent stdio` is the ACP fixture. Sessions persist under `stateDirectory`.
 */
export function fakeGrokChatExecutableSource(options: { stateDirectory: string }): string {
    return `#!${process.execPath}
process.env.FAKE_GROK_STATE_DIR = ${JSON.stringify(options.stateDirectory)};
import(${JSON.stringify(pathToFileURL(FAKE_GROK_ACP).href)});
`;
}
