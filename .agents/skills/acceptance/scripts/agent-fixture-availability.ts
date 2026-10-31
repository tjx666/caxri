import { lstat, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { writeJsonAtomic } from '../../../../scripts/atomic-json';

/**
 * Which providers the `agent-features-v1` fixture reports as available, kept beneath its owned profile so a case can
 * take Codex away and give it back without touching the fixture executables.
 */
const AGENT_FEATURES_AVAILABILITY = 'provider-availability.json';
const agentFeaturesAvailabilitySchema = z.strictObject({
    fixtureId: z.literal('agent-features-v1'),
    schemaVersion: z.literal(1),
    unavailableProviders: z.array(z.literal('codex')).max(1),
});
const agentFeaturesAvailabilityUpdateSchema = z.strictObject({
    available: z.boolean(),
    fixtureId: z.literal('agent-features-v1'),
    provider: z.literal('codex'),
    userDataDir: z.string().min(1),
});

export async function readAgentFeaturesAvailability(
    root: string,
): Promise<z.infer<typeof agentFeaturesAvailabilitySchema>> {
    const target = join(root, AGENT_FEATURES_AVAILABILITY);
    try {
        const metadata = await lstat(target);
        if (metadata.isSymbolicLink() || !metadata.isFile()) {
            throw new Error('Acceptance Agent provider availability must be a direct regular file');
        }
        return agentFeaturesAvailabilitySchema.parse(JSON.parse(await readFile(target, 'utf8')));
    } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return {
            fixtureId: 'agent-features-v1',
            schemaVersion: 1,
            unavailableProviders: [],
        };
    }
}

/**
 * Changes one fixed provider availability flag beneath an owned Agent fixture profile. The closed input and strict
 * state schema prevent Acceptance runners from injecting executables, paths, source, or environment values.
 */
export async function setAcceptanceAgentFixtureProviderAvailability(options: {
    available: boolean;
    fixtureId: string;
    provider: string;
    userDataDir: string;
}): Promise<void> {
    const update = agentFeaturesAvailabilityUpdateSchema.parse(options);
    const root = join(update.userDataDir, 'acceptance-agents');
    await mkdir(root, { recursive: true });
    const current = await readAgentFeaturesAvailability(root);
    const unavailableProviders = update.available ? [] : (['codex'] as const);
    if (JSON.stringify(current.unavailableProviders) === JSON.stringify(unavailableProviders))
        return;
    const target = join(root, AGENT_FEATURES_AVAILABILITY);
    await writeJsonAtomic(
        target,
        {
            fixtureId: 'agent-features-v1',
            schemaVersion: 1,
            unavailableProviders,
        },
        { mode: 0o600 },
    );
}
