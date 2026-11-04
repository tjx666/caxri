/**
 * The `wait` calls open now, so a notice never repeats an outcome a caller is about to read itself. In memory on
 * purpose: a Server restart ends every open wait.
 */
export class NoticeWaiters {
    private static key(terminalId: string, delegationId: string): string {
        return `${terminalId}\0${delegationId}`;
    }

    /**
     * Open waits per caller Terminal and task; `ignoringQuestions` counts those that ignore questions.
     */
    private readonly open = new Map<string, { all: number; ignoringQuestions: number }>();

    /**
     * Registers one wait over the tasks and returns its release, which is idempotent.
     */
    register(
        terminalId: string,
        delegationIds: readonly string[],
        shouldIgnoreQuestions: boolean,
    ): () => void {
        const keys = [...new Set(delegationIds)].map((id) => NoticeWaiters.key(terminalId, id));
        for (const key of keys) {
            const count = this.open.get(key) ?? { all: 0, ignoringQuestions: 0 };
            count.all += 1;
            if (shouldIgnoreQuestions) count.ignoringQuestions += 1;
            this.open.set(key, count);
        }
        let isReleased = false;
        return () => {
            if (isReleased) return;
            isReleased = true;
            for (const key of keys) {
                const count = this.open.get(key);
                if (!count) continue;
                count.all -= 1;
                if (shouldIgnoreQuestions) count.ignoringQuestions -= 1;
                if (count.all <= 0) this.open.delete(key);
            }
        };
    }

    /**
     * Whether an open wait of the caller will report the task's settlement itself.
     */
    isWaitingForSettlement(terminalId: string, delegationId: string): boolean {
        return (this.open.get(NoticeWaiters.key(terminalId, delegationId))?.all ?? 0) > 0;
    }

    /**
     * Whether an open wait of the caller will report the task's question or approval itself. A wait that ignores
     * questions never does.
     */
    isWaitingForQuestions(terminalId: string, delegationId: string): boolean {
        const count = this.open.get(NoticeWaiters.key(terminalId, delegationId));
        return count !== undefined && count.all > count.ignoringQuestions;
    }
}
