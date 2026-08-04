import { Bot, TerminalSquare } from 'lucide-react';

import type { TerminalKind } from '@shared/types';

import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface CreateSessionDialogProps {
    onCancel: () => void;
    onCreate: (kind: TerminalKind) => void;
    open: boolean;
    contextLabel?: string;
}

export function CreateSessionDialog({
    contextLabel,
    onCancel,
    onCreate,
    open,
}: CreateSessionDialogProps) {
    return (
        <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onCancel()}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Choose the default Terminal</DialogTitle>
                    <DialogDescription>
                        Create a Session{contextLabel ? ` in ${contextLabel}` : ''}. Its primary
                        Agent Terminal provides the Session title when metadata is available.
                    </DialogDescription>
                </DialogHeader>
                <div className="agent-choice">
                    <Button variant="secondary" onClick={() => onCreate('claude')}>
                        <Bot size={15} /> Claude Code
                    </Button>
                    <Button variant="secondary" onClick={() => onCreate('codex')}>
                        <Bot size={15} /> Codex
                    </Button>
                    <Button variant="secondary" onClick={() => onCreate('shell')}>
                        <TerminalSquare size={15} /> Shell
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
