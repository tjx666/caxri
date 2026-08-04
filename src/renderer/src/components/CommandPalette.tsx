import { Command } from 'cmdk';

import { commands } from '@/commands';

import { Dialog, DialogContent, DialogTitle } from './ui/dialog';

export function CommandPalette({
    open,
    onOpenChange,
    execute,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    execute: (command: string) => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="command-dialog">
                <DialogTitle className="sr-only">Command Palette</DialogTitle>
                <Command label="Command Palette">
                    <Command.Input autoFocus placeholder="Type a command…" />
                    <Command.List>
                        <Command.Empty>No command found.</Command.Empty>
                        {commands.map((command) => (
                            <Command.Item
                                key={command.id}
                                value={`${command.category} ${command.title} ${command.id}`}
                                onSelect={() => {
                                    onOpenChange(false);
                                    execute(command.id);
                                }}
                            >
                                <span>{command.title}</span>
                                <small>{command.category}</small>
                            </Command.Item>
                        ))}
                    </Command.List>
                </Command>
            </DialogContent>
        </Dialog>
    );
}
