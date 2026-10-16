import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

import {
    fakeClaudeChatExecutableSource,
    fakeCodexChatExecutableSource,
} from '../../apps/server/src/domains/agent-chat/__tests__/fixtures/fake-chat-executables.ts';
import { createFakeAgentMode } from './agent-fixture';

// Synthetic provider executables for the Mobile Acceptance fixture: each stands in for a real Agent CLI so a phone
// scenario never discovers or launches a host provider.

export async function fakeChatAgent(userDataDirectory: string, testDirectory: string) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            claude: {
                // Transcripts stay under the fake agent home, where the Server reads history and image originals back.
                executableSource: fakeClaudeChatExecutableSource({
                    controlDirectory: testDirectory,
                }),
            },
            codex: {
                executableSource: fakeCodexChatExecutableSource({
                    stateDirectory: join(testDirectory, 'codex-threads'),
                    nativeUsageHome: join(userDataDirectory, 'e2e-agents', 'codex'),
                }),
            },
        },
    });
}

const MOBILE_ACCEPTANCE_SAFE_OUTPUT = 'Synthetic Agent output: ready for Acceptance review.\r\n';

export async function fakeWaitingAgent(userDataDirectory: string, inputCapture: string) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
function invokeHook(event, payload) {
  const hooks = JSON.parse(fs.readFileSync(path.join(process.env.CODEX_HOME, 'hooks.json'), 'utf8'));
  const group = hooks.hooks[event][0];
  childProcess.execFileSync('/bin/sh', ['-c', group.hooks[0].command], {
    env: process.env,
    input: JSON.stringify(payload),
  });
}
let resumed = false;
const fixtureSessionId = 'mobile-acceptance-session-' + process.pid;
process.stdin.setRawMode?.(true);
process.stdin.on('data', (chunk) => {
  fs.appendFileSync(${JSON.stringify(inputCapture)}, chunk);
  if (chunk.includes(3)) process.exit(130);
  if (!resumed) {
    resumed = true;
    invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-2' });
  }
  if (chunk.includes(13)) process.stdout.write('Synthetic message received.\r\n');
});
process.stdin.resume();
process.stdout.write(${JSON.stringify(MOBILE_ACCEPTANCE_SAFE_OUTPUT)});
setTimeout(() => {
  invokeHook('UserPromptSubmit', { session_id: fixtureSessionId, turn_id: 'turn-1' });
  invokeHook('PermissionRequest', { session_id: fixtureSessionId, turn_id: 'turn-1' });
}, 500);
`,
            },
        },
    });
}

export async function fakeFailingAgent(userDataDirectory: string) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            codex: {
                executableSource: String.raw`#!${process.execPath}
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
process.stderr.write('Synthetic Agent launch failed.\n');
process.exit(7);
`,
            },
        },
    });
}

export async function createSyntheticShell(testDirectory: string): Promise<string> {
    const executable = join(testDirectory, 'synthetic-shell');
    await writeFile(
        executable,
        String.raw`#!${process.execPath}
// 为隔离验收绘制合成终端网格；仅修改临时 Project 中的状态回执。
const fs = require('node:fs');
const path = require('node:path');
const statePath = path.join(process.cwd(), '.caxri-synthetic-shell-state.json');
let generationNumber = 0;
const render = () => {
  const columns = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (columns < 18 || rows < 4) return;
  const generation = 'synthetic-shell-' + (++generationNumber);
  const firstGridMarker = { columns, generation, rows };
  const lines = Array.from({ length: rows }, (_, index) => {
    const label = 'Synthetic row ' + String(index + 1).padStart(2, '0');
    return '│' + label.padEnd(columns - 2, ' ') + '│';
  });
  process.stdout.write('\x1b[2J');
  for (const [index, line] of lines.entries()) {
    process.stdout.write('\x1b[' + (index + 1) + ';1H' + line);
  }
  fs.writeFileSync(statePath + '.next', JSON.stringify({ columns, firstGridMarker, generation, rows }));
  fs.renameSync(statePath + '.next', statePath);
};
process.stdout.on('resize', render);
process.stdin.resume();
setTimeout(render, 250);
`,
    );
    await chmod(executable, 0o700);
    return executable;
}
