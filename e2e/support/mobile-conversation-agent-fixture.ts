import process from 'node:process';

import { createFakeAgentMode } from './agent-fixture';

/**
 * The marker is written only after raw input and the menu renderer are ready.
 */
function syntheticMenuControllerSource(statePath: string): string {
    return String.raw`let menuActive = false;
let selected = 1;
let submissions = 0;
let interrupts = 0;
let pending = Buffer.alloc(0);
let generationNumber = 0;
const menuStatePath = ${JSON.stringify(statePath)};
const render = () => {
  const cols = process.stdout.columns ?? 0;
  const rows = process.stdout.rows ?? 0;
  if (cols < 18 || rows < 4) return;
  const generation = 'G' + (++generationNumber);
  const labels = Array.from({ length: rows }, (_, index) => 'Synthetic row ' + String(index + 1).padStart(2, '0'));
  labels[0] = generation + ' Agent ready';
  labels[1] = menuActive ? (selected === 1 ? '> 1. First' : '  1. First') : 'Synthetic conversation';
  labels[2] = menuActive ? (selected === 2 ? '> 2. Second' : '  2. Second') : 'Waiting for Stop';
  labels[rows - 1] = menuActive ? (submissions > 0 ? 'Selection submitted' : 'Choose an option') : 'Synthetic Agent busy';
  const lines = labels.map((label) => '│' + label.slice(0, cols - 2).padEnd(cols - 2, ' ') + '│');
  process.stdout.write('\x1b[?7l\x1b[2J');
  for (const [index, line] of lines.entries()) {
    const color = index === 0 ? 32 : menuActive && index === selected ? 36 : index === rows - 1 && submissions > 0 ? 35 : 37;
    process.stdout.write('\x1b[' + (index + 1) + ';1H\x1b[' + color + 'm' + line + '\x1b[0m');
  }
  process.stdout.write('\x1b[?7h');
  fs.writeFileSync(menuStatePath + '.next', JSON.stringify({
    cols,
    firstGridMarker: { columns: cols, generation, rows },
    generation,
    interrupts,
    lines,
    phase: menuActive ? 'menu' : 'busy',
    rows,
    selected,
    submissions,
  }));
  fs.renameSync(menuStatePath + '.next', menuStatePath);
};
const activateMenu = () => {
  if (menuActive) return;
  menuActive = true;
  render();
};
process.stdin.on('data', (chunk) => {
  if (!menuActive) return;
  pending = Buffer.concat([pending, chunk]);
  while (pending.length > 0) {
    const first = pending[0];
    if (first === 27) {
      if (pending.length < 3) break;
      if (pending[1] === 91 && pending[2] === 66) {
        selected = 2;
        process.stdout.write('\x1b[36mSecond selected\x1b[0m\r\n');
      } else if (pending[1] === 91 && pending[2] === 65) {
        selected = 1;
        process.stdout.write('\x1b[36mFirst selected\x1b[0m\r\n');
      }
      pending = pending.subarray(3);
      render();
      continue;
    }
    pending = pending.subarray(1);
    if (first !== 13 && first !== 10) continue;
    submissions += 1;
    render();
  }
});
process.stdout.on('resize', render);
process.on('SIGWINCH', render);
setTimeout(render, 250);
`;
}

export async function fakeConversationAgent(
    userDataDirectory: string,
    conversationMenuStatePath?: string,
    codexMenuStatePath?: string,
    inputCapturePath?: string,
) {
    return createFakeAgentMode({
        userDataDir: userDataDirectory,
        providers: {
            claude: {
                executableSource: String.raw`#!${process.execPath}
// Bind a synthetic Claude session for isolated Acceptance and write only its temporary state.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) {
  process.stdout.write('2.1.251 (Claude Code)\n');
  process.exit(0);
}
// Mobile rename forwards to Desktop's rename, which renames the provider Session through non-interactive /rename.
const resumeIndex = process.argv.indexOf('--resume');
const renameCommand = process.argv.at(-1) ?? '';
if (resumeIndex >= 0 && renameCommand.startsWith('/rename ')) {
  process.stdout.write(JSON.stringify({
    is_error: false,
    result: 'Session renamed to: ' + renameCommand.slice('/rename '.length),
    session_id: process.argv[resumeIndex + 1],
    subtype: 'success',
    type: 'result',
  }));
  process.exit(0);
}
const now = Date.now();
const sessionId = 'mobile-conversation-fixture-' + randomUUID();
const sessions = path.join(process.env.CLAUDE_CONFIG_DIR, 'sessions');
const sessionStatePath = path.join(sessions, sessionId + '.json');
const transcriptDirectory = path.join(
  process.env.CLAUDE_CONFIG_DIR,
  'projects',
  process.cwd().replace(/[^a-z0-9]/gi, '-'),
);
fs.mkdirSync(sessions, { recursive: true });
fs.mkdirSync(transcriptDirectory, { recursive: true });
fs.writeFileSync(path.join(transcriptDirectory, sessionId + '.jsonl'), '', { flag: 'wx' });
const writeSessionState = (status) => {
  fs.writeFileSync(sessionStatePath + '.next', JSON.stringify({
    cwd: process.cwd(),
    name: 'Synthetic Conversation',
    sessionId,
    startedAt: now,
    status,
    updatedAt: Date.now(),
  }));
  fs.renameSync(sessionStatePath + '.next', sessionStatePath);
};
writeSessionState('busy');
process.stdin.setRawMode?.(true);
${
    inputCapturePath
        ? `process.stdin.on('data', (chunk) => fs.appendFileSync(${JSON.stringify(inputCapturePath)}, chunk));`
        : ''
}
${
    conversationMenuStatePath
        ? `${syntheticMenuControllerSource(conversationMenuStatePath)}
process.on('SIGINT', () => {
  interrupts += 1;
  writeSessionState('idle');
  activateMenu();
});`
        : `
process.stdin.on('data', (chunk) => {
  if (chunk.includes(3)) process.exit(130);
});`
}
process.stdin.resume();
process.stdout.write('Synthetic Conversation ready\r\n');
${conversationMenuStatePath ? 'render();' : ''}
`,
            },
            ...(codexMenuStatePath && {
                codex: {
                    executableSource: String.raw`#!${process.execPath}
// Render a synthetic menu for isolated Acceptance and write only its temporary selection state.
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('codex-cli 0.151.0\n');
  process.exit(0);
}
if (process.argv.includes('app-server')) process.exit(0);
process.stdin.setRawMode?.(true);
${syntheticMenuControllerSource(codexMenuStatePath)}
process.stdin.resume();
activateMenu();
`,
                },
            }),
        },
    });
}
