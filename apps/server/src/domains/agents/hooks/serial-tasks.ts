/**
 * Runs async tasks one at a time in call order. Reconciles share provider files and health, so a later one must start
 * only after the earlier one settled, whichever way it settled.
 */
export class SerialTasks {
    private tail = Promise.resolve();

    /**
     * The tail is reassigned synchronously (not after an `await`) so concurrent calls serialize onto the same chain
     * instead of racing to read it before this call's continuation is attached.
     */
    run(task: () => Promise<void>): Promise<void> {
        // eslint-disable-next-line unicorn/prefer-await -- see above; the tail must be reassigned synchronously
        const run = this.tail.then(task);
        // eslint-disable-next-line unicorn/prefer-await -- see above; the tail must be reassigned synchronously
        this.tail = run.catch(() => {});
        return run;
    }

    /**
     * Resolves once every task queued so far has settled.
     */
    idle(): Promise<void> {
        return this.tail;
    }
}
