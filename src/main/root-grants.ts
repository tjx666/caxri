import { CaxriError } from '../shared/ipc/errors';

export class ProjectRootGrants {
    private readonly roots = new Map<string, number>();

    constructor(private readonly timeToLiveMs = 60_000) {}

    grant(rootPath: string): void {
        this.roots.set(rootPath, Date.now() + this.timeToLiveMs);
    }

    revoke(rootPath: string): void {
        this.roots.delete(rootPath);
    }

    /**
     * Reserve the single-use grant while creating, then restore it only when creation fails.
     */
    async use<T>(rootPath: string, create: () => Promise<T>): Promise<T> {
        const expiresAt = this.roots.get(rootPath);
        if (expiresAt === undefined)
            throw new CaxriError('PATH_DENIED', 'Project root was not selected by the user');
        this.roots.delete(rootPath);
        if (expiresAt <= Date.now())
            throw new CaxriError('PATH_DENIED', 'Project root selection expired');
        try {
            return await create();
        } catch (error) {
            this.grant(rootPath);
            throw error;
        }
    }
}
