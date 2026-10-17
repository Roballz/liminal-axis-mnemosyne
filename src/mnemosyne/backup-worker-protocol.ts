import type { BackupOutcome, BackupPreview } from './core-backups';

export type BackupJob = { library: string; kind: 'auto'; keep: 20 } | { kind: 'preview'; key: string };
export type BackupResult = BackupOutcome | { state: 'preview'; entry: BackupPreview };
export type DiskCall = (
    { method: 'guard' | 'list' | 'readPreviews' } | { method: 'read' | 'remove'; key: string } |
    { method: 'write'; key: string; blob: Blob } | { method: 'writePreviews'; value: unknown }
);
export type DiskRequest = { type: 'rpc'; id: number } & DiskCall;
export type WorkerMessage = DiskRequest | { type: 'ready' } |
    { type: 'done'; result: BackupResult } | { type: 'failed'; error: string };
export type HostMessage = { type: 'start'; job: BackupJob } |
    { type: 'reply'; id: number; result?: unknown; error?: string };
