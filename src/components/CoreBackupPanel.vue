<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import BbsSelect from './BbsSelect.vue';
import { BACKUP_LOCATION } from '@/st/native-backups';
import { activeLibrary, ACTIVE_KEY, DB_PREFIX } from '@/mnemosyne/db';
import { dailyState, invalidateDaily, syncDaily, serializeDailyActivation } from '@/mnemosyne/bridge';
import { backupFailure, type BackupInventory, type BackupPreview } from '@/mnemosyne/core-backups';
import { BACKUP_WAITING_STATUS, backupArchiveBlockReason, configureCoreBackups, coreBackupState, getCoreBackups, retryCoreBackups, retryDeletionProtection, reportArchiveProtection } from '@/mnemosyne/core-backup-runtime';

const inventory = shallowRef<BackupInventory>({ entries: [], invalid: [] });
const choice = ref(''), keep = ref<5 | 10>(10), error = ref(''), notice = ref('');
const loading = ref(false), loadedAt = ref(0);
const currentLibrary = ref('');
const blocked = computed(() => coreBackupState.enabled ? backupArchiveBlockReason(dailyState) : '');
const status = computed(() => blocked.value && coreBackupState.status === BACKUP_WAITING_STATUS
    ? '自动备份已启用，当前暂缓' : coreBackupState.status);
const selected = computed(() => inventory.value.entries.find(entry => entry.key === choice.value));
const restoreAvailable = computed(() => !dailyState.pending || !!dailyState.error);
const totalBytes = computed(() => inventory.value.entries.reduce((sum, entry) => sum + entry.bytes, 0));
const kinds = { auto: '自动', manual: '手动起点', pinned: '固定保留', 'before-restore': '恢复前保护', 'before-deletion': '删除前最近核心包（保护）', 'before-archive-deletion': '档案删除前保护', 'after-archive-deletion': '档案删除后起点' };
const date = (time: number) => new Date(time).toLocaleString();
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const revision = () => `${dailyState.generation}:${dailyState.revision}:${dailyState.tableRevision}`;
const options = computed(() => [{ value: '', label: '请选择磁盘备份' }, ...inventory.value.entries.map(entry => ({
    value: entry.key, label: `${date(entry.snapshotAt)} · ${kinds[entry.kind]} · ${entry.counts.stories} 故事 / ${entry.counts.memories} 摘要 · ${entry.sourceLibrary === currentLibrary.value ? '当前库' : '其他库'}`,
}))]);
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
async function run(task: () => Promise<void>) {
    if (coreBackupState.busy) return;
    coreBackupState.busy = true; error.value = ''; notice.value = '';
    try { await task(); }
    catch (e) { error.value = backupFailure(e); }
    finally { coreBackupState.busy = false; }
}
async function load() {
    loading.value = true;
    try {
        const backups = await getCoreBackups();
        const result = await backups.inventory();
        if (disposed) return;
        inventory.value = result;
        loadedAt.value = Date.now();
        currentLibrary.value = localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`;
        keep.value = coreBackupState.keep;
        if (!result.entries.some(entry => entry.key === choice.value)) choice.value = '';
    } finally { loading.value = false; }
}
async function configure() {
    const enabled = !coreBackupState.enabled;
    if (enabled && !confirm(`启用后，仅在酒馆前台运行时每 30 分钟检查变化，每个库保留最近 ${keep.value} 份自动核心包。新文件写入并读回验证后，会永久删除本功能多余的较旧自动备份；手动、固定保留、恢复前保护、删除前保护、档案删除保护/起点和其他库文件不受影响。明文存于本机 TT 数据目录，不发送网络。启用？`)) return;
    await configureCoreBackups(enabled, keep.value);
}
async function saveManual() {
    if (!confirm('把当前完整核心库另存为不会自动删除的备份，并设为本库今后自动备份的新起点？如果先前检测到资料减少，请先核对是否需要恢复。旧备份保留。')) return;
    const backups = await getCoreBackups(), lib = await activeLibrary();
    const selector = localStorage.getItem(ACTIVE_KEY), stamp = revision();
    const result = await backups.save(lib, 'manual', coreBackupState.keep,
        () => !disposed && !dailyState.pending && selector === localStorage.getItem(ACTIVE_KEY) && stamp === revision());
    if (result.state === 'saved') notice.value = '手动保护备份已写入并验证；已明确设为本库新的自动备份起点。该文件不会自动删除。';
    await load();
}
async function acceptArchiveLoss() {
    const backups = await getCoreBackups(), lib = await activeLibrary();
    const selector = localStorage.getItem(ACTIVE_KEY), stamp = revision();
    const approval = await backups.previewArchiveLoss(lib);
    if (!confirm(`确认这些档案是你主动删除的，并接受当前库作为新的自动备份起点？\n故事 ${approval.previous.counts.stories} → ${approval.currentCounts.stories}，分支 ${approval.previous.counts.branches} → ${approval.currentCounts.branches}，摘要 ${approval.previous.counts.memories} → ${approval.currentCounts.memories}。\n会先保护 ${date(approval.previous.snapshotAt)} 最近已保存的完整旧包；它可能没有删除前尚未备份的数据。恢复旧档案需要恢复整个核心包，不会恢复宿主聊天。旧包验证成功后才保存当前起点。`)) return;
    const guard = () => !disposed && selector === localStorage.getItem(ACTIVE_KEY) && stamp === revision();
    const result = await backups.acceptArchiveLoss(lib, approval, guard, entry => reportArchiveProtection(entry, false));
    if (result.state === 'saved') {
        coreBackupState.error = '';
        coreBackupState.status = coreBackupState.enabled ? '旧包已保护，当前档案已设为新起点；自动备份继续检查' : '旧包已保护，当前档案已设为新起点；自动备份尚未启用';
        notice.value = coreBackupState.status;
        retryCoreBackups();
    }
    await load();
}
async function pin() {
    const entry = selected.value;
    if (!entry) return;
    const saved = await (await getCoreBackups()).pin(entry.key, entry.checksum);
    await load(); choice.value = saved.key;
    notice.value = '已另存为固定保留的副本，不参与自动轮换。';
}
async function restore() {
    const entry = selected.value;
    if (!entry) return;
    if (!confirm(`恢复 ${date(entry.snapshotAt)} 的核心包（${entry.counts.stories} 个故事、${entry.counts.memories} 条摘要）？会先保护当前非空核心库，再写入新空库，校验成功后切换。随后会按当前宿主聊天执行普通归档同步，可能更新恢复库中的当前正文，并将来源变化的旧摘要等标为待审核；不会改写宿主聊天。原库和这份磁盘备份保留。继续？`)) return;
    const backups = await getCoreBackups();
    const selector = localStorage.getItem(ACTIVE_KEY), stamp = revision(), archiveError = dailyState.error;
    // pending also latches after a failure. The serial boundary below drains real
    // source writers; this stamp additionally revokes stale choices/derived edits.
    const valid = () => !disposed && (!dailyState.pending || !!archiveError && dailyState.error === archiveError) &&
        choice.value === entry.key && selector === localStorage.getItem(ACTIVE_KEY) && stamp === revision();
    const switched = await serializeDailyActivation(async () => {
        if (!valid()) throw new Error('聊天、档案或选择已改变，请重新预览恢复');
        try { await backups.save(await activeLibrary(), 'before-restore', coreBackupState.keep, valid); }
        catch (e) {
            if (!valid() || !confirm(`当前库的保护备份未成功：${backupFailure(e)}。仍要恢复所选备份吗？原 IndexedDB 库会保留，但本次未另存保护文件。`)) return false;
        }
        await backups.restore(entry.key, entry.checksum, valid);
        return true;
    });
    if (!switched) return;
    // Never await syncDaily inside its own serial boundary.
    invalidateDaily();
    try { await syncDaily(); }
    catch { notice.value = '核心包已校验并恢复到新库，原库保留；当前聊天需要在档案页核对绑定。'; }
    if (!notice.value) notice.value = '核心包已校验并恢复到新库，原库和旧库磁盘备份保留。';
    await load();
}
</script>

<template>
    <details class="mn-card">
        <summary>本机磁盘核心包备份</summary>
        <p>备份独立于 WebView 数据库，保存在 TT 数据目录。插件更新不依赖安装文件夹里的副本。</p>
        <p style="overflow-wrap: anywhere">{{ BACKUP_LOCATION }}</p>
        <p class="mn-muted">仅含核心包，不含知识库、字体、向量、密钥或宿主聊天。文件为明文；不发送到网络。无法防止卸载、清除 TT 应用数据或整块磁盘损坏，重要资料仍请另行导出。</p>
        <p role="status">{{ status }}</p>
        <p v-if="blocked" class="mn-warning" role="status">自动备份暂缓：{{ blocked }}。处理后会继续检查；启用状态不代表已写入备份。</p>
        <p v-if="coreBackupState.error || error" class="mn-warning" role="alert">{{ error || coreBackupState.error }}</p>
        <p v-if="coreBackupState.protectionNotice" role="status" style="overflow-wrap: anywhere">{{ coreBackupState.protectionNotice }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <p v-if="loading" role="status">正在连接原生接口并读取备份列表…</p>
        <button :disabled="coreBackupState.busy" @click="run(load)">{{ loading ? '正在读取备份列表…' : '读取备份列表' }}</button>
        <template v-if="coreBackupState.available">
            <label>每个库保留的自动备份数
                <select v-model.number="keep" :disabled="coreBackupState.busy || coreBackupState.enabled">
                    <option :value="10">10 份（默认）</option><option :value="5">5 份</option>
                </select>
            </label>
            <button :disabled="coreBackupState.busy" @click="run(configure)">{{ coreBackupState.enabled ? '关闭自动备份' : '启用自动备份' }}</button>
            <p class="mn-muted">前台稳定后开始检查，同一库的自动备份至少间隔 30 分钟；没有变化不重复写入。退到后台或关闭酒馆时停止发起新备份，已经交给宿主的写入可能完成。写入失败会延后重试，旧副本保留；原生接口提供单文件原子发布，但不承诺断电持久化。</p>
            <button v-if="coreBackupState.enabled && dailyState.error" :disabled="coreBackupState.busy" @click="run(async () => { retryDeletionProtection(); await syncDaily(); notice = '归档重试完成，自动备份继续检查'; })">重试删除前保护 / 归档</button>
            <button v-if="coreBackupState.enabled" :disabled="coreBackupState.busy || !!blocked" @click="retryCoreBackups">重试自动备份检查（仍保留保护校验）</button>
            <button :disabled="coreBackupState.busy" @click="run(acceptArchiveLoss)">保护旧包并接受当前档案（恢复自动备份）…</button>
            <button :disabled="coreBackupState.busy || dailyState.pending" @click="run(saveManual)">手动保存并设为新起点（不轮换）</button>
            <p v-if="loadedAt" role="status">接口读取成功（{{ date(loadedAt) }}）；已验证 {{ inventory.entries.length }} 份，共 {{ size(totalBytes) }}。<template v-if="!inventory.entries.length">当前没有已验证的可恢复备份。</template></p>
            <p v-else class="mn-muted">尚未读取磁盘备份列表，备份数量未知。</p>
            <p>每个库各保留 {{ coreBackupState.keep }} 份自动备份；手动 / 固定 / 恢复前 / 删除前 / 档案删除保护及起点副本额外保留，可能使总数更多。旧库不会自动清理。</p>
            <p v-if="inventory.invalid.length" class="mn-warning">{{ inventory.invalid.length }} 份文件无法验证，未删除；不计入上面的已验证数量和大小，也不可用于恢复。</p>
            <BbsSelect v-model="choice" :options="options" aria-label="可恢复的磁盘核心包" />
            <div v-if="selected" class="mn-card">
                <p>{{ date(selected.snapshotAt) }} · {{ kinds[selected.kind] }} · {{ size(selected.bytes) }}</p>
                <p>{{ selected.counts.stories }} 故事 · {{ selected.counts.branches }} 分支 · {{ selected.counts.source_messages }} 消息身份 · {{ selected.counts.memories }} 摘要 · {{ selected.counts.event_chains }} 事件链 · {{ selected.counts.custom_table_rows }} 表格行</p>
                <p style="overflow-wrap: anywhere">来源库：{{ selected.sourceLibrary }}</p>
                <p style="overflow-wrap: anywhere">文件路径：{{ BACKUP_LOCATION }}{{ selected.key }}</p>
                <p v-if="selected.kind === 'before-deletion' || selected.kind === 'before-archive-deletion'" class="mn-muted">此文件保护最近已保存的完整核心包，以显示的核心包时间为准；可能不含删除前尚未备份的楼层，不参与自动轮换。</p>
                <small>列表数量只用于预览；恢复前会重新读文件并校验完整核心包。</small>
                <div class="mn-actions">
                    <button :disabled="coreBackupState.busy || selected.kind !== 'auto'" @click="run(pin)">固定保留一份副本</button>
                    <button :disabled="coreBackupState.busy || !restoreAvailable" @click="run(restore)">从这份核心包恢复…</button>
                </div>
            </div>
        </template>
    </details>
</template>
