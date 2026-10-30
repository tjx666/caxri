import { z } from 'zod';

export const MAX_TERMINAL_REFERENCE_LINKS = 32;
const MAX_TERMINAL_REFERENCE_PREFIX_LENGTH = 64;
const MAX_TERMINAL_REFERENCE_TITLE_LENGTH = 100;
const MAX_TERMINAL_REFERENCE_URL_LENGTH = 2_048;
export const MAX_TERMINAL_REFERENCE_IDENTIFIER_LENGTH = 1_024;
export const TERMINAL_REFERENCE_NUMBER_PLACEHOLDER = '<num>';

/**
 * Keeps user-authored Terminal references declarative: untrusted output may only fill one bounded URL placeholder and
 * can never select a command, script, or IPC method.
 */
function isValidTerminalReferenceUrlTemplate(value: string): boolean {
    if (value.split(TERMINAL_REFERENCE_NUMBER_PLACEHOLDER).length !== 2) return false;
    try {
        const url = new URL(value.replaceAll(TERMINAL_REFERENCE_NUMBER_PLACEHOLDER, '123'));
        return (
            ['http:', 'https:'].includes(url.protocol) &&
            url.username.length === 0 &&
            url.password.length === 0
        );
    } catch {
        return false;
    }
}

export const terminalReferenceLinkRuleSchema = z.strictObject({
    alphanumeric: z.boolean().default(false),
    ignoreCase: z.boolean().default(false),
    prefix: z
        .string()
        .min(1)
        .max(MAX_TERMINAL_REFERENCE_PREFIX_LENGTH)
        .refine((value) => value === value.trim(), 'Prefix cannot start or end with whitespace'),
    title: z.string().min(1).max(MAX_TERMINAL_REFERENCE_TITLE_LENGTH).nullable().default(null),
    url: z
        .string()
        .min(1)
        .max(MAX_TERMINAL_REFERENCE_URL_LENGTH)
        .refine(isValidTerminalReferenceUrlTemplate, {
            message: 'Expected an HTTP(S) URL containing <num> and no credentials',
        }),
});

function overlappingRuleIndexes(
    rules: ReadonlyArray<z.infer<typeof terminalReferenceLinkRuleSchema>>,
): Set<number> {
    const canConsumePrefix = (
        shorter: z.infer<typeof terminalReferenceLinkRuleSchema>,
        longer: z.infer<typeof terminalReferenceLinkRuleSchema>,
    ): boolean => {
        const shared = longer.prefix.slice(0, shorter.prefix.length);
        const isSamePrefix =
            shorter.ignoreCase || longer.ignoreCase
                ? shared.toLowerCase() === shorter.prefix.toLowerCase()
                : shared === shorter.prefix;
        if (!isSamePrefix) return false;
        const suffix = longer.prefix.slice(shorter.prefix.length);
        if (!suffix) return true;
        return shorter.alphanumeric ? /^[a-z\d]+$/i.test(suffix) : /^[1-9]\d*$/.test(suffix);
    };
    const overlaps = new Set<number>();
    for (const [index, rule] of rules.entries())
        for (let candidateIndex = 0; candidateIndex < index; candidateIndex += 1) {
            const candidate = rules[candidateIndex];
            const [shorter, longer] =
                candidate.prefix.length <= rule.prefix.length
                    ? [candidate, rule]
                    : [rule, candidate];
            if (canConsumePrefix(shorter, longer)) {
                overlaps.add(candidateIndex);
                overlaps.add(index);
            }
        }
    return overlaps;
}

export const terminalReferenceLinksSchema = z
    .array(terminalReferenceLinkRuleSchema)
    .max(MAX_TERMINAL_REFERENCE_LINKS)
    .default([])
    .superRefine((rules, context) => {
        for (const index of overlappingRuleIndexes(rules))
            context.addIssue({
                code: 'custom',
                message: 'Reference prefixes must not overlap under their case-sensitivity rules',
                path: [index, 'prefix'],
            });
    });

export type TerminalReferenceLinkRule = z.infer<typeof terminalReferenceLinkRuleSchema>;
