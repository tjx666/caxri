export interface GridSize {
    cols: number;
    rows: number;
}

export interface GridBurstSummary {
    /**
     * Grid transitions relative to the grid in force before the burst; `0` means the burst re-sampled the existing grid
     * and never changed it.
     */
    changeCount: number;
    final: GridSize;
    maximum: GridSize;
    minimum: GridSize;
    sampleCount: number;
    start: GridSize;
}

function copyGrid(size: GridSize): GridSize {
    return { cols: size.cols, rows: size.rows };
}

function copySummary(summary: GridBurstSummary): GridBurstSummary {
    return {
        changeCount: summary.changeCount,
        final: copyGrid(summary.final),
        maximum: copyGrid(summary.maximum),
        minimum: copyGrid(summary.minimum),
        sampleCount: summary.sampleCount,
        start: copyGrid(summary.start),
    };
}

/**
 * Deterministically summarizes a grid sequence without retaining individual samples. Seeding with the grid known before
 * the burst began lets `changeCount` and `start` describe a genuine before-to-after transition instead of reading a
 * settled one-step resize as unchanged.
 */
export class GridBurstAccumulator {
    private summary: GridBurstSummary | undefined;

    private initialSummary(size: GridSize, sampleCount: number): GridBurstSummary {
        const initial = copyGrid(size);
        return {
            changeCount: 0,
            final: copyGrid(initial),
            maximum: copyGrid(initial),
            minimum: copyGrid(initial),
            sampleCount,
            start: initial,
        };
    }

    /**
     * Establishes `start`/`minimum`/`maximum`/`final` from a grid observed before this burst began, without counting
     * toward `sampleCount`. Call at most once, before the first real `sample()` of a burst: the first `sample()` call
     * afterward still advances `sampleCount` to 1 and compares against this seed, so a single real sample that differs
     * from the seed reports `sampleCount: 1, changeCount: 1`.
     */
    seed(size: GridSize): void {
        this.summary = this.initialSummary(size, 0);
    }

    sample(size: GridSize): void {
        if (!this.summary) {
            this.summary = this.initialSummary(size, 1);
            return;
        }

        const previous = this.summary.final;
        this.summary.sampleCount += 1;
        if (previous.cols !== size.cols || previous.rows !== size.rows)
            this.summary.changeCount += 1;
        this.summary.final = copyGrid(size);
        this.summary.minimum.cols = Math.min(this.summary.minimum.cols, size.cols);
        this.summary.minimum.rows = Math.min(this.summary.minimum.rows, size.rows);
        this.summary.maximum.cols = Math.max(this.summary.maximum.cols, size.cols);
        this.summary.maximum.rows = Math.max(this.summary.maximum.rows, size.rows);
    }

    snapshot(): GridBurstSummary | undefined {
        return this.summary ? copySummary(this.summary) : undefined;
    }

    reset(): GridBurstSummary | undefined {
        const summary = this.snapshot();
        this.summary = undefined;
        return summary;
    }
}
