/**
 * Values shorter than this are left alone: a 3-character "secret" matches ordinary words and numbers, so masking it
 * would garble real output without protecting anything. Four characters is the floor for PIN-sized secrets.
 */
const MIN_MASKED_SECRET_LENGTH = 4;

export interface SecretOutputMasker {
    /**
     * Feeds decoded text and returns what is safe to print now; a possible value prefix stays held back.
     */
    push(text: string): string;
    /**
     * True while a possible value prefix is held back, so the caller can schedule a `flush` if output stalls.
     */
    pending(): boolean;
    /**
     * Releases whatever is held back, unmasked, because it can no longer complete a value.
     */
    flush(): string;
}

/**
 * Builds a streaming masker for one output stream. It replaces each resolved value with `[secret:NAME]`, matching
 * across chunk boundaries by holding back only the longest tail that is still a proper prefix of some value. Longer
 * values win over shorter ones that they contain. Values are matched verbatim; an encoded or re-formatted copy (base64,
 * JSON escapes) is out of scope.
 */
export function createSecretOutputMasker(
    values: Readonly<Record<string, string>>,
): SecretOutputMasker {
    const entries = Object.entries(values)
        .filter(([, value]) => value.length >= MIN_MASKED_SECRET_LENGTH)
        .toSorted(([, a], [, b]) => b.length - a.length);
    let held = '';

    return {
        push(text) {
            if (entries.length === 0) return text;
            const input = held + text;
            let output = '';
            let index = 0;
            held = '';
            while (index < input.length) {
                // Hold before matching: a shorter value may be only the start of a longer one.
                const rest = input.slice(index);
                if (
                    entries.some(
                        ([, value]) => value.length > rest.length && value.startsWith(rest),
                    )
                ) {
                    held = rest;
                    break;
                }
                const match = entries.find(([, value]) => input.startsWith(value, index));
                if (match) {
                    output += `[secret:${match[0]}]`;
                    index += match[1].length;
                    continue;
                }
                output += input[index];
                index += 1;
            }
            return output;
        },
        pending: () => held.length > 0,
        flush() {
            const rest = held;
            held = '';
            return rest;
        },
    };
}
