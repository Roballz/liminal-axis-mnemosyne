<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import BbsSelect from './BbsSelect.vue';
import { BACKUP_LOCATION } from '@/st/native-backups';
import { fingerprint } from '@/mnemosyne/model';
import { activeLibrary, ACTIVE_KEY, DB_PREFIX } from '@/mnemosyne/db';
import { dailyState, invalidateDaily, syncDaily, serializeDailyActivation } from '@/mnemosyne/bridge';
import { AUTO_BACKUP_KEEP, backupFailure, type BackupInventory, type BackupPreview } from '@/mnemosyne/core-backups';
import { BACKUP_WAITING_STATUS, backupArchiveBlockReason, configureCoreBackups, coreBackupState, getCoreBackups, readCoreBackupPreview } from '@/mnemosyne/core-backup-runtime';

const inventory = shallowRef<BackupInventory>({ entries: [] });
const choice = ref(''), error = ref(''), notice = ref('');
const loading = ref(false), loadedAt = ref(0);
const currentBank = ref(''), metadataNotice = ref('');
const detail = shallowRef<BackupPreview>(), detailLoading = ref(false), detailError = ref('');
const blocked = computed(() => coreBackupState.enabled ? backupArchiveBlockReason(dailyState) : '');
const status = computed(() => blocked.value && coreBackupState.status === BACKUP_WAITING_STATUS
    ? '自动备份已启用，当前暂缓' : coreBackupState.status);
const listed = computed(() => inventory.value.entries.find(entry => entry.key === choice.value));
const selected = computed(() => detail.value?.key === choice.value ? detail.value : undefined);
const restoreAvailable = computed(() => !dailyState.pending || !!dailyState.error);
const kinds = { auto: '自动', manual: '手动起点', pinned: '固定保留', 'before-restore': '恢复前保护', 'before-deletion': '删除前最近核心包（保护）', 'before-archive-deletion': '档案删除前保护', 'after-archive-deletion': '档案删除后起点' };
const date = (time: number) => new Date(time).toLocaleString();
const size = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
const revision = () => `${dailyState.generation}:${dailyState.revision}:${dailyState.tableRevision}`;
const options = computed(() => [{ value: '', label: '请选择磁盘备份' }, ...inventory.value.entries.map(entry => ({
    value: entry.key, label: `${date(entry.preview?.snapshotAt ?? entry.savedAt)} · ${kinds[entry.kind]} · ${entry.bank === currentBank.value ? '当前库' : '其他库'} · ${entry.preview ? `${entry.preview.counts.stories} 故事 / ${entry.preview.counts.memories} 摘要（缓存，待校验）` : '详情待读取'}`,
}))]);
let disposed = false, detailGeneration = 0, listGeneration = 0;
onBeforeUnmount(() => { disposed = true; detailGeneration++; listGeneration++; });
function clearDetail() { detailGeneration++; detail.value = undefined; detailError.value = ''; detailLoading.value = false; }
async function previewSelection() {
    clearDetail();
    const key = choice.value, generation = detailGeneration;
    if (!listed.value || !key) return;
    const current = () => !disposed && generation === detailGeneration && choice.value === key;
    detailLoading.value = true;
    try {
        const entry = await readCoreBackupPreview(key, current);
        if (current()) detail.value = entry;
    } catch (error) { if (current()) detailError.value = backupFailure(error); }
    finally { if (current()) detailLoading.value = false; }
}
watch(choice, previewSelection);
async function run(task: () => Promise<void>) {
    if (coreBackupState.busy) return;
    coreBackupState.busy = true; error.value = ''; notice.value = '';
    try { await task(); }
    catch (e) { error.value = backupFailure(e); }
    finally { coreBackupState.busy = false; }
}
async function load() {
    loading.value = true; clearDetail(); metadataNotice.value = '';
    const generation = ++listGeneration;
    try {
        const backups = await getCoreBackups();
        const result = await backups.inventory();
        if (disposed) return;
        inventory.value = result;
        loadedAt.value = Date.now();
        currentBank.value = (await fingerprint(localStorage.getItem(ACTIVE_KEY) || `${DB_PREFIX}default`)).slice(0, 16);
        if (!result.entries.some(entry => entry.key === choice.value)) choice.value = '';
        // Filename results are already visible. Optional hints never delay or hide them.
        void backups.previewHints().then(hints => {
            if (disposed || generation !== listGeneration) return;
            const byKey = new Map(hints.map(entry => [entry.key, entry]));
            inventory.value = { entries: result.entries.map(entry => ({ ...entry, preview: entry.preview ?? byKey.get(entry.key) })) };
        }).catch(() => {
            if (!disposed && generation === listGeneration) metadataNotice.value = '预览元数据暂不可用；文件列表仍可用，选择后会校验原文件。';
        });
    } finally { loading.value = false; }
}
async function configure() {
    const enabled = !coreBackupState.enabled;
    if (enabled && !confirm(`启用后，仅在酒馆前台运行时每 30 分钟检查变化，每个库保留最近 ${AUTO_BACKUP_KEEP} 份自动核心包。新文件写入并读回验证后，会永久删除本功能多余的较旧自动备份；删除消息、缩短正文或删除档案不另存保护包；两次备份之间丢失的数据可能无法恢复。手动、固定、恢复前及已有历史保护文件不受影响。明文存于本机 TT 数据目录，不发送网络。启用？`)) return;
    await configureCoreBackups(enabled, AUTO_BACKUP_KEEP);
}
async function saveManual() {
    if (!confirm('把当前完整核心库另存为不会自动删除的备份，并设为本库今后自动备份的新起点？旧备份保留。')) return;
    const backups = await getCoreBackups(), lib = await activeLibrary();
    const selector = localStorage.getItem(ACTIVE_KEY), stamp = revision();
    const result = await backups.save(lib, 'manual', coreBackupState.keep,
        () => !disposed && !dailyState.pending && selector === localStorage.getItem(ACTIVE_KEY) && stamp === revision());
    if (result.state === 'saved') notice.value = '手动保护备份已写入并验证；已明确设为本库新的自动备份起点。该文件不会自动删除。';
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
    <details class="mn-card mn-backups">
        <summary>本机磁盘核心包备份</summary>
        <div class="mn-backup-content">
            <p class="mn-muted">核心库独立保存在 TT 数据目录，本机明文存储，不上传。</p>
            <p v-if="coreBackupState.error || error" class="mn-warning mn-backup-feedback" role="alert">{{ error || coreBackupState.error }}</p>
            <p v-if="notice" class="mn-backup-feedback" role="status">{{ notice }}</p>

            <section class="mn-backup-section" aria-label="自动备份设置">
                <div class="mn-backup-heading">
                    <h4>自动备份</h4>
                    <button v-if="coreBackupState.available" type="button" :disabled="coreBackupState.busy" @click="run(configure)">{{ coreBackupState.enabled ? '关闭自动备份' : '启用自动备份' }}</button>
                </div>
                <p>每库固定保留最近 {{ AUTO_BACKUP_KEEP }} 份 · 间隔至少 30 分钟</p>
                <p class="mn-muted">仅在酒馆前台稳定时检查；无变化不重复保存。</p>
                <p class="mn-backup-status" role="status">{{ status }}</p>
                <p v-if="blocked" class="mn-warning" role="status">自动备份暂缓：{{ blocked }}。处理后继续检查，启用不代表已写入。</p>
                <button v-if="coreBackupState.available && dailyState.error" class="mn-backup-retry" type="button" :disabled="coreBackupState.busy" @click="run(async () => { await syncDaily(); notice = '归档重试完成'; })">重试归档</button>
                <div v-if="coreBackupState.available" class="mn-backup-manual">
                    <div>
                        <h4>手动备份</h4>
                        <p class="mn-muted">额外保留，不自动轮换；设为自动备份新起点。</p>
                    </div>
                    <button type="button" :disabled="coreBackupState.busy || dailyState.pending" @click="run(saveManual)">手动保存为新起点</button>
                </div>
            </section>

            <section class="mn-backup-section" aria-label="备份文件与恢复">
                <div class="mn-backup-heading">
                    <h4>备份文件</h4>
                    <button type="button" :disabled="coreBackupState.busy" @click="run(load)">{{ loading ? '正在读取备份列表…' : loadedAt ? '刷新备份列表' : '读取备份列表' }}</button>
                </div>
                <p class="mn-backup-path"><span class="mn-muted">保存路径：</span><span>{{ BACKUP_LOCATION }}</span></p>
                <p v-if="loading" class="mn-muted" role="status">正在连接原生接口并读取备份列表…</p>
                <template v-if="coreBackupState.available">
                    <p v-if="loadedAt" class="mn-muted" role="status">已读取（{{ date(loadedAt) }}）；找到 {{ inventory.entries.length }} 份备份文件，尚未逐份校验。<template v-if="!inventory.entries.length">当前目录没有本功能识别的备份文件。</template></p>
                    <p v-else class="mn-muted">尚未读取列表，备份数量未知。</p>
                    <p v-if="metadataNotice" class="mn-muted">{{ metadataNotice }}</p>
                    <BbsSelect v-model="choice" :options="options" aria-label="待校验的磁盘核心包" />
                    <div v-if="listed" class="mn-backup-detail" aria-label="所选备份详情">
                        <h4>所选备份</h4>
                        <p v-if="!selected">{{ date(listed.savedAt) }} · {{ kinds[listed.kind] }} · 尚未验证可恢复性</p>
                        <p v-if="detailLoading" role="status">正在后台读取并校验所选备份，不扫描其他文件…</p>
                        <p v-if="detailError" class="mn-warning" role="alert">所选文件无法验证，未删除，也不能恢复：{{ detailError }}</p>
                        <button v-if="!selected && !detailLoading" type="button" :disabled="coreBackupState.busy" @click="previewSelection">校验这份备份</button>
                        <template v-if="selected">
                            <p class="mn-backup-status">所选备份完整校验通过；操作前仍会重读校验。</p>
                            <p>{{ date(selected.snapshotAt) }} · {{ kinds[selected.kind] }} · {{ size(selected.bytes) }}</p>
                            <p>{{ selected.counts.stories }} 故事 · {{ selected.counts.branches }} 分支 · {{ selected.counts.source_messages }} 消息身份 · {{ selected.counts.memories }} 摘要 · {{ selected.counts.event_chains }} 事件链 · {{ selected.counts.custom_table_rows }} 表格行</p>
                            <p class="mn-muted mn-backup-wrap">来源库：{{ selected.sourceLibrary }}</p>
                            <p v-if="selected.kind === 'before-deletion' || selected.kind === 'before-archive-deletion'" class="mn-muted">旧版保护文件仍保留，不参与轮换，也不再新建；以核心包时间为准。</p>
                        </template>
                        <p class="mn-muted mn-backup-wrap">文件路径：{{ BACKUP_LOCATION }}{{ listed.key }}</p>
                        <div class="mn-backup-actions">
                            <button type="button" :disabled="coreBackupState.busy || !selected || selected.kind !== 'auto'" @click="run(pin)">固定保留一份副本</button>
                            <button type="button" :disabled="coreBackupState.busy || !selected || !restoreAvailable" @click="run(restore)">从这份核心包恢复…</button>
                        </div>
                    </div>
                    <p class="mn-muted">只校验选中的文件；列表和缓存不代表可恢复。</p>
                </template>
            </section>

            <details class="mn-backup-notes">
                <summary>备份范围与注意事项</summary>
                <ul class="mn-muted">
                    <li>仅含核心库，不含知识库、字体、向量、密钥或宿主聊天。文件独立于 WebView 数据库和插件安装目录，但卸载、清除 TT 数据或磁盘损坏仍可能丢失，请另行导出重要资料。</li>
                    <li>每库正常轮换保留最近 {{ AUTO_BACKUP_KEEP }} 份自动备份；清理未完成时可能暂时超出。手动、固定、恢复前副本及已有历史保护包仍保留，总文件数可能超过 {{ AUTO_BACKUP_KEEP }}；旧库不自动清理。</li>
                    <li>删除消息、缩短正文或删除档案不再额外备份。{{ AUTO_BACKUP_KEEP }} 个半小时恢复点约对应 10 小时活跃使用，不保证连续覆盖最近 10 小时；未运行、后台、无变化或失败时不补齐。两次备份之间丢失的数据可能无法恢复。</li>
                    <li>后台或关闭酒馆后不发起新备份，已提交的写入可能完成。失败会延后重试并保留旧副本；单文件原子发布不等于断电持久化保证。</li>
                </ul>
            </details>
        </div>
    </details>
</template>

<style scoped>
.mn-backups { min-width: 0; }
.mn-backups > summary { font-weight: 600; }
.mn-backup-content { display: grid; gap: 16px; min-width: 0; padding-top: 12px; }
.mn-backups p, .mn-backups h4 { margin: 0; }
.mn-backups h4 { font-size: 14px; font-weight: 600; }
.mn-backups button { min-height: 40px; line-height: 1.5; white-space: normal; overflow-wrap: anywhere; }
.mn-backup-section { display: grid; gap: 10px; min-width: 0; padding: 14px; border: 1px solid var(--bbs-line); border-radius: var(--bbs-radius); }
.mn-backup-heading, .mn-backup-manual { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; }
.mn-backup-heading h4 { flex: 1 1 auto; }
.mn-backup-heading button { flex: 0 1 auto; }
.mn-backup-status { color: var(--bbs-ink-soft); font-size: 13px; }
.mn-backup-feedback { padding: 10px 12px; border-radius: var(--bbs-radius-sm); background: var(--bbs-surface-2); overflow-wrap: anywhere; }
.mn-backups .mn-warning { color: var(--bbs-danger); overflow-wrap: anywhere; }
.mn-backup-retry { justify-self: start; }
.mn-backup-manual { border-top: 1px solid var(--bbs-line); margin-top: 2px; padding-top: 12px; }
.mn-backup-manual > div { flex: 1 1 220px; min-width: 0; display: grid; gap: 4px; }
.mn-backup-path { display: grid; gap: 4px; min-width: 0; padding: 10px 12px; background: var(--bbs-surface-2); border-radius: var(--bbs-radius-sm); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.mn-backup-wrap { min-width: 0; overflow-wrap: anywhere; }
.mn-backup-detail { display: grid; gap: 10px; min-width: 0; padding-top: 12px; border-top: 1px solid var(--bbs-line); }
.mn-backup-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.mn-backup-actions button { flex: 1 1 180px; }
.mn-backup-notes { min-width: 0; border-top: 1px solid var(--bbs-line); padding-top: 12px; }
.mn-backup-notes summary { color: var(--bbs-ink-soft); font-size: 13px; }
.mn-backup-notes ul { display: grid; gap: 8px; margin: 10px 0 0; padding-left: 20px; }
.mn-backups :deep(.bbs-select-trigger) { min-height: 44px; }
@media (max-width: 480px) {
    .mn-backups { padding: 12px; }
    .mn-backup-section { padding: 12px; }
    .mn-backup-manual > button { width: 100%; }
}
</style>
