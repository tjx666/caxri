import process from 'node:process';

/**
 * Synthetic provider shared by desktop regression and Acceptance; writes only isolated task data.
 */
export function delegationFixtureSource(provider: 'claude' | 'codex' = 'claude'): string {
    return String.raw`#!${process.execPath}
// 合成可见委派夹具，仅写隔离的 provider 会话记录。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const provider = ${JSON.stringify(provider)};
if (process.argv.includes('--version')) { console.log(provider === 'claude' ? '2.1.266 (Claude Code)' : 'codex-cli 0.153.4'); process.exit(0); }
process.stdin.setRawMode?.(true);
process.stdin.resume();
const isResume = process.argv.includes(provider === 'claude' ? '--resume' : 'resume');
const index = process.argv.indexOf(isResume ? (provider === 'claude' ? '--resume' : 'resume') : '--session-id');
if (provider === 'claude' ? index < 0 : process.env.CAXRI_HOOK_DIGEST !== '1') { process.stdout.write('Synthetic caller ready\r\n'); }
else {
  // Native Claude queries terminal attributes before submitting its first task.
  process.stdout.write('\u001b[c');
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const sessionId = provider === 'codex' && !isResume ? timestamp.slice(0,8) + '-' + timestamp.slice(8) + '-7' + randomUUID().slice(15) : process.argv[index + 1];
  const hash = value => createHash('sha256').update(value).digest('hex');
  const signal = (turnId, phase, evidence) => new Promise((resolve, reject) => {
    const socket = net.createConnection(process.env.CAXRI_HOOK_SOCKET);
    socket.on('error', reject);
    socket.on('data', () => { socket.end(); resolve(); });
    socket.on('connect', () => socket.end(JSON.stringify({
      protocolVersion: 1, provider, phase,
      schemaVersion: Number(process.env['CAXRI_HOOK_SCHEMA_' + provider.toUpperCase()]),
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
      if (provider === 'codex') await signal(turnId, 'turnFinished', { agentResponseDigest: hash('Synthetic intermediate answer') });
      await new Promise(resolve => setTimeout(resolve, 300));
      if (epoch !== cancellation) return;
      const date = new Date(Number.parseInt(sessionId.slice(0,8) + sessionId.slice(9,13),16));
      const day = [String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')];
      const transcriptRoot = provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-z0-9]/gi, '-')) : path.join(process.env.CODEX_HOME, 'sessions', ...day);
      fs.mkdirSync(transcriptRoot, { recursive: true });
      const records = [
        { type: 'user', uuid: turnId, parentUuid: null, message: { content: prompt } },
        { type: 'attachment', uuid: turnId + '-attachment', parentUuid: turnId },
        { type: 'assistant', uuid: turnId + '-answer', parentUuid: turnId + '-attachment', message: { content: answer } },
      ];
      if (provider === 'codex') await signal(turnId, 'turnFinished', { agentResponseDigest: hash(answer) });
      const fileName = provider === 'claude' ? sessionId + '.jsonl' : 'rollout-' + day.join('-') + 'T12-00-00-' + sessionId + '.jsonl';
      const rows = provider === 'claude' ? records.map(record => ({ ...record, sessionId })) : [{type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:answer}}];
      fs.appendFileSync(path.join(transcriptRoot, fileName), rows.map(record => JSON.stringify(record)).join('\n') + '\n');
      if (provider === 'claude') await signal(turnId, 'turnFinished', { agentResponseDigest: hash(answer) });
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
