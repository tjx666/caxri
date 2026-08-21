import process from 'node:process';

import { runChildProcess } from './exec';

const ZERO_SHA = /^0+$/;

export function createDoctorCommand(environment: NodeJS.ProcessEnv): string[] {
    const requestedBase = environment.CAXRI_REACT_DOCTOR_BASE?.trim();

    /**
     * GitHub reports an all-zero `before` SHA for an initial branch push, which has no diff base.
     */
    if (requestedBase && ZERO_SHA.test(requestedBase)) return ['run', 'doctor'];

    // Intentional `||`: a whitespace-only trimmed env var must also fall back to the default
    // base, not be kept as `''`.
    // oxlint-disable-next-line typescript/prefer-nullish-coalescing -- see comment above
    const base = requestedBase || 'origin/main';
    return ['run', 'doctor', '--', '--scope', 'changed', '--base', base];
}

async function runDoctor(): Promise<number> {
    return runChildProcess(
        'bun',
        createDoctorCommand(process.env),
        { stdio: 'inherit' },
        { nullExitCode: 1 },
    );
}

if (import.meta.main) process.exitCode = await runDoctor();
