export interface GridSize {
    cols: number;
    rows: number;
}

export interface GridBurstSummary {
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
 * Deterministically summarizes a grid sequence without retaining individual samples.
 */
export class GridBurstAccumulator {
    private summary: GridBurstSummary | undefined;

    sample(size: GridSize): void {
        if (!this.summary) {
            const initial = copyGrid(size);
            this.summary = {
                changeCount: 0,
                final: copyGrid(initial),
                maximum: copyGrid(initial),
                minimum: copyGrid(initial),
                sampleCount: 1,
                start: initial,
            };
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
