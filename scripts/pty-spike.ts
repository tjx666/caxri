import { tmpdir } from 'node:os';
import process from 'node:process';
import { clearTimeout, setTimeout } from 'node:timers';

import { didRelaunchInElectron } from './run-in-electron.ts';

interface ProbeResult {
    exitCode: number;
    marker: string;
    shell: string;
}

if (!(await didRelaunchInElectron(import.meta.url))) {
    const [{ app }, pty] = await Promise.all([import('electron'), import('node-pty')]);
    const shell = process.env.SHELL || '/bin/zsh';
    const terminal = pty.spawn(shell, ['-l'], {
        cols: 80,
        cwd: tmpdir(),
        env: { ...process.env, TERM: 'xterm-256color' },
        name: 'xterm-256color',
        rows: 24,
    });
    let isExited = false;

    try {
        const result = await new Promise<ProbeResult>((resolve, reject) => {
            let output = '';
            let isExitSent = false;
            const timer = setTimeout(() => {
                terminal.kill();
                reject(new Error(`PTY spike timed out. Output: ${JSON.stringify(output)}`));
            }, 10_000);

            terminal.onData((data) => {
                output += data;
                if (!isExitSent && output.includes('CAXRI_PTY_OK')) {
                    isExitSent = true;
                    terminal.write('exit\r');
                }
            });

            terminal.onExit(({ exitCode }) => {
                isExited = true;
                clearTimeout(timer);
                if (exitCode !== 0 || !output.includes('CAXRI_PTY_OK')) {
                    reject(
                        new Error(`PTY spike failed with ${exitCode}: ${JSON.stringify(output)}`),
                    );
                    return;
                }
                resolve({ exitCode, marker: 'CAXRI_PTY_OK', shell });
            });

            terminal.write("printf 'CAXRI_PTY_OK\\n'\r");
        });

        process.stdout.write(`${JSON.stringify(result)}\n`);
    } finally {
        if (!isExited) terminal.kill();
        app.quit();
    }
}
