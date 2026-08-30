import { and, eq } from 'drizzle-orm';

import type { CaxriDrizzleDatabase } from '../connection';
import { sessions } from '../schema';

export interface StoredSessionNamingState {
    lastAutoTitle?: string;
    state: 'active' | 'stopped';
}

/**
 * Owns Caxri's private mirror of provider-native Session title ownership. Provider writes remain outside SQLite; this
 * model records only enough state to distinguish Caxri's last automatic title from a later manual provider rename.
 */
export class SessionNamingModel {
    constructor(private readonly database: CaxriDrizzleDatabase) {}

    get(id: string): StoredSessionNamingState | undefined {
        const row = this.database
            .select({
                lastAutoTitle: sessions.lastAutoTitle,
                state: sessions.autoNamingState,
            })
            .from(sessions)
            .where(eq(sessions.id, id))
            .get();
        if (!row) return undefined;
        return {
            lastAutoTitle: row.lastAutoTitle ?? undefined,
            state: row.state as StoredSessionNamingState['state'],
        };
    }

    recordAutomaticTitle(id: string, displayTitle: string): boolean {
        return (
            this.database
                .update(sessions)
                .set({ autoNamingState: 'active', lastAutoTitle: displayTitle })
                .where(and(eq(sessions.id, id), eq(sessions.titleMode, 'automatic')))
                .run().changes === 1
        );
    }

    stop(id: string): boolean {
        return (
            this.database
                .update(sessions)
                .set({ autoNamingState: 'stopped' })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }

    resume(id: string, currentProviderTitle?: string): boolean {
        return (
            this.database
                .update(sessions)
                .set({
                    autoNamingState: 'active',
                    lastAutoTitle: currentProviderTitle ?? null,
                    titleMode: 'automatic',
                })
                .where(eq(sessions.id, id))
                .run().changes === 1
        );
    }
}
