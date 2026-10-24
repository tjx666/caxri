import { join } from 'node:path';
import process from 'node:process';

import { resolveLogLevel } from '@caxri/protocol';
import { startEventLoopMonitor, StructuredLogger } from '@caxri/system';

import { requestActivity } from './request-activity';

/**
 * Fields for an event-loop stall record: how many requests were running and which methods ran or finished inside the
 * stall window. The probe fires late by `stallMs`, and one more probe interval covers a handler that returned just
 * before it. That is what tells a blocked loop (a handler held it) from a lane wait (the loop was free).
 */
function stallFields(stall: { stallMs: number }): Record<string, number | string> {
    const activity = requestActivity.summarize(stall.stallMs + 500);
    return {
        inFlightCount: activity.inFlightCount,
        ...(activity.inFlight && { inFlightRequests: activity.inFlight }),
        ...(activity.finished && { finishedRequests: activity.finished }),
    };
}

/**
 * Opens the Server Core logger (unless the caller supplied one) and starts its event-loop stall monitor, whose records
 * name the requests active during the stall.
 */
export function startServerObservability(options: {
    logger?: StructuredLogger;
    userDataPath: string;
}) {
    const logger =
        options.logger ??
        new StructuredLogger(
            join(options.userDataPath, 'logs'),
            'server-core',
            resolveLogLevel(process.env),
        );
    const eventLoopMonitor = startEventLoopMonitor(logger, { describeStall: stallFields });
    return { eventLoopMonitor, logger };
}
