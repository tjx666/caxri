import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);

export const PROJECT_ROOT = resolve(dirname(SCRIPT_PATH), '../../../..');
export const RECORDS_ROOT = join(PROJECT_ROOT, '.records');
