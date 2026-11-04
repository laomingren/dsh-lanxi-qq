/** One watchdog probe sample (NapCat login state). */
export interface StatusProbe {
    at: number;
    statusOk: boolean;
    online: boolean;
    loginOk: boolean;
}
/** Outbox section of the status snapshot (normalized defaults when absent). */
export interface StatusOutbox {
    enabled: boolean;
    pending: number;
    inFlight: number;
    failed: number;
    sent: number;
    dropped: number;
    deduped: number;
}
/** Inbound WAL section of the status snapshot. */
export interface StatusWal {
    enabled: boolean;
    unacked: number;
    enqWritten: number;
    replayed: number;
}
/** Full status snapshot (qq-status.json; badge / /status / panel same source). */
export interface StatusSnapshot {
    /** File existed and parsed (false = never written / corrupt). */
    available: boolean;
    connected: boolean;
    /** Connection mode (reverse/forward). */
    mode: string;
    selfId: string;
    lastConnectedAt: number;
    lastDisconnectedAt: number;
    lastDisconnectReason: string;
    disconnectCount: number;
    /** Seconds since last connect (0 when not connected). */
    connectedSinceSec: number;
    probe: StatusProbe;
    outbox: StatusOutbox;
    wal: StatusWal;
    errorsToday: number;
    /** Local day key (YYYY-MM-DD). */
    today: string;
    updatedAt: number;
    /** File older than STALE_AFTER_MS → the plugin may be stopped. */
    stale: boolean;
}
/** Fallback shape used when providers are missing. */
export interface StatusProviderStats {
    outbox?: () => Record<string, unknown> | undefined;
    wal?: () => Record<string, unknown> | undefined;
    selfId?: () => string | undefined;
}
/**
 * Live status store (P0 2026-11-02): connection flips, probe samples and a
 * periodic atomic write of mediaDir/qq-status.json. providers are filled by
 * the bridge after assembly (outbox/wal stat closures) to avoid a reverse
 * dependency on the bridge.
 */
export declare class StatusStore {
    private readonly dir;
    private readonly log;
    private readonly now;
    private readonly refreshMs;
    /** Filled by bridge after assembly. */
    providers: StatusProviderStats;
    private connected;
    private lastConnectedAt;
    private lastDisconnectedAt;
    private lastDisconnectReason;
    private disconnectCount;
    private probe;
    private errorsToday;
    private errorsDay;
    private mode;
    private writeChain;
    private refreshTimer;
    constructor(options?: {
        dir: string;
        log?: (level: 'info' | 'warn' | 'error' | 'debug', message: string) => void;
        now?: () => number;
        refreshMs?: number;
    });
    noteConnected(): void;
    noteDisconnected(reason?: string): void;
    noteProbe(sample: unknown): void;
    /** Count one ok:false event for today (resets on day rollover). */
    noteError(): void;
    /** Assemble the live snapshot (missing provider fields get safe defaults). */
    snapshot(): StatusSnapshot & { available: true };
    /** Atomic write (tmp + rename; serialized chain). */
    persist(): Promise<void>;
    /** Called by the bridge immediately on connection flips. */
    persistNow(): Promise<void>;
    /** Periodic refresh: persist first, then onTick (WAL counter refresh). */
    startRefresh(onTick?: () => void): void;
    stopRefresh(): void;
    flush(): Promise<void>;
}
/** Read-only side (settings-remote getStatus/getEvents; pure file reads). */
/** Read the status snapshot file; missing/corrupt → degraded snapshot. */
export declare function readStatusSnapshot(dir: string, now?: number): Promise<StatusSnapshot>;
/** Read the event file tail (newest first); chatId filters. Bad lines skipped. */
export declare function readRecentEvents(dir: string, limit?: number, chatId?: string): Promise<Array<{ ts: number; d: string; chatId: string; kind: string; ok: boolean; reason: string; mid?: string | number }>>;
/** Aggregate today's in/out counts from statsDir/<day>.jsonl (types only). */
export declare function readDailyStats(statsDir: string, now?: number): Promise<{
    day: string;
    in: number;
    out: number;
    byKind: Record<string, number>;
}>;
/** Effective mediaDir (config or <dsh-home>/media/onebot; same as index.js). */
export declare function resolveMediaDir(config?: { mediaDir?: string } | null): string;
/** Effective statsDir (config or <dsh-home>/data/onebot-stats; same as stats.js). */
export declare function resolveStatsDir(config?: { statsDir?: string } | null): string;
/** Local day bounds (epoch ms, system timezone). */
export declare function localDayBounds(now?: number): { start: number; end: number; day: string };
/** Status snapshot file name (appended under mediaDir; atomic replace). */
export declare const STATUS_FILE = "qq-status.json";
/** Snapshot refresh interval (ms). */
export declare const DEFAULT_REFRESH_MS = 5000;
/** File age beyond which the UI shows a grey "stale" badge. */
export declare const STALE_AFTER_MS = 60000;
