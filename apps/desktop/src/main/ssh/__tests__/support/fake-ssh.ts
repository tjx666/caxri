import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';

/**
 * A stand-in for `/usr/bin/ssh` that understands the subset of OpenSSH's command line `SshConnection` uses. It runs as
 * a Node script so tests need no SSH server:
 *
 * - `-M`: the ControlMaster. `FAKE_SSH_MODE` selects its behaviour: `ok` listens on the ControlPath socket, `auth`,
 *   `hostkey`, and `unreachable` print OpenSSH's message and exit 255, `hang` never becomes ready, `die` becomes ready
 *   and then exits 255 after `FAKE_SSH_DIE_MS`, and `askpass` runs `$SSH_ASKPASS` first and fails authentication unless
 *   the answer is `open sesame`.
 * - `-O check|exit|forward|cancel`: control requests; `forward` fails `FAKE_SSH_FORWARD_FAILURES` times first.
 * - Anything else: a mux client; the last argument runs with `/bin/sh -c`, as sshd would run it.
 *
 * Every invocation's argv is appended to `$FAKE_SSH_STATE/calls.jsonl`.
 */
const FAKE_SSH_SOURCE = String.raw`
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
const state = process.env.FAKE_SSH_STATE;
fs.appendFileSync(path.join(state, 'calls.jsonl'), JSON.stringify(args) + '\n');
const option = (name) => {
    for (let i = 0; i < args.length - 1; i += 1)
        if (args[i] === '-o' && args[i + 1].startsWith(name + '=')) return args[i + 1].slice(name.length + 1);
    return undefined;
};
const controlPath = option('ControlPath');
const pidFile = path.join(state, 'master.pid');
const control = args.includes('-O') ? args[args.indexOf('-O') + 1] : undefined;
const fail = (message) => {
    process.stderr.write(message + '\n');
    process.exit(255);
};
if (args.includes('-M')) {
    const mode = process.env.FAKE_SSH_MODE || 'ok';
    process.stderr.write('debug noise\n');
    if (mode === 'auth') fail('dev@lab: Permission denied (publickey,password).');
    if (mode === 'hostkey') fail('Host key verification failed.');
    if (mode === 'unreachable') fail('ssh: Could not resolve hostname nowhere: nodename nor servname provided, or not known');
    if (mode === 'hang') setInterval(() => {}, 1000);
    else {
        if (mode === 'askpass') {
            let answer = '';
            try {
                answer = execFileSync(process.env.SSH_ASKPASS, ["dev@lab's password: "], { encoding: 'utf8' });
            } catch {}
            if (answer !== 'open sesame\n') fail('dev@lab: Permission denied (password).');
        }
        fs.writeFileSync(pidFile, String(process.pid));
        const server = net.createServer((socket) => socket.end());
        server.listen(controlPath);
        const stop = () => server.close(() => process.exit(0));
        process.on('SIGTERM', stop);
        if (mode === 'die')
            setTimeout(() => {
                server.close();
                fail('Connection to lab closed by remote host.');
            }, Number(process.env.FAKE_SSH_DIE_MS || 300));
    }
} else if (control === 'check') {
    process.exit(fs.existsSync(controlPath) && fs.existsSync(pidFile) ? 0 : 255);
} else if (control === 'exit') {
    try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGTERM');
    } catch {}
    process.exit(0);
} else if (control === 'forward') {
    const counter = path.join(state, 'forward-failures');
    const remaining = Number(fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8') : process.env.FAKE_SSH_FORWARD_FAILURES || 0);
    if (remaining > 0) {
        fs.writeFileSync(counter, String(remaining - 1));
        fail('mux_client_forward: forwarding request failed: Port forwarding failed');
    }
    process.exit(0);
} else if (control === 'cancel') {
    process.exit(0);
} else {
    if (!fs.existsSync(pidFile)) fail('Control socket connect: No such file or directory');
    const child = spawn('/bin/sh', ['-c', args.at(-1)], { stdio: 'inherit' });
    child.on('close', (code) => process.exit(code ?? 255));
}
`;

/**
 * Writes the fake `ssh` executable into a directory and returns its path.
 */
export async function writeFakeSsh(directory: string): Promise<string> {
    const path = join(directory, 'ssh');
    await writeFile(path, `#!${process.execPath}\n${FAKE_SSH_SOURCE}`);
    await chmod(path, 0o755);
    return path;
}
