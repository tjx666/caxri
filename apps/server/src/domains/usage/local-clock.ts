import { CaxriError } from '@caxri/protocol';

/**
 * One formatter per time zone, reused across reports; a Client sends the same zone on every poll.
 */
const localHourFormats = new Map<string, Intl.DateTimeFormat>();

function localHourFormat(timeZone: string): Intl.DateTimeFormat {
    const cached = localHourFormats.get(timeZone);
    if (cached) return cached;
    let format: Intl.DateTimeFormat;
    try {
        format = new Intl.DateTimeFormat('en-CA', {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            hourCycle: 'h23',
        });
    } catch {
        throw new CaxriError('VALIDATION', 'Unknown time zone');
    }
    // Only valid zones are cached, and there are a few hundred of them, so the map stays bounded.
    localHourFormats.set(timeZone, format);
    return format;
}

/**
 * Maps epoch milliseconds to the Client's local calendar date and hour. Formatting is the expensive part, and usage is
 * bucketed by hour, so results are memoized per hour.
 */
export class LocalClock {
    private readonly format: Intl.DateTimeFormat;
    private readonly hours = new Map<number, { date: string; hour: number }>();

    constructor(timeZone: string) {
        this.format = localHourFormat(timeZone);
    }

    at(epochMs: number): { date: string; hour: number } {
        const hourKey = Math.floor(epochMs / 3_600_000);
        const cached = this.hours.get(hourKey);
        if (cached) return cached;
        const parts = Object.fromEntries(
            this.format.formatToParts(epochMs).map((part) => [part.type, part.value]),
        );
        const local = {
            date: `${parts.year}-${parts.month}-${parts.day}`,
            hour: Number(parts.hour) % 24,
        };
        this.hours.set(hourKey, local);
        return local;
    }
}
