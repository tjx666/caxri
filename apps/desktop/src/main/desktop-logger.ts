import { StructuredLogger } from '@caxri/system';

import { resolveLogLevel } from './log-level';

export function createDesktopLogger(logDirectory: string, isPackaged: boolean): StructuredLogger {
    return new StructuredLogger(logDirectory, 'desktop', resolveLogLevel({ isPackaged }));
}
