import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HostPreference, HostPreferences, HostSystemIconName } from '@caxri/protocol';
import { hostPreferenceSchema } from '@caxri/protocol';
import { atomicWriteFile } from '@caxri/system';

const MAX_PREFERENCES_FILE_BYTES = 256 * 1024;
const MAX_HOSTS = 128;

const EMPTY: HostPreferences = { shouldShowHostNames: false, hosts: {} };

/**
 * One machine's change from Settings › Hosts. `null` clears a name or icon; an omitted field keeps its value.
 */
export interface HostPreferenceChange {
    name?: string | null;
    icon?: HostPreference['icon'] | null;
    reconnectOnLaunch?: boolean;
}

function parsePreferences(source: string): HostPreferences {
    let parsed: unknown;
    try {
        parsed = JSON.parse(source);
    } catch {
        return EMPTY;
    }
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const isShowHostNames = Reflect.get(parsed, 'shouldShowHostNames') === true;
    const rawHosts: unknown = Reflect.get(parsed, 'hosts');
    const hosts: Record<string, HostPreference> = {};
    if (typeof rawHosts === 'object' && rawHosts !== null)
        for (const [id, value] of Object.entries(rawHosts).slice(0, MAX_HOSTS)) {
            // One bad entry drops only itself, so a hand edit never resets every Host.
            const host = hostPreferenceSchema.safeParse(value);
            if (id.length > 0 && id.length <= 1024 && host.success) hosts[id] = host.data;
        }
    return { shouldShowHostNames: isShowHostNames, hosts };
}

function applyChange(current: HostPreference, change: HostPreferenceChange): HostPreference {
    const next = { ...current };
    if (change.name !== undefined) {
        const name = change.name?.trim();
        if (name) next.name = name;
        else delete next.name;
    }
    if (change.icon !== undefined) {
        if (change.icon) next.icon = change.icon;
        else delete next.icon;
    }
    if (change.reconnectOnLaunch !== undefined) next.reconnectOnLaunch = change.reconnectOnLaunch;
    return next;
}

/**
 * This Mac's display preferences for each machine (`userData/ssh/host-preferences.json`): read once, then kept in
 * memory and written through a temp file and rename on every change, one write at a time.
 */
export class HostPreferencesStore {
    private loaded: Promise<HostPreferences> | undefined;
    /**
     * Settles once the latest queued write finished, whether or not it succeeded.
     */
    private writes: Promise<void> = Promise.resolve();
    readonly path: string;

    /**
     * @param directory Main's private SSH directory.
     * @param onChanged Receives the new preferences after every change.
     */
    constructor(
        directory: string,
        private readonly onChanged: (preferences: HostPreferences) => void,
    ) {
        this.path = join(directory, 'host-preferences.json');
    }

    private async load(): Promise<HostPreferences> {
        try {
            const source = await readFile(this.path, 'utf8');
            return source.length > MAX_PREFERENCES_FILE_BYTES ? EMPTY : parsePreferences(source);
        } catch {
            return EMPTY;
        }
    }

    private async change(
        apply: (current: HostPreferences) => HostPreferences,
    ): Promise<HostPreferences> {
        const previous = this.writes;
        const { promise, resolve: release } = Promise.withResolvers<void>();
        this.writes = promise;
        try {
            await previous;
            const next = apply(await this.read());
            await atomicWriteFile(this.path, `${JSON.stringify(next, null, 2)}\n`, {
                durability: 'durable',
            });
            this.loaded = Promise.resolve(next);
            this.onChanged(next);
            return next;
        } finally {
            release();
        }
    }

    read(): Promise<HostPreferences> {
        this.loaded ??= this.load();
        return this.loaded;
    }

    update(hostId: string, change: HostPreferenceChange): Promise<HostPreferences> {
        return this.change((current) => ({
            ...current,
            hosts: { ...current.hosts, [hostId]: applyChange(current.hosts[hostId] ?? {}, change) },
        }));
    }

    setShowHostNames(shouldShowHostNames: boolean): Promise<HostPreferences> {
        return this.change((current) => ({ ...current, shouldShowHostNames }));
    }

    /**
     * Remembers how an SSH Host was reached and what it runs, once it connected, so Settings › Hosts can connect it
     * again and its mark keeps the system logo while it is offline. A no-op when nothing changed.
     */
    async recordConnected(
        hostId: string,
        destination: string,
        detectedSystem: HostSystemIconName | undefined,
    ): Promise<void> {
        const { hosts } = await this.read();
        const current = Object.hasOwn(hosts, hostId) ? hosts[hostId] : undefined;
        if (
            current?.destination === destination &&
            (detectedSystem === undefined || current.detectedSystem === detectedSystem)
        )
            return;
        await this.change((preferences) => ({
            ...preferences,
            hosts: {
                ...preferences.hosts,
                [hostId]: {
                    ...preferences.hosts[hostId],
                    destination,
                    ...(detectedSystem && { detectedSystem }),
                },
            },
        }));
    }
}
