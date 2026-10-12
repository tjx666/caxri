import {
    MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS,
    MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH,
    MAX_AGENT_OUTPUT_RECOVERY_PATTERNS,
    MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS,
} from '@caxri/protocol';

import type { Translate } from '../../i18n';

export type RecoveryPatternParseResult =
    { ok: true; patterns: string[] } | { ok: false; error: string };

export function parseRecoveryPatterns(t: Translate, source: string): RecoveryPatternParseResult {
    const patterns: string[] = [];
    const seen = new Set<string>();
    for (const line of source.split('\n')) {
        const pattern = line.trim();
        if (!pattern) continue;
        if (pattern.length > MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH)
            return {
                ok: false,
                error: t('settings.providerRecovery.patternTooLong', {
                    max: MAX_AGENT_OUTPUT_RECOVERY_PATTERN_LENGTH,
                }),
            };
        const normalized = pattern.toLocaleLowerCase();
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        patterns.push(pattern);
    }
    if (patterns.length > MAX_AGENT_OUTPUT_RECOVERY_PATTERNS)
        return {
            ok: false,
            error: t('settings.providerRecovery.tooManyPatterns', {
                max: MAX_AGENT_OUTPUT_RECOVERY_PATTERNS,
            }),
        };
    return { ok: true, patterns };
}

export function parseRecoveryDelay(source: string): number | undefined {
    const value = Number(source);
    return Number.isSafeInteger(value) &&
        value >= MIN_AGENT_OUTPUT_RECOVERY_DELAY_MS &&
        value <= MAX_AGENT_OUTPUT_RECOVERY_DELAY_MS
        ? value
        : undefined;
}
