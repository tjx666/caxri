import process from 'node:process';

/**
 * Fixed synthetic TUI for Grok acceptance; no host provider discovery or model calls.
 */
export function grokAcceptanceSource(): string {
    return String.raw`#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
if (process.argv.includes('--version')) { process.stdout.write('grok 1.0.24\n'); process.exit(0); }
const home = process.env.GROK_HOME;
const resume = process.argv.indexOf('--resume');
let sessionId = process.argv[(resume >= 0 ? resume : process.argv.indexOf('--session-id')) + 1];
let promptId = crypto.randomUUID();
let state = resume >= 0 ? 'Original conversation restored' : 'Ready';
const receipt = value => fs.appendFileSync(path.join(home, 'acceptance-receipts.jsonl'), JSON.stringify(value) + '\n');
function hook(event, extra = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(home, 'hooks', 'caxri.json'), 'utf8'));
  for (const group of config.hooks[event] ?? []) for (const entry of group.hooks)
    cp.execFileSync('/bin/sh', ['-c', entry.command], { input: JSON.stringify({ sessionId, promptId, cwd: process.cwd(), ...extra }),
      env: { ...process.env, GROK_SESSION_ID: sessionId }, stdio: ['pipe', 'ignore', 'ignore'] });
}
function identify(source) {
  const folder = path.join(home, 'sessions', encodeURIComponent(fs.realpathSync(process.cwd())), sessionId);
  fs.mkdirSync(folder, { recursive: true }); fs.writeFileSync(path.join(folder, 'summary.json'), '{}');
  hook('SessionStart', { source }); receipt({ kind: 'identity', sessionId, resumed: source === 'load' });
}
function render() {
  const columns = process.stdout.columns || 80, rows = process.stdout.rows || 24;
  const generation = sessionId + ':' + columns + ':' + rows;
  const labels = ['Synthetic Grok Build', state, 'fixture:start / fixture:finish / fixture:fail / fixture:new'];
  const lines = Array.from({ length: rows }, (_, index) => '│' + (labels[index] || '').slice(0, columns - 2).padEnd(columns - 2) + '│');
  fs.writeFileSync(path.join(home, 'acceptance-grid.json'), JSON.stringify({ columns, rows, generation, firstGridMarker: { columns, rows, generation }, lines }));
  process.stdout.write('\u001b[?7l\u001b[2J' + lines.map((line, index) => '\u001b[' + (index + 1) + ';1H' + line).join(''));
}
identify(resume >= 0 ? 'load' : 'new');
let input = '';
process.stdin.setRawMode?.(true); process.stdin.resume();
process.stdin.on('data', chunk => {
  for (const character of chunk.toString()) {
    if (character !== '\r' && character !== '\n') { input += character; continue; }
    const command = input.trim(); input = '';
    if (command === 'fixture:new') { sessionId = crypto.randomUUID(); identify('new'); state = 'New conversation'; }
    else if (command === 'fixture:start') { promptId = crypto.randomUUID(); hook('UserPromptSubmit'); state = 'Running'; }
    else if (command === 'fixture:finish') { hook('Stop', { reason: 'end_turn' }); state = 'Completed'; }
    else if (command === 'fixture:fail') { hook('StopFailure', { reason: 'api_error' }); state = 'API failed'; }
    else if (command === 'fixture:shutdown') hook('Stop', { reason: 'shutdown', promptId: undefined });
    else if (command === 'fixture:exit') process.exit(0);
    render();
  }
});
process.stdout.on('resize', render);
render();
`;
}
