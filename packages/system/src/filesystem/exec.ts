import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/**
 * Promisified `execFile` shared by Main and Runtime call sites so each module avoids re-declaring the
 * `promisify(execFile)` boilerplate.
 */
export const execFileAsync = promisify(execFile);
