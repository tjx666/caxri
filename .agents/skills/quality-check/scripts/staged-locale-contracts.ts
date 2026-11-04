/**
 * Pre-commit entry point: runs the i18n contract tests when the Git index touches a locale source. It reuses the
 * selector `check --test` uses, so the hook and the changed-file checker never disagree about which tests a locale edit
 * needs. A zh-CN Settings string that kept the English word "Chat" passed the commit hook and failed first in CI's
 * sharded unit suite.
 */
import { execFile, spawn } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

import { localeContractTestCandidates } from './contract-test-candidates';

const execFileAsync = promisify(execFile);

const { stdout } = await execFileAsync('git', [
    'diff',
    '--cached',
    '--name-only',
    '--diff-filter=ACMRD',
    '-z',
]);
const tests = localeContractTestCandidates(stdout.split('\0').filter(Boolean), []);
if (tests.length > 0) {
    const child = spawn('bunx', ['vitest', 'run', '--silent=passed-only', ...tests], {
        stdio: 'inherit',
    });
    child.on('exit', (code) => {
        process.exitCode = code ?? 1;
    });
}
