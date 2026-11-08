declare const error: Error;
declare const stderr: string;
declare const logger: { write(level: string, event: string, options: object): void };
declare function errorMessage(error: unknown, fallback: string): string;
declare function errorLogFields(error: unknown): Record<string, number | string>;
declare function log(outcome: string, detail?: Record<string, number | string>): void;

logger.write('warn', 'event', { fields: { error: error.message } });
logger.write('warn', 'event', { fields: { error: errorMessage(error, 'unknown') } });
logger.write('warn', 'event', {
    fields: { error: error instanceof Error ? error.message : String(error) },
});
logger.write('warn', 'event', { fields: { detail: stderr.slice(0, 80) } });
logger.write('warn', 'event', { fields: { detail: `failed: ${error.message}` } });
log('failed', { error: error.message });

logger.write('warn', 'event', { fields: { ...errorLogFields(error), id: 1 } });
logger.write('warn', 'event', { fields: { messageLength: error.message.length } });
logger.write('warn', 'event', { fields: { reason: 'closed' } });
const returned = { error: error.message };
export const unlogged = [returned, errorMessage(error, 'unknown')];
logger.write('warn', 'event', { fields: { stack: error.stack } });
const detail = errorMessage(error, 'unknown');
logger.write('warn', 'event', { fields: { error: detail } });
let failed: string | undefined;
failed = error.message;
logger.write('warn', 'event', { fields: { ...(failed && { error: failed }) } });
const closed = 'timeout';
logger.write('warn', 'event', { fields: { reason: closed } });
declare function parse(text: string): { outcome: string };
const { outcome } = parse(stderr);
logger.write('warn', 'event', { fields: { outcome } });
