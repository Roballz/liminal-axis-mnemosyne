<script setup lang="ts">
import { ref, shallowRef, onBeforeUnmount } from 'vue';
import { inspectCoreLibraries, setCoreLibraryDisabled, type CoreLibraryInventory } from '@/mnemosyne/library-management';
const inventory = shallowRef<CoreLibraryInventory>();
const busy = ref(false), error = ref(''), notice = ref('');
let disposed = false;
onBeforeUnmount(() => { disposed = true; });
async function refresh() {
    if (busy.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try { const result = await inspectCoreLibraries(); if (!disposed) inventory.value = result; }
    catch (e) { if (!disposed) { inventory.value = undefined; error.value = (e as Error).message; } }
    finally { busy.value = false; }
}
async function change(name: string, disabled: boolean) {
    if (busy.value || !inventory.value) return;
    busy.value = true; error.value = ''; notice.value = '';
    try {
        await setCoreLibraryDisabled(name, disabled, inventory.value.current);
        const result = await inspectCoreLibraries();
        if (!disposed) { inventory.value = result; notice.value = disabled
            ? '已禁用此旧库，数据保留，不能再用于归档或继承。'
            : '已解除禁用，当前使用的核心库未切换。'; }
    } catch (e) { if (!disposed) error.value = (e as Error).message; }
    finally { busy.value = false; }
}
</script>
<template>
    <details class="mn-card">
        <summary>核心库管理</summary>
        <p>迁移后仅使用当前库，保留的旧库不会合并进当前核心包。禁用可阻止误用，不删除数据、不释放占用空间。</p>
        <button :disabled="busy" @click="refresh">检查当前库与旧库</button>
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-if="notice" role="status">{{ notice }}</p>
        <template v-if="inventory">
            <p>当前存储：{{ inventory.shared ? '共享存储新库' : '未整理的存储格式' }}</p>
            <p v-if="!inventory.enumerable">当前浏览器不支持列出其他库；未扫描或改动旧库。</p>
            <div v-for="entry in inventory.entries" :key="entry.name" class="mn-card">
                <strong>{{ entry.current ? '当前使用中' : entry.disabled ? '已禁用' : '非当前库 · 未使用' }}</strong>
                <small class="mn-library-name">{{ entry.name }}</small>
                <button v-if="!entry.current" :disabled="busy" @click="change(entry.name, !entry.disabled)">
                    {{ entry.disabled ? '解除禁用' : '禁用此旧库' }}
                </button>
            </div>
        </template>
    </details>
</template>
<style scoped>
.mn-library-name { display: block; overflow-wrap: anywhere; margin: .4rem 0; opacity: .75; }
</style>
