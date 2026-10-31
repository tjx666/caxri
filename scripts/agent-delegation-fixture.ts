import process from 'node:process';

/**
 * Synthetic provider shared by desktop regression and Acceptance; writes only isolated task data.
 */
export function delegationFixtureSource(
    provider: 'antigravity' | 'claude' | 'codex' | 'grok' = 'claude',
): string {
    return String.raw`#!${process.execPath}
// 合成可见委派夹具，仅写隔离的 provider 会话记录。
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { createHash, randomUUID } = require('node:crypto');
const provider = ${JSON.stringify(provider)};
if (process.argv.includes('--version')) { console.log(provider === 'claude' ? '2.1.266 (Claude Code)' : provider === 'grok' ? 'grok 1.0.24' : provider === 'antigravity' ? '1.4.12' : 'codex-cli 0.153.4'); process.exit(0); }
// Renaming a Session also renames its Claude conversation through a one-shot "--resume <id> ... /rename <title>" call.
const renameCommand = process.argv.at(-1) ?? '';
if (provider === 'claude' && process.argv.includes('--resume') && renameCommand.startsWith('/rename ')) {
  process.stdout.write(JSON.stringify({ is_error: false, result: 'Session renamed to: ' + renameCommand.slice('/rename '.length), session_id: process.argv[process.argv.indexOf('--resume') + 1], subtype: 'success', type: 'result' }));
  process.exit(0);
}
process.stdin.setRawMode?.(true);
process.stdin.resume();
const resumeFlag = provider === 'codex' ? 'resume' : provider === 'antigravity' ? '--conversation' : '--resume';
const isResume = process.argv.includes(resumeFlag);
// agy chooses its own conversation id, so a delegated launch is recognized by the "-i <pointer>" prompt instead.
const index = process.argv.indexOf(isResume ? resumeFlag : provider === 'antigravity' ? '-i' : '--session-id');
if (provider !== 'codex' ? index < 0 : process.env.CAXRI_HOOK_DIGEST !== '1') { process.stdout.write('Synthetic caller ready\r\n'); }
else {
  // Native Claude queries terminal attributes before submitting its first task.
  process.stdout.write('\u001b[c');
  const timestamp = Date.now().toString(16).padStart(12, '0');
  const sessionId = provider === 'codex' && !isResume ? timestamp.slice(0,8) + '-' + timestamp.slice(8) + '-7' + randomUUID().slice(15) : provider === 'antigravity' && !isResume ? randomUUID() : process.argv[index + 1];
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
      if (provider === 'antigravity') return await runAntigravity(prompt, answer, epoch);
      if (provider === 'grok') await signal(undefined, 'sessionIdentified', {});
      await signal(turnId, 'turnStarted', { agentPromptDigest: hash(prompt) });
      process.stdout.write('Synthetic delegated task running\r\n');
      if (provider === 'codex') await signal(turnId, 'turnFinished', { agentResponseDigest: hash('Synthetic intermediate answer') });
      await new Promise(resolve => setTimeout(resolve, 300));
      if (epoch !== cancellation) return;
      const date = new Date(Number.parseInt(sessionId.slice(0,8) + sessionId.slice(9,13),16));
      const day = [String(date.getFullYear()), String(date.getMonth()+1).padStart(2,'0'), String(date.getDate()).padStart(2,'0')];
      const grokCwd = encodeURIComponent(process.cwd()).replace(/[!'()*]/g, value=>'%'+value.codePointAt(0).toString(16).toUpperCase());
      const transcriptRoot = provider === 'claude' ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', process.cwd().replace(/[^a-z0-9]/gi, '-')) : provider === 'grok' ? path.join(process.env.GROK_HOME,'sessions',grokCwd,sessionId) : path.join(process.env.CODEX_HOME, 'sessions', ...day);
      fs.mkdirSync(transcriptRoot, { recursive: true });
      if (provider === 'grok') fs.writeFileSync(path.join(transcriptRoot, 'summary.json'), JSON.stringify({sessionId}));
      const records = [
        { type: 'user', uuid: turnId, parentUuid: null, message: { content: prompt } },
        { type: 'attachment', uuid: turnId + '-attachment', parentUuid: turnId },
        { type: 'assistant', uuid: turnId + '-answer', parentUuid: turnId + '-attachment', message: { id: turnId + '-api-message', content: answer, usage: { input_tokens: 10, output_tokens: 5 } } },
      ];
      if (provider === 'codex' || provider === 'grok') await signal(turnId, 'turnFinished', { agentResponseDigest: hash(answer), ...(provider === 'grok' && { agentResponseByteLength: Buffer.byteLength(answer) }) });
      const fileName = provider === 'claude' ? sessionId + '.jsonl' : provider === 'grok' ? 'updates.jsonl' : 'rollout-' + day.join('-') + 'T12-00-00-' + sessionId + '.jsonl';
      const transcriptPath = path.join(transcriptRoot, fileName);
      const previousRows = provider === 'codex' && fs.existsSync(transcriptPath) ? fs.readFileSync(transcriptPath,'utf8').trim().split('\n').map(line=>JSON.parse(line)) : [];
      const previousUsage = previousRows.findLast(row=>row.payload?.type==='token_count')?.payload.info.total_token_usage;
      const totalUsage = {input_tokens:(previousUsage?.input_tokens??0)+10,output_tokens:(previousUsage?.output_tokens??0)+5};
      const rows = provider === 'claude' ? records.map(record => ({ ...record, sessionId })) : provider === 'grok' ? [
        {method:'session/update',params:{sessionId,update:{sessionUpdate:'user_message_chunk',content:{type:'text',text:prompt}}}},
        {method:'session/update',params:{sessionId,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:answer}}}},
        {method:'_x.ai/session/update',params:{sessionId,update:{sessionUpdate:'hook_execution',event_name:'stop',prompt_id:turnId,runs:[{name:'Synthetic hook',status:{status:'success',elapsed_ms:1}}]}}},
        {method:'_x.ai/session/update',params:{sessionId,update:{sessionUpdate:'turn_completed',prompt_id:turnId,stop_reason:'end_turn',usage:{inputTokens:10,outputTokens:5}}}},
      ] : [
        ...(previousRows.length===0?[{type:'session_meta',payload:{id:sessionId}}]:[]),
        {type:'event_msg',payload:{type:'task_started',turn_id:turnId}},
        {type:'event_msg',payload:{type:'token_count',info:{total_token_usage:totalUsage}}},
        {type:'event_msg',payload:{type:'task_complete',turn_id:turnId,last_agent_message:answer}},
      ];
      fs.appendFileSync(path.join(transcriptRoot, fileName), rows.map(record => JSON.stringify(record)).join('\n') + '\n');
      if (provider === 'claude') await signal(turnId, 'turnFinished', { agentResponseDigest: hash(answer) });
      process.stdout.write(answer + '\r\n');
    } catch { process.stdout.write('Synthetic fixture failed\r\n'); process.exit(1); }
  };
  // agy keeps each conversation as SQLite protobuf steps; only the fields Caxri reads are written. Its PreInvocation hook
  // names the turn after the conversation's step count, and its Stop hook names no turn.
  const runAntigravity = async (prompt, answer, epoch) => {
    const { DatabaseSync } = require('node:sqlite');
    const varint = value => { const bytes = []; while (value >= 0x80) { bytes.push((value % 0x80) | 0x80); value = Math.floor(value / 0x80); } bytes.push(value); return bytes; };
    const encode = fields => Buffer.from(fields.flatMap(([number, value]) => {
      if (typeof value === 'number') return [...varint(number * 8), ...varint(value)];
      const payload = typeof value === 'string' ? [...Buffer.from(value)] : [...encode(value)];
      return [...varint(number * 8 + 2), ...varint(payload.length), ...payload];
    }));
    const directory = path.join(process.env.HOME, '.gemini', 'antigravity-cli', 'conversations');
    fs.mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(path.join(directory, sessionId + '.db'));
    try {
      database.exec('CREATE TABLE IF NOT EXISTS trajectory_meta (trajectory_id text PRIMARY KEY, cascade_id text, trajectory_type integer, source integer); CREATE TABLE IF NOT EXISTS steps (idx integer PRIMARY KEY, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, metadata blob, step_payload blob); CREATE TABLE IF NOT EXISTS gen_metadata (idx integer PRIMARY KEY, data blob, size integer NOT NULL DEFAULT 0)');
      database.prepare('INSERT OR IGNORE INTO trajectory_meta VALUES (?, ?, 4, 17)').run(sessionId, sessionId);
      const steps = database.prepare('SELECT count(*) AS count FROM steps').get().count;
      const metadata = [[1, [[1, Math.floor(Date.now() / 1000)]]]];
      const step = database.prepare('INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, 3, ?, ?)');
      await signal('step-' + steps, 'turnStarted', { agentPromptDigest: hash(prompt) });
      step.run(steps, 14, encode(metadata), encode([[1, 14], [5, metadata], [19, [[1, prompt]]]]));
      process.stdout.write('Synthetic delegated task running\r\n');
      await new Promise(resolve => setTimeout(resolve, 300));
      if (epoch !== cancellation) return;
      step.run(steps + 1, 15, encode(metadata), encode([[1, 15], [5, metadata], [20, [[1, answer]]]]));
    } finally { database.close(); }
    await signal(undefined, 'turnFinished', {});
    process.stdout.write(answer + '\r\n');
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
