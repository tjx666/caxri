import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promisified `execFile` shared by repository scripts so each tool avoids re-declaring the `promisify(execFile)`
 * boilerplate. Scripts stay independent of `src/`, so this intentionally mirrors `src/shared/node/exec.ts`.
 */
export const execFileAsync = promisify(execFile);
