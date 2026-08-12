import { spawn } from 'node:child_process';

const ZERO_SHA = /^0+$/;

export function createDoctorCommand(env: NodeJS.ProcessEnv): string[] {
    const requestedBase = env.CAXRI_REACT_DOCTOR_BASE?.trim();

    /** GitHub reports an all-zero `before` SHA for an initial branch push, which has no diff base. */
    if (requestedBase && ZERO_SHA.test(requestedBase)) return ['run', 'doctor'];

    const base = requestedBase || 'origin/main';
    return ['run', 'doctor', '--', '--scope', 'changed', '--base', base];
}

async function runDoctor(): Promise<number> {
    return new Promise((resolve, reject) => {
        const child = spawn('bun', createDoctorCommand(process.env), { stdio: 'inherit' });
        child.once('error', reject);
        child.once('exit', (code) => resolve(code ?? 1));
    });
}

if (import.meta.main) process.exitCode = await runDoctor();
