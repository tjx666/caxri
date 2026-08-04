import { Bot, TerminalSquare } from 'lucide-react';

import type { TerminalKind } from '@shared/types';

import { Button } from './ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

interface CreateSessionDialogProps {
    onCreate: (kind: TerminalKind) => void;
    onOpenChange: (open: boolean) => void;
    rootPath?: string;
}

export function CreateSessionDialog({
    onCreate,
    onOpenChange,
    rootPath,
}: CreateSessionDialogProps) {
    return (
        <Dialog open={Boolean(rootPath)} onOpenChange={onOpenChange}>
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>Choose the default Terminal</DialogTitle>
                    <DialogDescription>
                        This primary Agent Terminal provides the Session title when metadata is
                        available.
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
