import { FileCode2, TerminalSquare, X } from 'lucide-react';
import type { DragEvent } from 'react';

import type { ProcessState } from '@shared/types';

interface WorkTabProps {
    active: boolean;
    closeLabel: string;
    dirty?: boolean;
    icon: 'file' | 'terminal';
    label: string;
    status?: ProcessState;
    terminalId?: string;
    onClose: () => void;
    onDragStart?: (event: DragEvent<HTMLDivElement>) => void;
    onSelect: () => void;
}

export function WorkTab({
    active,
    closeLabel,
    dirty = false,
    icon,
    label,
    status,
    terminalId,
    onClose,
    onDragStart,
    onSelect,
}: WorkTabProps) {
    const Icon = icon === 'terminal' ? TerminalSquare : FileCode2;
    return (
        <div
            className={active ? 'work-tab active' : 'work-tab'}
            data-terminal-id={terminalId}
            draggable={Boolean(onDragStart)}
            onDragStart={onDragStart}
        >
            <button
                type="button"
                role="tab"
                aria-selected={active}
                className="tab-select"
                onClick={onSelect}
            >
                <Icon size={13} />
                <span>{label}</span>
                {dirty && <b>●</b>}
            </button>
            {status && <i className={`process-indicator process-${status}`} />}
            <button
                type="button"
                className="tab-close"
                aria-label={closeLabel}
                title={closeLabel}
                onClick={onClose}
            >
                <X size={12} />
            </button>
        </div>
    );
}
