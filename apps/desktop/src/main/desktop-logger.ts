import process from 'node:process';

import { resolveLogLevel } from '@caxri/protocol';
import { StructuredLogger } from '@caxri/system';

export function createDesktopLogger(logDirectory: string): StructuredLogger {
    return new StructuredLogger(logDirectory, 'desktop', resolveLogLevel(process.env));
}
