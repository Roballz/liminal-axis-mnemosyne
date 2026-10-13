import { expect, test, vi } from 'vitest';
import { BACKUP_NAMESPACE, BACKUP_TABLE, nativeBackupDisk } from './native-backups';

test('native adapter fails closed without exact public TT methods; no browser storage fallback', async () => {
    await expect(nativeBackupDisk({})).rejects.toThrow('原生文件');
    await expect(nativeBackupDisk({ __TAURITAVERN__: { api: { extension: { store: {} } } } })).rejects.toThrow('不完整');
});

test('native operations stay in the owned data-root namespace and preserve read/write failures', async () => {
    const store = Object.fromEntries(['listBlobKeys', 'getBlob', 'setBlob', 'deleteBlob', 'tryGetJson', 'setJson'].map(name => [name, vi.fn()]));
    store.tryGetJson.mockResolvedValue({ found: false });
    const disk = await nativeBackupDisk({ __TAURITAVERN__: { ready: Promise.resolve(), api: { extension: { store } } } });
    const data = new Blob(['synthetic']);
    await disk.write('file.json', data);
    expect(store.setBlob).toHaveBeenCalledWith({ namespace: BACKUP_NAMESPACE, table: BACKUP_TABLE, key: 'file.json', data });
    expect(await disk.readSettings()).toBeUndefined();
    store.listBlobKeys.mockRejectedValue(new Error('native directory denied'));
    await expect(disk.list()).rejects.toThrow('directory denied');
    store.tryGetJson.mockRejectedValue(new Error('native read failed'));
    await expect(disk.readSettings()).rejects.toThrow('native read failed');
    expect(store.deleteBlob).not.toHaveBeenCalled();
});
