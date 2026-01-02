<script setup lang="ts">
import { computed } from 'vue'
import type { FlowNodeData } from '../FlowOrchestrationWorkspace.vue'
import { $t } from '@/lang/static'

const props = defineProps<{
  data: FlowNodeData
  id: string
}>()

// 获取版本管理信息
const versionInfo = computed(() => {
  if (!props.data.config) return null
  const cfg: any = props.data.config
  const target = String(cfg?.versionTarget || 'version')
  const source = String(cfg?.versionSource || 'bump')

  const rows: Array<{ label: string; value: string }> = []

  rows.push({
    label: $t('@FLOWNODE:目标'),
    value: target === 'dependency' ? $t('@FLOWNODE:依赖版本') : $t('@FLOWNODE:version字段')
  })

  rows.push({
    label: $t('@FLOWNODE:来源'),
    value: source === 'reference' ? $t('@FLOWNODE:引用输出') : source === 'manual' ? $t('@FLOWNODE:手动输入') : $t('@FLOWNODE:自动递增')
  })

  const pkg = String(cfg?.packageJsonPath || '').trim()
  rows.push({
    label: $t('@FLOWNODE:package.json'),
    value: pkg ? pkg : $t('@FLOWNODE:当前目录')
  })

  if (target === 'dependency') {
    const depType = String(cfg?.dependencyType || 'dependencies')
    const depName = String(cfg?.dependencyName || '').trim()
    if (depName) {
      rows.push({ label: $t('@FLOWNODE:依赖'), value: `${depType}::${depName}` })
    }

    if (source === 'manual') {
      const depVer = String(cfg?.dependencyVersion || '').trim()
      if (depVer) rows.push({ label: $t('@FLOWNODE:版本号'), value: depVer })
    } else if (source === 'bump') {
      const bump = String(cfg?.dependencyVersionBump || cfg?.versionBump || 'patch')
      rows.push({ label: $t('@FLOWNODE:递增'), value: bump })
    } else if (source === 'reference') {
      const refNodeId = String(cfg?.inputRef?.nodeId || '').trim()
      const refKey = String(cfg?.inputRef?.outputKey || '').trim()
      const refText = refNodeId && refKey ? `${refNodeId}::${refKey}` : ''
      if (refText) rows.push({ label: $t('@FLOWNODE:引用'), value: refText })
    }
  } else {
    const bump = String(cfg?.versionBump || 'patch')
    rows.push({ label: $t('@FLOWNODE:递增'), value: bump })
  }

  return { target, rows }
})

</script>

<template>
  <div class="version-node-content">
    <div v-if="versionInfo?.target === 'dependency'" class="node-badge">
      {{ $t('@FLOWNODE:依赖') }}
    </div>

    <div v-if="versionInfo?.rows?.length" class="info-grid">
      <div v-for="(r, idx) in versionInfo.rows" :key="idx" class="info-row">
        <div class="info-label">{{ r.label }}</div>
        <div class="info-value" :title="r.value">{{ r.value }}</div>
      </div>
    </div>
    <div v-if="!data.config" class="node-warning">{{ $t('@FLOWNODE:未配置') }}</div>
  </div>
</template>

<style scoped lang="scss">
.version-node-content {
  .node-badge {
    display: inline-flex;
    align-items: center;
    padding: 2px 10px;
    border-radius: 999px;
    font-size: 11px;
    font-weight: 500;
    background: rgba(104, 189, 255, 0.15);
    color: var(--color-info);
    margin-top: 6px;
    max-width: 100%;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
  }

  .info-grid {
    margin-top: 6px;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .info-row {
    display: grid;
    grid-template-columns: 64px 1fr;
    gap: 8px;
    align-items: center;
  }

  .info-label {
    font-size: 11px;
    color: var(--text-secondary);
    line-height: 1.2;
  }

  .info-value {
    font-size: 11px;
    color: var(--text-title);
    line-height: 1.2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  
  .node-warning {
    color: var(--color-error);
    font-size: 12px;
    margin-top: 4px;
  }
}

</style>
