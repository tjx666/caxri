/**
 * Fixed-capacity record of recent `requestAnimationFrame` timestamps. The buffers are allocated once so recording a
 * frame never allocates: the callback that measures frame pacing must not become a source of the garbage it measures.
 */
export class FrameRing {
    private readonly timestamps: Float64Array;
    private count = 0;
    private head = 0;

    constructor(readonly capacity: number) {
        this.timestamps = new Float64Array(capacity);
    }

    get length(): number {
        return this.count;
    }

    reset(): void {
        this.count = 0;
        this.head = 0;
    }

    push(timestampMs: number): void {
        this.timestamps[this.head] = timestampMs;
        this.head = (this.head + 1) % this.capacity;
        if (this.count < this.capacity) this.count += 1;
    }

    /**
     * The timestamp `age` frames back (0 is the newest), or `undefined` past the recorded history.
     */
    at(age: number): number | undefined {
        if (age < 0 || age >= this.count) return undefined;
        return this.timestamps[(this.head - 1 - age + this.capacity * 2) % this.capacity];
    }

    /**
     * Intervals between consecutive frames in milliseconds, oldest first. One fewer than {@link length}.
     */
    intervals(): number[] {
        const result: number[] = [];
        for (let age = this.count - 1; age >= 1; age -= 1)
            result.push(this.at(age - 1)! - this.at(age)!);
        return result;
    }
}

export interface FrameStats {
    /**
     * Frame callbacks per second over the last second.
     */
    fps: number;
    /**
     * The rate implied by the slowest 1% of recorded frames, never less than the one slowest frame.
     */
    lowFps: number;
    /**
     * The rate of the single slowest recorded frame.
     */
    minFps: number;
}

const FPS_WINDOW_MS = 1_000;

const idleStats: FrameStats = { fps: 0, lowFps: 0, minFps: 0 };

/**
 * Derives the displayed rates from the ring. `fps` counts the frames inside the last {@link FPS_WINDOW_MS} and divides
 * by the span they actually cover, so a steady 14.37 ms cadence reads 69.6 rather than snapping to a whole number of
 * frames per window. Fewer than two frames in the window is "no signal", not a low rate: a hidden window produces
 * none.
 */
export function computeFrameStats(ring: FrameRing, nowMs: number): FrameStats {
    const newest = ring.at(0);
    if (newest === undefined || nowMs - newest > FPS_WINDOW_MS) return idleStats;
    let first = newest;
    let frames = 1;
    for (let age = 1; age < ring.length; age += 1) {
        const timestamp = ring.at(age)!;
        if (newest - timestamp > FPS_WINDOW_MS) break;
        first = timestamp;
        frames += 1;
    }
    if (newest === first || frames < 2) return idleStats;
    const fps = ((frames - 1) * 1_000) / (newest - first);
    const intervals = ring.intervals().filter((interval) => interval > 0);
    if (intervals.length === 0) return { fps, lowFps: fps, minFps: fps };
    const slowestFirst = intervals.toSorted((left, right) => right - left);
    const slowCount = Math.max(1, Math.ceil(slowestFirst.length * 0.01));
    let slowTotal = 0;
    for (let index = 0; index < slowCount; index += 1) slowTotal += slowestFirst[index];
    return {
        fps,
        lowFps: 1_000 / (slowTotal / slowCount),
        minFps: 1_000 / slowestFirst[0],
    };
}
