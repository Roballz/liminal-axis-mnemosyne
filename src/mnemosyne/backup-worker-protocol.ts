import type { BackupOutcome, BackupPreview, BackupSaveKind } from './core-backups';
import type { Package } from './migration';
import type { ReorganizationResult, ReorganizationProgress } from './core-reorganization';
import type { CorePackageSize } from './core-package-size';
import type { ArchiveRestoreResult } from './archive-package';
import type { HistoryCleanupReport } from './history-cleanup';

export type BackupJob = { library: string; branch?: string; kind: BackupSaveKind; keep: 10 } | { kind: 'preview'; key: string } |
    { kind: 'pin'; key: string; checksum: string } | { kind: 'restore'; key: string; checksum: string } |
    { kind: 'export'; library: string; branch?: string } | { kind: 'size'; library: string } |
    { kind: 'reorganize'; library: string } | { kind: 'clean-history'; library: string } | { kind: 'import'; blob: Blob } |
    { kind: 'archive-import'; library: string; blob: Blob; branch?: string; scope?: string } |
    { kind: 'archive-restore'; library: string; key: string; checksum: string; branch?: string; scope?: string };
export type BackupResult = BackupOutcome | { state: 'preview' | 'pinned'; entry: BackupPreview } |
    { state: 'exported'; blob: Blob; version: Package['version'] } | { state: 'restored'; library: string } |
    { state: 'archive-restored'; report: ArchiveRestoreResult } |
    { state: 'history-cleaned'; report: HistoryCleanupReport } |
    { state: 'size'; report: CorePackageSize } | { state: 'reorganized'; report: ReorganizationResult };
export type DiskCall = (
    { method: 'guard' | 'list' | 'readPreviews' } | { method: 'read' | 'remove'; key: string } |
    { method: 'write'; key: string; blob: Blob } | { method: 'writePreviews'; value: unknown }
);
export type DiskRequest = { type: 'rpc'; id: number } & DiskCall;
export type WorkerMessage = DiskRequest | { type: 'ready' } | { type: 'progress'; progress: ReorganizationProgress } |
    { type: 'verified'; entry: BackupPreview; unchanged?: true } | { type: 'done'; result: BackupResult } | { type: 'failed'; error: string };
export type HostMessage = { type: 'start'; job: BackupJob } |
    { type: 'reply'; id: number; result?: unknown; error?: string };
