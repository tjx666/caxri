/**
 * Negative fixture proving the `child_process` `exec`/`execSync` import ban configured in `eslint.config.ts` is wired
 * up; see `scripts/__tests__/eslint-toolchain-contract.test.ts`. Structured argv `spawn`/`execFile` stays allowed; this
 * file exists solely to trip `no-restricted-imports` and is not imported by any production or test module.
 */
import { execSync } from 'node:child_process';

export function runShellStringFixture(): string {
    return execSync('echo caxri').toString();
}
