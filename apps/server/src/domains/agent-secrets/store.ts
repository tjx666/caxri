import { join } from 'node:path';

import type { AgentSecretScope, AgentSecretSummary } from '@caxri/protocol';
import {
    agentSecretNameSchema,
    agentSecretScopeSchema,
    agentSecretValueSchema,
    CaxriError,
    MAX_AGENT_SECRETS,
} from '@caxri/protocol';
import { KeyedSerialQueue, readBoundedRegularFileText } from '@caxri/system';
import { z } from 'zod';

import { atomicWrite } from '../atomic-file';

export const AGENT_SECRETS_FILE = 'agent-secrets.json';
/**
 * Every secret at its largest value with generous JSON overhead.
 */
const MAX_STORE_BYTES = 8 * 1024 * 1024;

const storedSecretSchema = z.strictObject({
    name: agentSecretNameSchema,
    scope: agentSecretScopeSchema,
    value: agentSecretValueSchema,
    updatedAt: z.number().int().nonnegative(),
});
type StoredSecret = z.infer<typeof storedSecretSchema>;

const storeFileSchema = z.strictObject({
    version: z.literal(1),
    secrets: z.array(storedSecretSchema).max(MAX_AGENT_SECRETS),
});

function scopeKey(scope: AgentSecretScope): string {
    return scope.kind === 'global' ? 'global' : `project:${scope.projectId}`;
}

function secretKey(name: string, scope: AgentSecretScope): string {
    return `${scopeKey(scope)}\0${name}`;
}

function summary({ name, scope, updatedAt }: StoredSecret): AgentSecretSummary {
    return { name, scope, updatedAt };
}

/**
 * The user's Agent secrets: one owner-only (`0600`) JSON file in the profile's user-data directory, outside
 * `settings.jsonc`, the database, logs, and diagnostic exports.
 *
 * Values are stored in plain text on purpose. Caxri's security bar is a single user on their own machine, where an
 * encrypted file would need its key beside it, and the macOS Keychain raises a password dialog whenever the login
 * keychain is locked (see `external-status/github-token.ts`), which would interrupt an Agent's command. Mux, Synara,
 * and T3 Code store Agent secrets the same way.
 *
 * Reads are served from memory after the first load; every change rewrites the whole file atomically, one at a time. An
 * unreadable file fails every operation instead of being replaced, so a damaged store is never silently emptied.
 */
export class AgentSecretStore {
    private readonly path: string;
    private readonly writes = new KeyedSerialQueue<'store'>();
    private secrets: Map<string, StoredSecret> | undefined;

    constructor(
        userDataPath: string,
        private readonly now: () => number = Date.now,
    ) {
        this.path = join(userDataPath, AGENT_SECRETS_FILE);
    }

    private async load(): Promise<Map<string, StoredSecret>> {
        if (this.secrets) return this.secrets;
        let source: string | undefined;
        try {
            source = await readBoundedRegularFileText(this.path, MAX_STORE_BYTES, {
                symlinks: 'nofollow',
            });
        } catch (error) {
            if ((error as NodeJS.ErrnoException | undefined)?.code !== 'ENOENT')
                throw new CaxriError('IO', 'The Agent secret store could not be read');
        }
        const secrets = new Map<string, StoredSecret>();
        if (source !== undefined) {
            let parsed: z.infer<typeof storeFileSchema>;
            try {
                parsed = storeFileSchema.parse(JSON.parse(source));
            } catch {
                throw new CaxriError(
                    'IO',
                    `The Agent secret store is damaged; fix or remove ${AGENT_SECRETS_FILE} in the Caxri data folder`,
                );
            }
            for (const secret of parsed.secrets)
                secrets.set(secretKey(secret.name, secret.scope), secret);
        }
        this.secrets ??= secrets;
        return this.secrets;
    }

    private async persist(next: Map<string, StoredSecret>): Promise<void> {
        const secrets = next
            .values()
            .toArray()
            .toSorted(
                (left, right) =>
                    scopeKey(left.scope).localeCompare(scopeKey(right.scope)) ||
                    left.name.localeCompare(right.name),
            );
        await atomicWrite(this.path, `${JSON.stringify({ version: 1, secrets }, null, 4)}\n`);
        this.secrets = next;
    }

    async list(): Promise<AgentSecretSummary[]> {
        const secrets = await this.load();
        return secrets.values().map(summary).toArray();
    }

    /**
     * The secrets an Agent in `projectId` can use: its Project's own plus every global one it does not shadow.
     */
    async visible(projectId: string): Promise<Map<string, StoredSecret>> {
        const secrets = await this.load();
        const visible = new Map<string, StoredSecret>();
        for (const secret of secrets.values()) {
            if (secret.scope.kind === 'project' && secret.scope.projectId !== projectId) continue;
            const shadowed = visible.get(secret.name);
            if (shadowed?.scope.kind === 'project') continue;
            visible.set(secret.name, secret);
        }
        return visible;
    }

    set(name: string, scope: AgentSecretScope, value: string): Promise<AgentSecretSummary> {
        return this.writes.run('store', async () => {
            const current = await this.load();
            const key = secretKey(name, scope);
            if (!current.has(key) && current.size >= MAX_AGENT_SECRETS)
                throw new CaxriError(
                    'CAPACITY',
                    `At most ${MAX_AGENT_SECRETS} secrets can be saved`,
                );
            const secret: StoredSecret = { name, scope, value, updatedAt: this.now() };
            const next = new Map(current);
            next.set(key, secret);
            await this.persist(next);
            return summary(secret);
        });
    }

    delete(name: string, scope: AgentSecretScope): Promise<boolean> {
        return this.writes.run('store', async () => {
            const current = await this.load();
            const key = secretKey(name, scope);
            if (!current.has(key)) return false;
            const next = new Map(current);
            next.delete(key);
            await this.persist(next);
            return true;
        });
    }

    /**
     * Drops every secret scoped to a Project that no longer exists. Global secrets are untouched.
     */
    pruneProjects(isLive: (projectId: string) => boolean): Promise<number> {
        return this.writes.run('store', async () => {
            const current = await this.load();
            const next = new Map(
                current
                    .entries()
                    .filter(
                        ([, secret]) =>
                            secret.scope.kind !== 'project' || isLive(secret.scope.projectId),
                    ),
            );
            const removed = current.size - next.size;
            if (removed > 0) await this.persist(next);
            return removed;
        });
    }
}
