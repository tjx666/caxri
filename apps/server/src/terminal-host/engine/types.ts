import type { AgentProvider, TerminalRecord } from '@caxri/protocol';
import type * as pty from 'node-pty';

import type { TerminalOutputQueue } from './buffer';
import type { TerminalColorQueryResponder } from './color-query';
import type { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type { AgentOutputRecovery } from './output-recovery';
import type { TerminalScreenState } from './screen';

export interface LiveTerminal {
    colorQuery?: TerminalColorQueryResponder;
    imageRecovery: TerminalImageRecoveryFilter;
    imageOutput: TerminalImageOutputFilter;
    process: pty.IPty;
    record: TerminalRecord;
    screen: TerminalScreenState;
    outputRecovery?: AgentOutputRecovery;
    outputRecoveryProvider?: AgentProvider;
    outputQueue: TerminalOutputQueue;
    droppedBytes: number;
    metricOutputBytes: number;
    metricInputBytes: number;
    metricDroppedBytes: number;
    activityTimer?: NodeJS.Timeout;
    outputTimer?: NodeJS.Timeout;
    metricTimer?: NodeJS.Timeout;
}

export interface TerminalGridSize {
    cols: number;
    rows: number;
}

export type AttachedSizeWaiter = () => void;
