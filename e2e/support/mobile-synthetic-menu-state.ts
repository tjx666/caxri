import { readFile } from 'node:fs/promises';

export interface SyntheticMenuState {
    cols: number | null;
    firstGridMarker: { columns: number; generation: string; rows: number };
    generation: string;
    interrupts: number;
    lines: string[];
    phase: 'busy' | 'menu';
    rows: number | null;
    selected: number;
    submissions: number;
}

export async function readSyntheticMenuState(path: string): Promise<SyntheticMenuState | null> {
    try {
        return JSON.parse(await readFile(path, 'utf8')) as SyntheticMenuState;
    } catch (error) {
        if (
            error !== null &&
            typeof error === 'object' &&
            'code' in error &&
            error.code === 'ENOENT'
        )
            return null;
        throw error;
    }
}
