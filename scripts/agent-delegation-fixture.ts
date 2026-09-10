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
const { createHash } = require('node:crypto');
if (process.argv.includes('--version')) { console.log('2.1.266 (Claude Code)'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
const index = process.argv.indexOf('--session-id');
if (index < 0) { process.stdout.write('Synthetic caller ready\r\n'); }
else {
  // Native Claude queries terminal attributes before submitting its first task.
  process.stdout.write('\u001b[c');
  const sessionId = process.argv[index + 1];
  const prompt = process.argv.at(-1);
  const hash = value => createHash('sha256').update(value).digest('hex');
  const signal = (phase, evidence) => new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.CAXRI_HOOK_SOCKET);
    socket.on('error', reject);
    socket.on('data', () => { socket.end(); resolve(); });
    socket.on('connect', () => socket.end(JSON.stringify({
      protocolVersion: 1, provider: 'claude', phase,
      schemaVersion: Number(process.env.CAXRI_HOOK_SCHEMA_CLAUDE),
      terminalId: process.env.CAXRI_HOOK_TERMINAL_ID,
      launchId: process.env.CAXRI_HOOK_LAUNCH_ID,
      token: process.env.CAXRI_HOOK_TOKEN,
      agentSessionId: sessionId, agentTurnId: 'synthetic-turn',
      ...evidence,
    }) + '\n'));
  });
  setTimeout(async () => {
    try {
      if (process.env.CAXRI_HOOK_DIGEST !== '1') throw new Error('Missing delegation evidence mode');
      await signal('turnStarted', { agentPromptDigest: hash(prompt) });
      process.stdout.write('Synthetic delegated task running\r\n');
      const transcriptRoot = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-z0-9]/gi, '-'));
      fs.mkdirSync(transcriptRoot, { recursive: true });
      const records = [
        { type: 'user', uuid: 'synthetic-prompt', parentUuid: null, message: { content: prompt } },
        { type: 'attachment', uuid: 'synthetic-attachment', parentUuid: 'synthetic-prompt' },
        { type: 'assistant', uuid: 'synthetic-answer', parentUuid: 'synthetic-attachment', message: { content: 'Synthetic delegation complete' } },
      ];
      fs.writeFileSync(path.join(transcriptRoot, sessionId + '.jsonl'), records.map(record => JSON.stringify({ ...record, sessionId })).join('\n') + '\n');
      await signal('turnFinished', { agentResponseDigest: hash('Synthetic delegation complete') });
      process.stdout.write('Synthetic delegation complete\r\n');
    } catch { process.stdout.write('Synthetic fixture failed\r\n'); process.exit(1); }
  }, 1000);
}
`;
}
