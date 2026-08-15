/**
 * Negative fixture proving the `shell: true` spawn-option ban configured in `eslint.config.ts` is wired up; see
 * `scripts/__tests__/eslint-toolchain-contract.test.ts`. Structured argv `spawn` without `shell: true` stays allowed;
 * this file exists solely to trip `no-restricted-syntax` and is not imported by any production or test module.
 */
import { spawn } from 'node:child_process';

export function spawnWithShellStringFixture(): void {
    spawn('echo', ['caxri'], { shell: true });
}
