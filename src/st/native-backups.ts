/** Native TT extension store. No HTTP, IndexedDB, OPFS, or install-directory fallback. */
export const BACKUP_NAMESPACE = 'mnemosyne-core-backups';
export const BACKUP_TABLE = 'snapshots-v1';
export const BACKUP_LOCATION = `data_root/_tauritavern/extension-store/${BACKUP_NAMESPACE}/blobs/${BACKUP_TABLE}/`;

export interface BackupDisk {
    list(): Promise<string[]>;
    read(key: string): Promise<Blob>;
    write(key: string, data: Blob): Promise<void>;
    remove(key: string): Promise<void>;
    readSettings(): Promise<unknown>;
    writeSettings(value: unknown): Promise<void>;
}

export async function nativeBackupDisk(host: any = globalThis): Promise<BackupDisk> {
    const tt = host.__TAURITAVERN__;
    if (!tt) throw new Error('当前宿主没有 TauriTavern 原生文件备份接口；仍可手动导出核心包');
    await (tt.ready ?? host.__TAURITAVERN_MAIN_READY__);
    const store = tt.api?.extension?.store;
    const methods = ['listBlobKeys', 'getBlob', 'setBlob', 'deleteBlob', 'tryGetJson', 'setJson'];
    if (!store || methods.some(name => typeof store[name] !== 'function'))
        throw new Error('当前 TauriTavern 文件接口不完整，自动磁盘备份不可用');
    const table = { namespace: BACKUP_NAMESPACE, table: BACKUP_TABLE };
    const settings = { namespace: BACKUP_NAMESPACE, table: 'settings-v1', key: 'config' };
    return {
        list: () => store.listBlobKeys(table),
        read: key => store.getBlob({ ...table, key }),
        write: (key, data) => store.setBlob({ ...table, key, data }),
        remove: key => store.deleteBlob({ ...table, key }),
        readSettings: async () => {
            const result = await store.tryGetJson(settings);
            if (!result || typeof result.found !== 'boolean') throw new Error('备份设置读取结果不完整');
            return result.found ? result.value : undefined;
        },
        writeSettings: value => store.setJson({ ...settings, value }),
    };
}
