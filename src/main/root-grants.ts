export class SessionRootGrants {
    private readonly roots = new Set<string>();

    grant(rootPath: string): void {
        this.roots.add(rootPath);
    }

    /** Reserve the single-use grant while creating, then restore it only when creation fails. */
    async use<T>(rootPath: string, create: () => Promise<T>): Promise<T> {
        if (!this.roots.delete(rootPath))
            throw new Error('Session root was not selected by the user');
        try {
            return await create();
        } catch (error) {
            this.roots.add(rootPath);
            throw error;
        }
    }
}
