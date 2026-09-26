import type { AgentProvider, TerminalRecord } from '@caxri/protocol';
import type * as pty from 'node-pty';

import type { TerminalOutputQueue } from './buffer';
import type { TerminalColorQueryResponder } from './color-query';
import type { TerminalImageOutputFilter, TerminalImageRecoveryFilter } from './image-recovery';
import type { PtyThroughputTally } from './observability';
import type { TerminalOutputFramer } from './output-framer';
import type { AgentOutputRecovery } from './output-recovery';
import type { TerminalScreenState } from './screen';

export type TerminalExecutionEvent =
    | {
          type: 'output';
          terminalId: string;
          data: string;
          droppedBytes?: number;
      }
    | { type: 'observerOutput'; terminalId: string; data: string; sequence: number }
    | { type: 'observerGap'; terminalId: string; sequence: number; reason: 'resize' | 'overflow' }
    | {
          type: 'outputRecovery';
          terminalId: string;
          provider: AgentProvider;
          status: 'recovered' | 'rate-limited';
      }
    | { type: 'activity'; terminalId: string; processId: number }
    | {
          type: 'sizeOwnership';
          terminalId: string;
          owner: 'desktop' | 'mobile';
          cols: number;
          rows: number;
      }
    | { type: 'title'; terminalId: string; title: string };

export interface LiveTerminal {
    colorQuery?: TerminalColorQueryResponder;
    imageRecovery: TerminalImageRecoveryFilter;
    outputFramer: TerminalOutputFramer;
    imageOutput: TerminalImageOutputFilter;
    observerImageOutput: TerminalImageOutputFilter;
    observerOutputQueue: TerminalOutputQueue;
    observerDroppedBytes: number;
    observerNeedsResync: boolean;
    observerResyncReason: 'resize' | 'overflow' | null;
    observerSequence: number;
    observers: Set<string>;
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
    throughput: PtyThroughputTally;
    activityTimer?: NodeJS.Timeout;
    outputTimer?: NodeJS.Timeout;
    metricTimer?: NodeJS.Timeout;
}
