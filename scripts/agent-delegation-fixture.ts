import process from 'node:process';

/**
 * Synthetic provider shared by desktop regression and Acceptance; writes only isolated task data.
 */
export function delegationFixtureSource(): string {
    return String.raw`#!${process.execPath}
// 合成可见委派夹具，仅写隔离的 provider 会话记录。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('2.1.266 (Claude Code)'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
const isResume = process.argv.includes('--resume');
const index = process.argv.indexOf(isResume ? '--resume' : '--session-id');
if (index < 0) { process.stdout.write('Synthetic caller ready\r\n'); }
else {
  // Native Claude queries terminal attributes before submitting its first task.
  process.stdout.write('\u001b[c');
  const sessionId = process.argv[index + 1];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const signal = (turnId, phase, evidence) => new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.CAXRI_HOOK_SOCKET);
    socket.on('error', reject);
    socket.on('data', () => { socket.end(); resolve(); });
    socket.on('connect', () => socket.end(JSON.stringify({
      protocolVersion: 1, provider: 'claude', phase,
      schemaVersion: Number(process.env.CAXRI_HOOK_SCHEMA_CLAUDE),
      terminalId: process.env.CAXRI_HOOK_TERMINAL_ID,
      launchId: process.env.CAXRI_HOOK_LAUNCH_ID,
      token: process.env.CAXRI_HOOK_TOKEN,
      agentSessionId: sessionId, agentTurnId: turnId,
      ...evidence,
    }) + '\n'));
  });
  let sequence = 0;
  let input = '';
  let cancellation = 0;
  const run = async prompt => {
    try {
      const epoch = cancellation;
      const turnId = randomUUID();
      const answer = isResume ? 'Synthetic resume complete' : sequence++ === 0 ? 'Synthetic delegation complete' : 'Synthetic follow-up complete';
      if (process.env.CAXRI_HOOK_DIGEST !== '1') throw new Error('Missing delegation evidence mode');
      await signal(turnId, 'turnStarted', { agentPromptDigest: hash(prompt) });
      process.stdout.write('Synthetic delegated task running\r\n');
      await new Promise(resolve => setTimeout(resolve, 300));
      if (epoch !== cancellation) return;
      const transcriptRoot = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-z0-9]/gi, '-'));
      fs.mkdirSync(transcriptRoot, { recursive: true });
      const records = [
        { type: 'user', uuid: turnId, parentUuid: null, message: { content: prompt } },
        { type: 'attachment', uuid: turnId + '-attachment', parentUuid: turnId },
        { type: 'assistant', uuid: turnId + '-answer', parentUuid: turnId + '-attachment', message: { content: answer } },
      ];
      fs.appendFileSync(path.join(transcriptRoot, sessionId + '.jsonl'), records.map(record => JSON.stringify({ ...record, sessionId })).join('\n') + '\n');
      await signal(turnId, 'turnFinished', { agentResponseDigest: hash(answer) });
      process.stdout.write(answer + '\r\n');
    } catch { process.stdout.write('Synthetic fixture failed\r\n'); process.exit(1); }
  };
  process.stdin.on('data', chunk => {
    const text = chunk.toString();
    if (text === '\u001b') { cancellation++; input = ''; return; }
    input += text;
    const start = input.indexOf('\u001b[200~');
    const end = input.indexOf('\u001b[201~\r', start);
    if (start >= 0 && end >= 0) {
      const prompt = input.slice(start + 6, end);
      input = input.slice(end + 7);
      void run(prompt);
    } else if (input.length > 32768) input = '';
  });
  setTimeout(() => void run(process.argv.at(-1)), 1000);
}
`;
}
