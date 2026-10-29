import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { CaxriDatabase } from '../../../apps/server/src/domains/db';

/**
 * Two open questions Caxri Bot raised, each with one reply from the user: Caxri Bot already read the first reply and
 * has not read the second, so the cards show both read states.
 */
export function run(input: { userData: string }): { readId: string; unreadId: string } {
    const database = new CaxriDatabase(join(input.userData, 'caxri.db'));
    try {
        const now = Date.now();
        const readId = randomUUID();
        const unreadId = randomUUID();
        database.botInbox.insert(
            readId,
            'decision',
            undefined,
            {
                title: 'Keep the legacy export format?',
                body: 'The synthetic fixture still writes the old format. Removing it simplifies the exporter.',
                options: ['Keep it', 'Remove it'],
            },
            now - 120_000,
        );
        const sequence = database.botInbox.appendReply(
            readId,
            'Remove it.',
            'desktop',
            now - 90_000,
        );
        database.botInbox.acknowledge(readId, sequence, now - 60_000);
        database.botInbox.insert(
            unreadId,
            'hands',
            undefined,
            {
                title: 'Sign in to the synthetic registry',
                body: 'Publishing the fixture package needs a registry login only you can complete.',
                options: [],
            },
            now - 30_000,
        );
        database.botInbox.appendReply(unreadId, 'Signed in.', 'desktop', now - 10_000);
        return { readId, unreadId };
    } finally {
        database.close();
    }
}
