/** One business frame (record.js toInboxFrame shape; text truncated). */
export interface WalFrame {
    post_type?: string;
    message_type?: string;
    sub_type?: string;
    notice_type?: string;
    request_type?: string;
    user_id?: string;
    group_id?: string;
    self_id?: string;
    message_id?: string;
    message?: unknown;
    raw_message?: string;
    sender?: {
        user_id?: string;
        nickname?: string;
        card?: string;
        role?: string;
    };
}
/** One unacked WAL entry (replay raw material). */
export interface WalUnackedEntry {
    id: string;
    frame: WalFrame;
}
/** WAL session returned by begin(); end() writes the ack line. */
export interface WalSession {
    id: string;
    frame: WalFrame;
    /** Sync processing done: confirm this inbound (never replay again). */
    end(): void;
}
/** Inbound WAL stats (healthcheck / status snapshot). */
export interface WalStats {
    enabled: boolean;
    unacked: number;
    enqWritten: number;
    ackWritten: number;
    replayed: number;
    compacted: number;
    writeFailures: number;
}
/**
 * The inbound write-ahead log (P0 2026-11-02, mirrors dsh-lark-link): each real
 * inbound message (injected/replayed excluded) writes an enq line before
 * processing and an ack line at the sync-processing seam. A crash between them
 * leaves the message unacked → replayed after restart (inboundWalReplay=true).
 *
 * Replay safety: the ack point is after dispatchFollowup but before the async
 * model turn — replied messages are always acked; unacked messages' dispatch
 * died with the process. Residual risk: a crash exactly between dispatch and
 * ack replays at most one message.
 *
 * File (mediaDir/qq-inbox-wal.jsonl, one op per line):
 *   {"op":"enq","id","ts","frame"} / {"op":"ack","id","at"} / {"op":"replay","id","at"}
 * Pure bypass: write failures only warn.
 */
export declare class InboundWal {
    private readonly dir;
    private readonly log;
    private readonly now;
    private writeChain;
    private acksSinceCompact;
    private loadPromise;
    private refreshingUnacked;
    /** Unacked count: in-memory (+1/-1) vs file-based (refreshUnacked);
     *  file count wins once computed. */
    private unacked;
    private unackedFile;
    private readonly stats;
    constructor(options?: {
        dir: string;
        log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
        now?: () => number;
    });
    file(): string;
    tmpFile(): string;
    /** Start one inbound's WAL record: writes enq (no await), returns session. */
    begin(event: unknown): WalSession;
    /** Read all unacked business frames — the restart-replay raw material. */
    loadUnacked(): Promise<WalUnackedEntry[]>;
    /** Mark one entry replayed (later crashes won't redeliver it). */
    markReplayed(id: string): void;
    /** Recompute the unacked count from the file (status refresh cadence). */
    refreshUnacked(): Promise<void>;
    /** Rewrite the file keeping only unacked entries (atomic). */
    compact(): void;
    private readLines;
    /** Append one line (serialized chain; failures only warn). */
    private append;
    /** Wait for the write chain (self-test / shutdown). */
    flush(): Promise<void>;
    getStats(): WalStats;
}
/** WAL file name (appended under mediaDir). */
export declare const WAL_FILE = "qq-inbox-wal.jsonl";
