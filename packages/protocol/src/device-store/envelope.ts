import { z } from 'zod';

/**
 * One saved entry as its reader sees it: when it was written and the validated value.
 */
export interface DeviceStoreEntry<Value> {
    savedAt: number;
    value: Value;
}

const envelopeSchema = z.strictObject({
    version: z.number().int().nonnegative(),
    /**
     * The identity the value was read or typed under: a pairing on the phone, a Server environment on the Desktop.
     * Never a credential or key.
     */
    scope: z.string().min(1),
    savedAt: z.number().int().nonnegative(),
    value: z.unknown(),
});

export const encodeDeviceStoreEntry = (
    version: number,
    scope: string,
    savedAt: number,
    value: unknown,
): string => JSON.stringify({ version, scope, savedAt, value });

/**
 * An entry written by this format version under `scope`, or `null` for a corrupt, foreign, or other-version entry.
 * Another version is dropped rather than migrated: every entry is a best-effort copy its owner can do without.
 */
export const decodeDeviceStoreEntry = <Value>(
    text: string,
    version: number,
    scope: string,
    valueSchema: z.ZodType<Value>,
): DeviceStoreEntry<Value> | null => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return null;
    }
    const envelope = envelopeSchema.safeParse(raw);
    if (!envelope.success || envelope.data.version !== version || envelope.data.scope !== scope)
        return null;
    const value = valueSchema.safeParse(envelope.data.value);
    return value.success ? { savedAt: envelope.data.savedAt, value: value.data } : null;
};
