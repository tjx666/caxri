import { Buffer } from 'node:buffer';

export interface TerminalOutputFrame {
    data: string;
    isControl: boolean;
}

type ParserBoundary = 'ground' | 'escape' | 'escape-intermediate' | 'csi' | 'osc' | 'string';
const MAX_CONTROL_BYTES = 128 * 1024;
const OVERSIZED_CONTROL = '\r\n[Caxri omitted an oversized Terminal control sequence]\r\n';

/**
 * Keeps both screen recovery and live delivery on complete VT control boundaries. SerializeAddon saves cells, not
 * parser continuations: feeding half a CSI before an attach would turn its later suffix into visible text.
 * https://vt100.net/emu/dec_ansi_parser The bound exceeds the supported OSC 52 clipboard envelope; image filters retain
 * their separate 64 KiB policy.
 */
export class TerminalOutputFramer {
    private state: ParserBoundary = 'ground';
    private readonly pending: string[] = [];
    private pendingBytes = 0;
    private isOversized = false;

    constructor(private readonly maximumControlBytes = MAX_CONTROL_BYTES) {}

    private advance(code: number): void {
        switch (code) {
            case 0x1b: {
                this.state = 'escape';
                break;
            }
            case 0x9b: {
                this.state = 'csi';
                break;
            }
            case 0x9d: {
                this.state = 'osc';
                break;
            }
            case 0x90:
            case 0x98:
            case 0x9e:
            case 0x9f: {
                this.state = 'string';
                break;
            }
            default:
                if (code === 0x18 || code === 0x1a || (code >= 0x80 && code <= 0x9f))
                    this.state = 'ground';
                else
                    switch (this.state) {
                        case 'osc': {
                            if (code === 7) this.state = 'ground';

                            break;
                        }
                        case 'escape': {
                            switch (code) {
                                case 0x5b: {
                                    this.state = 'csi';
                                    break;
                                }
                                case 0x5d: {
                                    this.state = 'osc';
                                    break;
                                }
                                case 0x50:
                                case 0x58:
                                case 0x5e:
                                case 0x5f: {
                                    this.state = 'string';
                                    break;
                                }
                                default:
                                    if (code >= 0x20 && code <= 0x2f)
                                        this.state = 'escape-intermediate';
                                    else if (code !== 0x7f && code >= 0x30) this.state = 'ground';
                            }

                            break;
                        }
                        case 'escape-intermediate': {
                            if (code !== 0x7f && code >= 0x30) this.state = 'ground';

                            break;
                        }
                        case 'csi': {
                            if (code !== 0x7f && code >= 0x40) this.state = 'ground';
                            break;
                        }
                        case 'ground':
                        case 'string':
                            break;
                    }
        }
    }

    private retain(part: string): void {
        if (!part) return;
        this.pendingBytes += Buffer.byteLength(part, 'utf8');
        if (this.pendingBytes > this.maximumControlBytes) {
            this.isOversized = true;
            this.pending.length = 0;
            this.pendingBytes = this.maximumControlBytes + 1;
        } else if (!this.isOversized) this.pending.push(part);
    }

    push(data: string): TerminalOutputFrame[] {
        const frames: TerminalOutputFrame[] = [];
        let start = 0;
        let isControl = this.state !== 'ground';
        for (let index = 0; index < data.length;) {
            const code = data.codePointAt(index)!;
            const end = index + (code > 0xffff ? 2 : 1);
            this.advance(code);
            if (!isControl && this.state !== 'ground') {
                if (index > start)
                    frames.push({ data: data.slice(start, index), isControl: false });
                start = index;
                isControl = true;
            } else if (isControl && this.state === 'ground') {
                this.retain(data.slice(start, end));
                frames.push({
                    data: this.isOversized ? OVERSIZED_CONTROL : this.pending.join(''),
                    isControl: !this.isOversized,
                });
                this.pending.length = 0;
                this.pendingBytes = 0;
                this.isOversized = false;
                start = end;
                isControl = false;
            }
            index = end;
        }
        const remainder = data.slice(start);
        if (isControl) this.retain(remainder);
        else if (remainder) frames.push({ data: remainder, isControl: false });
        return frames;
    }

    /**
     * Lets retiring image filters render their incomplete-image placeholders. A control tail is still incomplete and
     * must never be sent raw to a Renderer; an oversized notice is ordinary safe text.
     */
    finish(): TerminalOutputFrame {
        const tail = {
            data: this.isOversized ? OVERSIZED_CONTROL : this.pending.join(''),
            isControl: !this.isOversized,
        };
        this.pending.length = 0;
        this.pendingBytes = 0;
        this.isOversized = false;
        this.state = 'ground';
        return tail;
    }
}
