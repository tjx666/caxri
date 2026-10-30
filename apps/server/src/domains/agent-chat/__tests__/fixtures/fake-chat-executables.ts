/**
 * Executable sources that turn the deterministic Agent Chat fakes in this directory into stand-alone provider binaries.
 * Electron E2E (`e2e/support/agent-chat-fixture.ts`, `e2e/support/mobile-acceptance-agents.ts`) and the desktop
 * Acceptance `agent-chat-v1` fixture (`.agents/skills/acceptance/scripts/agent-fixtures.ts`) write these sources as the
 * fake `claude`, `codex`, `grok`, and `agy` targets, so every surface drives one protocol implementation instead of
 * drifting copies.
 */
import { join } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const FAKE_CLAUDE_CLI = join(import.meta.dirname, 'fake-claude-cli.ts');
const FAKE_CODEX_APP_SERVER = join(import.meta.dirname, 'fake-codex-app-server.ts');
const FAKE_GROK_ACP = join(import.meta.dirname, 'fake-grok-acp.ts');
const FAKE_ANTIGRAVITY_ACP = join(import.meta.dirname, 'fake-antigravity-acp.ts');

/**
 * A fake `claude` speaking the Claude Agent SDK's stream-json protocol. Transcripts land under `CLAUDE_CONFIG_DIR`,
 * which the isolated Agent environment already points at a fixture-owned directory; `claudeConfigDirectory` overrides
 * it for tests that read the transcript from a known path. `controlDirectory` is where a test drops the files that turn
 * on the fake's injected failures (see `FAKE_CLAUDE_CONTROL_DIR` in `fake-claude-cli.ts`). `scriptPath` is a JSON file
 * of scripted turns the fake plays for matching messages (`FAKE_CLAUDE_SCRIPT`, see `fake-claude-script.ts`), for a
 * believable conversation instead of canned replies; use an absolute path, and the fake refuses to start when the file
 * is malformed.
 */
export function fakeClaudeChatExecutableSource(
    options: {
        claudeConfigDirectory?: string;
        controlDirectory?: string;
        scriptPath?: string;
    } = {},
): string {
    return `#!${process.execPath}
${options.claudeConfigDirectory ? `process.env.CLAUDE_CONFIG_DIR = ${JSON.stringify(options.claudeConfigDirectory)};\n` : ''}${options.controlDirectory ? `process.env.FAKE_CLAUDE_CONTROL_DIR = ${JSON.stringify(options.controlDirectory)};\n` : ''}${options.scriptPath ? `process.env.FAKE_CLAUDE_SCRIPT = ${JSON.stringify(options.scriptPath)};\n` : ''}import(${JSON.stringify(pathToFileURL(FAKE_CLAUDE_CLI).href)});
`;
}

/**
 * The PTY side of a surface switch: `codex resume <thread>` prints the thread it continues and waits for input. The
 * app-server branch follows in the `else` that `fakeCodexChatExecutableSource` closes.
 */
const FAKE_CODEX_PTY_STAND_IN = String.raw`if (!process.argv.includes('app-server')) {
  const resume = process.argv.indexOf('resume');
  process.stdout.write('Fake Codex TUI on thread ' + (resume === -1 ? 'new' : process.argv[resume + 1]) + '\r\n');
  process.stdin.resume();
} else {
`;

/**
 * A fake `codex` whose `app-server` is the JSON-RPC fixture. Threads persist under `stateDirectory`, so a resumed Chat
 * reads real history. `scriptPath` names a JSON file of scripted turns that replace the canned replies for the prompts
 * it lists (`FAKE_CODEX_SCRIPT`, see `fake-codex-script.ts`), and `controlDirectory` is where its `hold` steps look for
 * their files (`FAKE_CODEX_CONTROL_DIR`).
 */
export function fakeCodexChatExecutableSource(options: {
    stateDirectory: string;
    /**
     * App-only E2E flags are not inherited by providers, so native usage writes require an explicitly owned home.
     */
    nativeUsageHome?: string;
    /**
     * Also writes each user message to a rollout under the inherited `CODEX_HOME`, where the Server reads it back.
     */
    shouldWriteRollouts?: boolean;
    /**
     * Absolute path of the scripted turns JSON; sets `FAKE_CODEX_SCRIPT`.
     */
    scriptPath?: string;
    /**
     * Directory whose files the script's `hold` steps wait on; sets `FAKE_CODEX_CONTROL_DIR`.
     */
    controlDirectory?: string;
    /**
     * Answers a launch other than `app-server` (the PTY surface after a switch) with a stand-in TUI that prints which
     * thread it resumed and waits, instead of an app-server that never draws anything.
     */
    hasPtyStandIn?: boolean;
}): string {
    return String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.162.0\n');
  process.exit(0);
}
${options.hasPtyStandIn ? FAKE_CODEX_PTY_STAND_IN : ''}process.env.FAKE_CODEX_STATE_DIR = ${JSON.stringify(options.stateDirectory)};
process.env.FAKE_CODEX_NATIVE_USAGE_HOME = ${JSON.stringify(options.nativeUsageHome ?? '')};
${options.scriptPath ? `process.env.FAKE_CODEX_SCRIPT = ${JSON.stringify(options.scriptPath)};\n` : ''}${options.controlDirectory ? `process.env.FAKE_CODEX_CONTROL_DIR = ${JSON.stringify(options.controlDirectory)};\n` : ''}${options.shouldWriteRollouts ? 'process.env.FAKE_CODEX_SESSIONS_DIR = `${process.env.CODEX_HOME}/sessions`;\n' : ''}import(${JSON.stringify(pathToFileURL(FAKE_CODEX_APP_SERVER).href)});
${options.hasPtyStandIn ? '}\n' : ''}`;
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

/**
 * A fake `agy` whose `acp` is the ACP fixture. Conversations persist under `stateDirectory`.
 */
export function fakeAntigravityChatExecutableSource(options: { stateDirectory: string }): string {
    return `#!${process.execPath}
process.env.FAKE_ANTIGRAVITY_STATE_DIR = ${JSON.stringify(options.stateDirectory)};
import(${JSON.stringify(pathToFileURL(FAKE_ANTIGRAVITY_ACP).href)});
`;
}
