/**
 * How long `gh` stays parked after its token could not be read. A locked or denied macOS Keychain is the usual cause:
 * the user is away or just said no, and asking again on the next refresh would only repeat the password dialog.
 */
export const GITHUB_TOKEN_FAILURE_BACKOFF_MS = 10 * 60_000;

/**
 * A signed-out `gh` asks for nothing, so it is rechecked sooner: signing in should show up within a minute.
 */
export const GITHUB_TOKEN_SIGNED_OUT_BACKOFF_MS = 60_000;

export type GitHubTokenRead =
    | { kind: 'token'; token: string }
    /**
     * The read failed recently; `error` is that failure, rethrown to every `gh` call until the backoff ends.
     */
    | { kind: 'parked'; error: unknown };

/**
 * The GitHub CLI token every Server `gh` call reuses.
 *
 * `gh` keeps its token in the macOS Keychain, and every `gh` process reads it again. Project Status, pull request
 * lookups, and the quota probe run several `gh` calls at once, so while the Keychain is locked (the screen is locked,
 * or the login keychain is) each one raised its own password dialog, and Cancel dismissed only that one while the next
 * refresh raised more. Reading the token once through `gh auth token` (single-flight, so concurrent calls share one
 * read and at most one dialog) and passing it to each `gh` as `GH_TOKEN` keeps the Keychain out of every later call.
 * The token is `gh`'s own credential handed back to `gh`, not a shell credential forwarded into the CLI environment.
 *
 * A failed read parks `gh` for a while instead of retrying on every call. A token GitHub rejects is dropped so the next
 * call reads the current one, which picks up `gh auth login` or `gh auth refresh`.
 */
export class GitHubTokenCache {
    private token: string | undefined;
    private pending: Promise<GitHubTokenRead> | undefined;
    private parked: { error: unknown; until: number } | undefined;

    constructor(
        private readonly readToken: () => Promise<string>,
        private readonly isSignedOut: (error: unknown) => boolean,
        private readonly now: () => number = Date.now,
    ) {}

    private async load(): Promise<GitHubTokenRead> {
        try {
            return await this.settle();
        } finally {
            this.pending = undefined;
        }
    }

    private async settle(): Promise<GitHubTokenRead> {
        try {
            const token = (await this.readToken()).trim();
            if (!token) throw new Error('gh auth token printed no token');
            this.token = token;
            this.parked = undefined;
            return { kind: 'token', token };
        } catch (error) {
            const backoff = this.isSignedOut(error)
                ? GITHUB_TOKEN_SIGNED_OUT_BACKOFF_MS
                : GITHUB_TOKEN_FAILURE_BACKOFF_MS;
            this.parked = { error, until: this.now() + backoff };
            return { kind: 'parked', error };
        }
    }

    read(): Promise<GitHubTokenRead> {
        if (this.token) return Promise.resolve({ kind: 'token', token: this.token });
        if (this.parked && this.now() < this.parked.until)
            return Promise.resolve({ kind: 'parked', error: this.parked.error });
        this.pending ??= this.load();
        return this.pending;
    }

    /**
     * Drops a token GitHub no longer accepts, so the next call reads it again instead of failing until restart.
     */
    invalidate(token: string): void {
        if (this.token === token) this.token = undefined;
    }
}
