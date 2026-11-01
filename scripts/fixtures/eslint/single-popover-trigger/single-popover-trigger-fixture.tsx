import { Popover, PopoverContent, PopoverTrigger } from './popover';

export function TwoTriggers() {
    return (
        <Popover>
            <PopoverTrigger>First</PopoverTrigger>
            <PopoverTrigger>Second</PopoverTrigger>
            <PopoverContent>Body</PopoverContent>
        </Popover>
    );
}

export function MappedTriggers({ items }: { items: string[] }) {
    return (
        <Popover>
            {items.map((item) => (
                <PopoverTrigger key={item}>{item}</PopoverTrigger>
            ))}
            <PopoverContent>Body</PopoverContent>
        </Popover>
    );
}

export function OneTrigger() {
    return (
        <Popover>
            <PopoverTrigger>Only</PopoverTrigger>
            <PopoverContent>Body</PopoverContent>
        </Popover>
    );
}

export function OnePopoverPerItem({ items }: { items: string[] }) {
    return items.map((item) => (
        <Popover key={item}>
            <PopoverTrigger>{item}</PopoverTrigger>
            <PopoverContent>Body</PopoverContent>
        </Popover>
    ));
}
