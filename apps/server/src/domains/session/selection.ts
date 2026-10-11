/**
 * Serializes Session selection from validation through durable commit. Renderer MRU navigation can enqueue a second
 * selection before the first Workbench Root validation finishes; preserving call order keeps the newest invocation
 * authoritative instead of letting the slowest validation overwrite it.
 */
export class SessionSelectionQueue {
    private tail: Promise<void> = Promise.resolve();

    run<Result>(select: () => Promise<Result>): Promise<Result> {
        // eslint-disable-next-line unicorn/prefer-await -- the tail must be reassigned before another caller can enter
        const result = this.tail.then(select);
        // eslint-disable-next-line unicorn/prefer-await -- the tail must be reassigned synchronously, see above
        this.tail = result.then(() => {}).catch(() => {});
        return result;
    }
}
