import { currentBackgroundWork } from '../../observability/background-work';
import { machineLoad } from '../../observability/machine-load';

const MAX_CONCURRENT_GIT_COMMANDS = 8;
/**
 * Background Git commands allowed to run at once while the machine is loaded: enough for a background refresh to keep
 * making progress, while the rest of the budget stays free for the request the user is waiting on.
 */
const LOADED_BACKGROUND_SLOTS = 2;

interface GitCommandBudgetOptions {
    /**
     * Whether the command about to queue was issued by background work.
     */
    isBackground: () => boolean;
    isLoaded: () => boolean;
}

/**
 * The shared Git process budget, with two classes. A foreground command (any request a client is waiting on) always
 * starts before a queued background one; while the machine is loaded, background commands are further held to
 * {@link LOADED_BACKGROUND_SLOTS}. A plain FIFO let `session.select`'s topology read wait behind a burst of status polls
 * on a saturated machine.
 */
export class GitCommandBudget {
    private active = 0;
    private activeBackground = 0;
    private readonly foreground: Array<() => void> = [];
    private readonly background: Array<() => void> = [];

    constructor(
        private readonly maximum = MAX_CONCURRENT_GIT_COMMANDS,
        private readonly options: GitCommandBudgetOptions = {
            isBackground: () => currentBackgroundWork() !== undefined,
            isLoaded: () => machineLoad.isLoaded(),
        },
    ) {
        if (!Number.isSafeInteger(maximum) || maximum < 1)
            throw new RangeError('Git command budget must be a positive integer');
    }

    private backgroundLimit(): number {
        return this.options.isLoaded()
            ? Math.min(LOADED_BACKGROUND_SLOTS, this.maximum)
            : this.maximum;
    }

    private canStart(isBackground: boolean): boolean {
        if (this.active >= this.maximum) return false;
        return !isBackground || this.activeBackground < this.backgroundLimit();
    }

    private start(isBackground: boolean): void {
        this.active += 1;
        if (isBackground) this.activeBackground += 1;
    }

    private acquire(isBackground: boolean): Promise<void> {
        const queue = isBackground ? this.background : this.foreground;
        // A background command never overtakes a queued foreground one, even when a background slot is free.
        const isAhead = !isBackground || this.foreground.length === 0;
        if (isAhead && queue.length === 0 && this.canStart(isBackground)) {
            this.start(isBackground);
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            queue.push(() => {
                this.start(isBackground);
                resolve();
            });
        });
    }

    private release(isBackground: boolean): void {
        this.active -= 1;
        if (isBackground) this.activeBackground -= 1;
        while (this.foreground.length > 0 && this.canStart(false)) this.foreground.shift()?.();
        while (this.foreground.length === 0 && this.background.length > 0 && this.canStart(true))
            this.background.shift()?.();
    }

    async run<Value>(operation: () => Promise<Value>): Promise<Value> {
        const isBackground = this.options.isBackground();
        await this.acquire(isBackground);
        try {
            return await operation();
        } finally {
            this.release(isBackground);
        }
    }
}
