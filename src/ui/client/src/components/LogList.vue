<script setup lang="ts">
import { ref, onMounted, defineExpose } from 'vue'
import { ElTable, ElTableColumn, ElTag } from 'element-plus'
import 'element-plus/dist/index.css'

interface LogItem {
  hash: string
  date: string
  author: string
  message: string
  branch?: string // 添加分支信息字段
}

const logs = ref<LogItem[]>([])
const errorMessage = ref('')

// 加载提交历史
async function loadLog() {
  try {
    const response = await fetch('/api/log')
    logs.value = await response.json()
    errorMessage.value = ''
  } catch (error) {
    errorMessage.value = '加载提交历史失败: ' + (error as Error).message
  }
}

onMounted(() => {
  loadLog()
})

// 暴露方法给父组件
defineExpose({
  refreshLog: loadLog
})
</script>

<template>
  <div class="card">
    <h2>提交历史</h2>
    <div v-if="errorMessage">{{ errorMessage }}</div>
    <div v-else>
      <el-table :data="logs" style="width: 100%" stripe>
        <el-table-column prop="hash" label="提交哈希" width="100" />
        <el-table-column prop="date" label="日期" width="180" />
        <el-table-column prop="author" label="作者" width="150" />
        <el-table-column label="分支" width="180">
          <template #default="scope">
            <div v-if="scope.row.branch" class="branch-container">
              <el-tag 
                v-for="(ref, index) in scope.row.branch.split(', ')" 
                :key="index"
                size="small"
                type="info"
                effect="light"
              >
                {{ ref }}
              </el-tag>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="message" label="提交信息" />
      </el-table>
    </div>
  </div>
</template>

<style>
.branch-container {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
</style>