/**
 * How long a Caxri Bot launched with no prompt may stay silent before it is taken as idle at its first prompt. Claude
 * Code reports SessionStart within a second or two of starting; Codex reports nothing until the first prompt.
 */
const PROMPTLESS_LAUNCH_READY_MS = 8000;

/**
 * Watches a Caxri Bot launch that started with no prompt until it can take a notice. Only its Agent's first
 * SessionStart marks it idle at its first prompt, and only if nobody typed since the launch: SessionStart also fires on
 * `/clear` and compaction. Codex fires it lazily, as the user's first prompt goes in, so a launch that reports nothing
 * within `PROMPTLESS_LAUNCH_READY_MS` is taken as idle too; otherwise a notice queued right after it (the hand-over
 * that started it) waited until the user happened to talk to Caxri Bot (GitHub issue #2228).
 */
export class PromptlessBotLaunch {
    private launch:
        { epoch: number; launchedAt: number; timer: ReturnType<typeof setTimeout> } | undefined;

    constructor(
        private readonly options: {
            now: () => number;
            /**
             * The launch stayed silent for the whole wait.
             */
            onTimeout: (terminalId: string, launchId: string) => void;
        },
    ) {}

    /**
     * Starts watching a launch, given the Terminal's input epoch as it launched.
     */
    arm(terminalId: string, launchId: string, epoch: number): void {
        this.clear();
        const timer = setTimeout(
            () => this.options.onTimeout(terminalId, launchId),
            PROMPTLESS_LAUNCH_READY_MS,
        );
        timer.unref();
        this.launch = { epoch, launchedAt: this.options.now(), timer };
    }

    clear(): void {
        clearTimeout(this.launch?.timer);
        this.launch = undefined;
    }

    /**
     * Stops watching and returns the launch that was watched, if any.
     */
    take(): { epoch: number; launchedAt: number } | undefined {
        const { launch } = this;
        this.clear();
        return launch;
    }
}
