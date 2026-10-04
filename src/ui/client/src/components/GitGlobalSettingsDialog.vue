<!--
  ~ Copyright 2026 xz333221
  ~
  ~ Licensed under the Apache License, Version 2.0 (the "License");
  ~ you may not use this file except in compliance with the License.
  ~ You may obtain a copy of the License at
  ~
  ~     http://www.apache.org/licenses/LICENSE-2.0
  ~
  ~ Unless required by applicable law or agreed to in writing, software
  ~ distributed under the License is distributed on an "AS IS" BASIS,
  ~ WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  ~ See the License for the specific language governing permissions and
  ~ limitations under the License.
  -->
<template>
  <CommonDialog
    v-model="visible"
    :title="$t('@42BB9:设置')"
    size="large"
    :destroy-on-close="true"
    custom-class="user-settings-dialog"
    @update:model-value="handleVisibleChange"
  >
    <div
      class="user-settings-content"
      v-loading="isLoading"
      :element-loading-text="$t('@42BB9:正在加载配置...')"
      element-loading-background="rgba(0, 0, 0, 0.15)"
    >
      <!-- 左侧标签页切换 -->
      <div class="settings-tabs">
        <div
          class="tab-item"
          :class="{ active: activeTab === 'general' }"
          @click="activeTab = 'general'"
        >
          <span>{{ $t('@42BB9:通用设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'ai-models' }"
          @click="activeTab = 'ai-models'"
        >
          <span>{{ $t('@42BB9:AI 模型配置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'git' }"
          @click="activeTab = 'git'"
        >
          <span>{{ $t('@42BB9:Git 全局设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'commit' }"
          @click="activeTab = 'commit'"
        >
          <span>{{ $t('@42BB9:提交设置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'config' }"
          @click="onClickConfigTab"
        >
          <span>{{ $t('@42BB9:编辑配置') }}</span>
        </div>
        <div
          class="tab-item"
          :class="{ active: activeTab === 'editor' }"
          @click="activeTab = 'editor'"
        >
          <span>{{ $t('@42BB9:编辑器设置') }}</span>
        </div>
        <!-- 记忆库：懒加载 —— 点进来才拉，否则打开设置弹窗就多一次无用请求。
             与「编辑配置」tab 同一套约定（见 onClickConfigTab）。 -->
        <div
          class="tab-item"
          :class="{ active: activeTab === 'memory' }"
          @click="onClickMemoryTab"
        >
          <span>{{ $t('@42BB9:记忆库') }}</span>
        </div>
      </div>

      <!-- 右侧内容区域 -->
      <div class="settings-panels">
        <!-- 通用设置面板 -->
        <div v-show="activeTab === 'general'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:通用配置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:自定义应用的外观和语言') }}</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:外观') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:主题') }}</label>
                <el-select v-model="tempTheme" class="modern-input" size="default">
                  <el-option :label="$t('@42BB9:浅色')" value="light" />
                  <el-option :label="$t('@42BB9:深色')" value="dark" />
                  <el-option :label="$t('@42BB9:跟随系统')" value="auto" />
                </el-select>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:语言') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:界面语言') }}</label>
                <el-select v-model="tempLocale" class="modern-input" size="default">
                  <el-option label="简体中文" value="zh-CN" />
                  <el-option label="English" value="en-US" />
                </el-select>
              </div>
            </div>
          </div>

          <!-- 任务执行：工作台任务默认用哪个本地 CLI 执行 -->
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:任务执行') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:任务执行器') }}</label>
                <div class="project-toggle">
                  <!-- fit-input-width=false：下拉宽度跟着**内容**走。默认跟输入框等宽，
                       而这个选项里要同时放「产品名 + 模型名」，等宽会把模型名截成
                       `opencode-go/space-bunny-…`（实测），等于白显示 -->
                  <el-select
                    v-model="tempTaskExecutor"
                    class="modern-input"
                    size="default"
                    :fit-input-width="false"
                  >
                    <el-option
                      v-for="opt in TASK_EXECUTOR_OPTIONS"
                      :key="opt.id"
                      :label="opt.name"
                      :value="opt.id"
                      :disabled="!toolsStore.isToolAvailable(opt.id)"
                    >
                      <span class="executor-option">
                        <TaskExecutorIcon :executor="opt.id" class="executor-option__icon" />
                        {{ opt.name }}
                        <span
                          v-if="toolsStore.executorModelText(opt.id)"
                          class="executor-option__model"
                          :title="optionExecutorModelTitle(opt.id)"
                        >{{ toolsStore.executorModelText(opt.id) }}</span>
                        <span v-if="!toolsStore.isToolAvailable(opt.id)" class="executor-option__missing">{{ $t('@42BB9:未安装') }}</span>
                      </span>
                    </el-option>
                  </el-select>
                  <span class="setting-hint-block">{{ $t('@42BB9:工作台执行任务时使用的本地 CLI；模型跟随各自 CLI 的自身配置') }}</span>
                  <!-- 当前模型：把"模型跟随各自 CLI 的自身配置"这句话落到实处 -->
                  <span
                    v-if="selectedExecutorModelText"
                    class="setting-hint-block executor-model-line"
                    :title="$t('@42BB9:当前模型：{model}', { model: selectedExecutorModelLineTitle })"
                  >
                    {{ $t('@42BB9:当前模型：{model}', { model: selectedExecutorModelText }) }}
                    <span v-if="selectedExecutorModelDetail" class="executor-model-line__detail">（{{ selectedExecutorModelDetail }}）</span>
                  </span>
                </div>
              </div>

              <!-- 任务 / 对话执行结束提示：跑完一个任务或一轮对话时给个动静（页面在后台发系统通知） -->
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:任务与对话完成提示') }}</label>
                <div class="project-toggle">
                  <el-switch v-model="tempNotifyOnTaskDone" @change="onNotifyToggleChange" />
                  <span class="setting-hint-block notify-hint">{{ $t('@42BB9:任务或对话结束时提醒我：页面在后台发系统通知，在前台弹应用内提示') }}</span>
                  <span v-if="notifyPermissionState === 'denied'" class="setting-hint-block notify-hint notify-hint--warn">
                    {{ $t('@42BB9:浏览器已拒绝通知权限，只能在页面内提示（可在浏览器地址栏的站点设置里恢复）') }}
                  </span>
                  <span v-else-if="notifyPermissionState === 'unsupported'" class="setting-hint-block notify-hint notify-hint--warn">
                    {{ $t('@42BB9:当前环境不支持系统通知，只能在页面内提示') }}
                  </span>

                  <!-- 提示音：总开关的子选项。缩进 + 左侧竖线表达从属关系，总开关关掉时置灰 -->
                  <div class="notify-sub">
                    <div class="notify-sub__head">
                      <el-switch v-model="tempNotifySoundOnTaskDone" size="small" :disabled="!tempNotifyOnTaskDone" />
                      <span class="notify-sub__label">{{ $t('@42BB9:提示音') }}</span>
                    </div>
                    <span class="setting-hint-block notify-hint notify-sub__hint">
                      {{ $t('@42BB9:任务或对话跑完、出错各响一声（主动停止不响）；上面的总开关关着时也不会有声音') }}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 界面（视图模式 / 分割比例 / 控制台 / 布局比例） -->
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:界面') }}</span>
            </div>
            <div class="settings-grid">
              <!-- 文件列表视图模式 -->
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:文件列表视图') }}</label>
                <el-radio-group v-model="configStore.ui.fileListViewMode" size="default">
                  <el-radio-button value="list">{{ $t('@42BB9:列表') }}</el-radio-button>
                  <el-radio-button value="tree">{{ $t('@42BB9:树状') }}</el-radio-button>
                </el-radio-group>
              </div>

              <!-- 文件差异分割比例 -->
              <div class="setting-row">
                <label class="setting-label">
                  {{ $t('@42BB9:文件差异分割') }}
                  <span class="setting-hint-inline">{{ configStore.ui.fileDiffSplitPercent }}%</span>
                </label>
                <el-slider
                  v-model="configStore.ui.fileDiffSplitPercent"
                  :min="15"
                  :max="85"
                  :step="1"
                  class="setting-slider"
                />
              </div>

              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:AI 差异说明') }}</label>
                <div class="project-toggle">
                  <el-switch
                    :model-value="configStore.aiDiffSummaryEnabled"
                    :disabled="!configStore.currentDirectory"
                    @change="handleAiDiffSummaryEnabledChange"
                  />
                  <span class="setting-hint-block" :title="configStore.currentDirectory">
                    {{ $t('@42BB9:在当前项目的文件差异和提交详情中显示 AI 生成的说明') }}
                    <template v-if="currentProjectName"> · {{ currentProjectName }}</template>
                  </span>
                </div>
              </div>

              <!-- Markdown 预览主题（全局唯一）：文件预览 / 差异预览 / AI 说明共用同一套配色。
                   光看下拉里的名字看不出主题长什么样，所以右侧常驻一块实时预览：
                   默认渲染当前生效的那套，鼠标悬停下拉项时临时切到那一套（只预览，不改配置）。 -->
              <div class="setting-row setting-row--full setting-row--span">
                <label class="setting-label">{{ $t('@42BB9:Markdown 预览主题') }}</label>
                <div class="md-theme-panel">
                  <div class="md-theme-col">
                    <el-select
                      :model-value="configStore.markdownTheme"
                      class="modern-input md-theme-select"
                      size="default"
                      filterable
                      @update:model-value="onMarkdownThemeChange"
                      @visible-change="onMarkdownThemeDropdownVisible"
                    >
                      <el-option
                        v-for="opt in markdownThemeOptions"
                        :key="opt.value"
                        :label="opt.value"
                        :value="opt.value"
                        @mouseenter="onMarkdownThemeHover(opt.value)"
                      >
                        <span class="md-theme-option">
                          <span
                            class="md-theme-swatch"
                            :style="{ background: opt.bg || 'transparent', color: opt.fg || 'inherit' }"
                          >Aa</span>
                          <span>{{ opt.value }}</span>
                        </span>
                      </el-option>
                    </el-select>
                    <span class="setting-hint-block">
                      {{ $t('@42BB9:整个应用只用一个主题，同时作用于文件预览、差异预览与 AI 说明') }}
                    </span>
                    <span class="setting-hint-block">
                      {{ $t('@42BB9:鼠标移到下拉项上可即时预览，点击即应用') }}
                    </span>
                  </div>

                  <div class="md-theme-preview">
                    <div class="md-theme-preview__head">
                      <span>{{ $t('@42BB9:效果预览') }}</span>
                      <span class="md-theme-preview__name">{{ mdThemePreviewName }}</span>
                      <span
                        class="md-theme-preview__tag"
                        :class="{ 'is-hover': !!mdThemeHovered }"
                      >
                        {{ mdThemeHovered ? $t('@42BB9:悬停预览，未应用') : $t('@42BB9:当前生效') }}
                      </span>
                    </div>
                    <div ref="mdThemePreviewRef" class="md-theme-preview__body"></div>
                  </div>
                </div>
              </div>

              <!-- 命令控制台（跨整行的复合控件）：4 个开关 + 比例滑条，
                   只在半格里会把 el-switch 的 active-text 压成竖排单字（实测），
                   所以整行跨两列 + 内部两列网格。 -->
              <div class="setting-row setting-row--full setting-row--span">
                <label class="setting-label">{{ $t('@42BB9:命令控制台') }}</label>
                <div class="console-sub-options">
                  <el-switch
                    v-model="configStore.ui.commandConsole.expanded"
                    :active-text="$t('@42BB9:默认展开')"
                  />
                  <el-switch
                    v-model="configStore.ui.commandConsole.useTerminal"
                    :active-text="$t('@42BB9:使用终端执行')"
                  />
                  <el-switch
                    v-model="configStore.ui.commandConsole.showTerminalSessions"
                    :active-text="$t('@42BB9:显示终端会话')"
                  />
                  <div class="console-split-row">
                    <span class="setting-hint-block">
                      {{ $t('@42BB9:控制台高度比例') }}: {{ configStore.ui.commandConsole.splitPercent }}%
                    </span>
                    <el-slider
                      v-model="configStore.ui.commandConsole.splitPercent"
                      :min="15"
                      :max="85"
                      :step="1"
                      class="setting-slider"
                    />
                  </div>
                </div>
              </div>

              <!-- 布局比例重置 -->
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:布局比例') }}</label>
                <div class="layout-actions">
                  <el-button @click="onResetUiLayout" size="default">
                    {{ $t('@42BB9:重置为默认布局') }}
                  </el-button>
                  <span class="setting-hint-block">{{ $t('@42BB9:恢复默认的左/中/右/上面板比例') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 顶栏工具图标：勾选的固定在顶栏，取消勾选的收进右侧「更多」菜单 -->
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:顶部工具栏') }}</span>
            </div>
            <!-- 不套 setting-row：这里是一整格工具开关网格(两列)，塞进 160px 标签列会被挤成竖排 -->
            <div class="header-tools-row">
              <div class="header-tools">
                <div
                  v-for="tool in headerToolOptions"
                  :key="tool.id"
                  class="header-tool"
                  :class="{ 'is-off': !isHeaderToolVisible(tool.id) }"
                >
                  <span class="header-tool__icon">
                    <svg-icon :icon-class="tool.icon" />
                  </span>
                  <span class="header-tool__name">{{ tool.name }}</span>
                  <el-switch
                    class="header-tool__switch"
                    :model-value="isHeaderToolVisible(tool.id)"
                    @change="(v: string | number | boolean) => toggleHeaderTool(tool.id, !!v)"
                  />
                </div>
              </div>
              <span class="setting-hint-block">
                {{ $t('@42BB9:勾选后固定在顶栏显示，取消勾选的工具会收进右侧「更多」菜单') }}
              </span>
            </div>
          </div>

          <!-- 系统集成：把 g ui 注册进 Windows 资源管理器右键菜单（写 HKCU，不需要管理员权限） -->
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:系统集成') }}</span>
            </div>
            <div class="settings-grid">
              <!-- 说明文案较长，整行铺开：半宽单元格里会被挤成好几行 -->
              <div class="setting-row setting-row--span">
                <label class="setting-label">{{ $t('@42BB9:资源管理器右键菜单') }}</label>
                <div class="layout-actions">
                  <el-button
                    size="default"
                    :loading="explorerMenuBusy"
                    :disabled="!explorerMenuSupported"
                    @click="onToggleExplorerMenu"
                  >
                    {{ explorerMenuInstalled ? $t('@42BB9:从右键菜单移除') : $t('@42BB9:添加到右键菜单') }}
                  </el-button>
                  <span class="setting-hint-block">{{ explorerMenuHint }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- AI 模型配置面板 -->
        <div v-show="activeTab === 'ai-models'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:AI 模型配置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:管理 AI 模型的 API 端点、凭据与默认模型') }}</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title model-section-title">
              <span>{{ $t('@42BB9:已配置模型') }}</span>
              <button class="add-model-btn" @click="startAddModel">+ {{ $t('@42BB9:添加模型') }}</button>
            </div>

            <div class="model-list">
              <div v-if="aiModels.length === 0" class="model-empty">{{ $t('@42BB9:暂未配置模型') }}</div>
              <div v-for="m in aiModels" :key="m.id" class="model-card">
                <div class="model-info">
                  <div class="model-name-row">
                    <span class="model-name">{{ m.name }}</span>
                    <span v-if="m.isDefault" class="model-default-badge">{{ $t('@42BB9:默认') }}</span>
                  </div>
                  <div class="model-meta">{{ m.model }} · {{ m.baseURL }}</div>
                </div>
                <div class="model-actions">
                  <button v-if="!m.isDefault" class="model-btn" @click="handleSetDefaultModel(m.id)">{{ $t('@42BB9:设为默认') }}</button>
                  <button class="model-btn" @click="startEditModel(m)">{{ $t('@42BB9:编辑') }}</button>
                  <button class="model-btn model-btn--danger" @click="handleDeleteModel(m.id)">{{ $t('@42BB9:删除') }}</button>
                </div>
              </div>
            </div>

            <!-- 新增 / 编辑表单：使用 ai-model-form 组件 -->
            <div v-if="editingModelId !== undefined" class="ai-model-form-wrapper">
              <AddModelForm
                :key="editingModelId ?? '__new__'"
                api-base="/api/ai-model"
                :initial="editingModelInitial"
                :theme="currentThemeForForm"
                :locale="localeStore.currentLocale"
                @save="handleAddModelSave"
                @cancel="cancelEditModel"
              />
            </div>
          </div>

          <!-- 智能体运行时（全局设置，CLI `g ai` 与 Web 智能体共用） -->
          <div class="settings-section">
            <div class="section-title model-section-title">
              <span>{{ $t('@42BB9:智能体运行时') }}</span>
            </div>
            <div class="setting-row">
              <label class="setting-label">{{ $t('@42BB9:单轮最大工具调用次数') }}</label>
              <div class="project-toggle">
                <el-input-number
                  v-model="aiMaxToolIterationsInput"
                  :min="1"
                  :max="10000"
                  :step="10"
                  :disabled="savingAiSettings"
                  class="ai-iterations-input"
                  @change="handleAiMaxToolIterationsChange"
                />
                <span class="setting-hint-block ai-iterations-hint">
                  {{ $t('@42BB9:一条消息内智能体最多连续调用多少次工具。达到上限本轮会被强制结束，需要再发一条消息才能继续') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- Git 全局设置面板 -->
        <div v-show="activeTab === 'git'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:全局配置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:这些设置将影响全局 Git 配置，对所有 Git 仓库生效') }}</p>
              </div>
            </div>
          </div>
          <el-form class="user-form" label-width="auto" :model="{ tempUserName, tempUserEmail }">
            <div class="basic-info-section">
              <div class="basic-info-grid">
                <el-form-item class="form-item" :label="$t('@42BB9:用户名')">
                  <el-input 
                    v-model="tempUserName" 
                    :placeholder="$t('@42BB9:请输入 Git 用户名')" 
                    class="modern-input"
                  />
                </el-form-item>

                <el-form-item class="form-item" :label="$t('@42BB9:邮箱地址')">
                  <el-input 
                    v-model="tempUserEmail" 
                    :placeholder="$t('@42BB9:请输入 Git 邮箱地址')" 
                    class="modern-input"
                  />
                </el-form-item>
              </div>
            </div>
            
            <!-- 高级设置：常用全局 Git 配置 -->
            <div class="settings-section">
              <div class="section-title">
                <span>{{ $t('@42BB9:高级配置') }}</span>
              </div>
              <div class="settings-grid">
                <div class="setting-row">
                  <label class="setting-label">{{ $t('@42BB9:自动设置上游') }}
                    <el-tooltip :content="$t('@42BB9:首次 git push 时，自动为当前分支创建远程同名分支并建立跟踪关系（等同于 push -u）。')" placement="top" :show-after="200">
                      <el-icon class="qmark"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </label>
                  <el-switch v-model="cfgAutoSetupRemote" />
                </div>

                <div class="setting-row">
                  <label class="setting-label">{{ $t('@42BB9:拉取策略') }}</label>
                  <el-select v-model="cfgPullRebase" class="modern-input" size="default">
                    <el-option :label="$t('@42BB9:merge (默认)')" value="false" />
                    <el-option label="rebase" value="true" />
                    <el-option :label="$t('@42BB9:rebase(保留合并)')" value="merges" />
                  </el-select>
                </div>

                <div class="setting-row">
                  <label class="setting-label">{{ $t('@42BB9:自动清理远程分支') }}
                    <el-tooltip :content="$t('@42BB9:在 git fetch 时自动 prune，移除已在远程删除但本地仍保留的远程分支引用。')" placement="top" :show-after="200">
                      <el-icon class="qmark"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </label>
                  <el-switch v-model="cfgFetchPrune" />
                </div>

                <div class="setting-row">
                  <label class="setting-label">{{ $t('@42BB9:换行符处理') }}</label>
                  <el-select v-model="cfgCoreAutoCrlf" class="modern-input" size="default">
                    <el-option label="true (Windows)" value="true" />
                    <el-option label="input" value="input" />
                    <el-option label="false" value="false" />
                  </el-select>
                </div>

                <div class="setting-row">
                  <label class="setting-label">{{ $t('@42BB9:默认初始化分支') }}
                    <el-tooltip :content="$t('@42BB9:新建仓库时（git init）默认创建的分支名，常见为 main 或 master。')" placement="top" :show-after="200">
                      <el-icon class="qmark"><InfoFilled /></el-icon>
                    </el-tooltip>
                  </label>
                  <el-input v-model="cfgInitDefaultBranch" :placeholder="$t('@42BB9:例如: main')" class="modern-input" size="default" />
                </div>
              </div>
            </div>

          </el-form>
        </div>

        <!-- 提交设置面板 -->
        <div v-show="activeTab === 'commit'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@76872:提交设置') }}</p>
                <p class="info-desc">{{ $t('@76872:这些设置实时生效') }}</p>
              </div>
            </div>
          </div>

          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@76872:提交格式与行为') }}</span>
            </div>
            <div class="settings-grid commit-settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:标准化提交') }}</label>
                <el-switch v-model="configStore.isStandardCommit" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:跳过钩子检查') }}
                  <el-tooltip :content="$t('@76872:添加 --no-verify 参数')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.skipHooks" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:回车自动提交') }}
                  <el-tooltip :content="$t('@76872:输入提交信息后按回车直接执行一键推送')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoQuickPushOnEnter" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:Push完成自动关闭') }}
                  <el-tooltip :content="$t('@76872:推送成功后自动关闭进度弹窗')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoClosePushModal" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:推送前拉取更新') }}
                  <el-tooltip :content="$t('@76872:推送前自动拉取远程更新，有冲突则停止推送')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.pullBeforePush" />
              </div>
              <div class="setting-row">
                <label class="setting-label">{{ $t('@76872:自动填充默认提交信息') }}
                  <el-tooltip :content="$t('@76872:打开页面或提交完成后自动填充默认提交信息')" placement="top" :show-after="200">
                    <el-icon class="qmark"><InfoFilled /></el-icon>
                  </el-tooltip>
                </label>
                <el-switch v-model="configStore.autoSetDefaultMessage" />
              </div>
            </div>
          </div>
        </div>

        <!-- 编辑配置 JSON 面板 -->
        <div v-show="activeTab === 'config'" class="settings-panel config-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:编辑当前项目的配置文件') }}</p>
                <p class="info-desc">{{ $t('@42BB9:直接编辑 JSON，支持所有配置项') }}</p>
              </div>
            </div>
          </div>
          <div class="config-json-editor-wrap">
            <el-input
              v-model="configEditorText"
              type="textarea"
              spellcheck="false"
              autocomplete="off"
              :placeholder="$t('@42BB9:加载中...')"
              class="config-json-editor"
            />
          </div>
          <div class="config-panel-actions">
            <button type="button" class="dialog-cancel-btn system-config-btn" @click="openSystemConfigFile">
              {{ $t('@42BB9:打开系统配置文件') }}
            </button>
          </div>
        </div>

        <!-- 编辑器设置面板 -->
        <div v-show="activeTab === 'editor'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:编辑器设置') }}</p>
                <p class="info-desc">{{ $t('@42BB9:自定义编辑器行为') }}</p>
              </div>
            </div>
          </div>
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:文件编辑') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:自动保存') }}</label>
                <el-switch v-model="tempEditorAutoSave" />
              </div>
              <div class="setting-row setting-row--hint" v-if="tempEditorAutoSave">
                <span class="setting-hint">{{ $t('@42BB9:失去焦点时自动保存当前文件') }}</span>
              </div>
            </div>
          </div>
          <div class="settings-section">
            <div class="section-title">
              <span>{{ $t('@42BB9:文件树') }}</span>
            </div>
            <div class="settings-grid">
              <div class="setting-row">
                <label class="setting-label">{{ $t('@42BB9:自动刷新') }}</label>
                <el-switch v-model="tempFileTreeAutoRefresh" />
              </div>
              <div class="setting-row setting-row--hint" v-if="tempFileTreeAutoRefresh">
                <span class="setting-hint">{{ $t('@42BB9:定时刷新左侧文件树') }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 记忆库面板：浏览 / 展开看正文 / 单条与批量删除。
             没有需要「保存」的设置项（全是即时操作），所以刻意不给 hasChanges 加分支 ——
             那样 footer 的「保存设置」按钮天然不出现（v-if="hasChanges"），行为是对的。
             v-show 是本文件所有 panel 的既有约定；数据靠 onClickMemoryTab 懒加载。 -->
        <div v-show="activeTab === 'memory'" class="settings-panel">
          <div class="info-section">
            <div class="info-card">
              <div class="info-content">
                <p class="info-title">{{ $t('@42BB9:跨轮记忆') }}</p>
                <p class="info-desc">
                  {{ $t('@42BB9:智能体在派发任务时会把这里当成"经验库"：开工前查、收尾时按四问自检记一条。') }}
                </p>
              </div>
            </div>
          </div>
          <MemoryPanel ref="memoryPanelRef" />
        </div>
      </div>
    </div>
    
    <template #footer v-if="activeTab !== 'commit'">
      <div class="user-settings-footer">
        <div></div>
        <div class="footer-actions">
          <button type="button" class="dialog-cancel-btn" @click="visible = false" :disabled="isLoading">
            {{ hasChanges ? $t('@42BB9:取消') : $t('@42BB9:关闭') }}
          </button>
          <button v-if="hasChanges" type="button" class="dialog-confirm-btn" @click="handleSave" :disabled="isLoading">
            <el-icon><Check /></el-icon>
            <span>{{ activeTab === 'config' ? $t('@42BB9:保存配置') : $t('@42BB9:保存设置') }}</span>
          </button>
        </div>
      </div>
    </template>
  </CommonDialog>
</template>

<script setup lang="ts">
import { $t } from '@/lang/static'
import { ref, watch, computed, nextTick, onBeforeUnmount } from 'vue'
import { ElMessage } from 'element-plus'
import { Check, InfoFilled } from '@element-plus/icons-vue'
import { createPreview, type PreviewInstance } from 'flowdash-md-preview'
import CommonDialog from './CommonDialog.vue'
import { useGitStore } from '@/stores/gitStore'
import { useLocaleStore } from '@/stores/localeStore'
import { useConfigStore, type ModelInfo } from '@/stores/configStore'
import { useToolsStore, type ToolId } from '@/stores/toolsStore'
import { TASK_EXECUTOR_OPTIONS, type TaskExecutorId } from '@/utils/taskExecutor'
import { TOOL_DISPLAY_NAMES } from '@/composables/useDirectoryOpenActions'
import {
  notificationPermission,
  requestNotificationPermission,
  type NotifyPermission
} from '@/utils/taskNotify'
import TaskExecutorIcon from './TaskExecutorIcon.vue'
import MemoryPanel from './MemoryPanel.vue'
import SvgIcon from './SvgIcon/index.vue'
import { type SupportLocale } from '@/locales'
import { AddModelForm } from 'ai-model-form/client'
import type { AiModelFormSaveData } from 'ai-model-form/client'
import 'ai-model-form/dist/ai-model-form.css'
import { MARKDOWN_THEME_OPTIONS } from '@/utils/markdownTheme'

const gitStore = useGitStore()
const localeStore = useLocaleStore()
const configStore = useConfigStore()
const toolsStore = useToolsStore()

/** 顶栏工具图标的勾选项（顺序 = 顶栏渲染顺序；claude 在顶栏是单独带右键菜单渲染的） */
const HEADER_TOOL_IDS: ToolId[] = ['vscode', 'claude', 'codex', 'opencode', 'kimi', 'zcode', 'dsh']
/** 各工具在 sprite 里的图标名：除 claude 外都与 tool id 同名，claude 用 -color 后缀的彩色版 */
const HEADER_TOOL_ICONS: Record<ToolId, string> = {
  vscode: 'vscode',
  claude: 'claudecode-color',
  codex: 'codex',
  opencode: 'opencode',
  kimi: 'kimi',
  zcode: 'zcode',
  dsh: 'dsh',
}
const headerToolOptions = HEADER_TOOL_IDS.map((id) => ({
  id,
  name: TOOL_DISPLAY_NAMES[id],
  icon: HEADER_TOOL_ICONS[id],
}))

function isHeaderToolVisible(id: ToolId): boolean {
  return !configStore.ui.headerToolsHidden.includes(id)
}

/** 取消勾选 = 该工具收进顶栏右侧「更多」菜单；写新数组以触发 configStore 的落盘 watch */
function toggleHeaderTool(id: ToolId, show: boolean) {
  const next = new Set(configStore.ui.headerToolsHidden)
  if (show) next.delete(id)
  else next.add(id)
  configStore.ui.headerToolsHidden = [...next]
}

// ---------------- Markdown 预览主题（全应用唯一） ----------------
/** 可选主题（含小色块），直接来自 flowdash-md-preview 的预设表 */
const markdownThemeOptions = MARKDOWN_THEME_OPTIONS

/** 切换主题：写进 configStore（内部负责注入 CSS + 落盘）。
 *  右侧预览卡片跟着会切过去（下拉收起 → 悬停态清掉 → 卡片显示新的生效主题）。 */
async function onMarkdownThemeChange(value: string) {
  await configStore.setMarkdownTheme(value)
}

export type SettingsTab = 'general' | 'ai-models' | 'git' | 'commit' | 'config' | 'editor' | 'memory'

const props = defineProps<{
  modelValue: boolean
  /** 打开 dialog 时自动跳转到指定 tab（用于 footer / 头部的快捷入口） */
  initialTab?: SettingsTab
}>()

const emit = defineEmits<{
  'update:modelValue': [value: boolean]
}>()

const visible = ref(false)
const isLoading = ref(false)
const activeTab = ref<SettingsTab>('general')

// 通用设置
const tempTheme = ref<'light' | 'dark' | 'auto'>('light')
const tempLocale = ref<SupportLocale>('zh-CN')
// 任务执行器（全局默认值；工作台执行按钮旁的临时切换不归这里管）
const tempTaskExecutor = ref<TaskExecutorId>('claude')

// 选中执行器**当前配置的模型**（跟随 tempTaskExecutor：切换下拉立即看到对应的模型）。
// 空串 = 还没探测到 —— 那种情况整块不渲染，不能先说"未在配置中指定"（理由见 toolsStore）。
// 这份数据是这页最要紧的一处展示：模型跟随各 CLI 的配置文件、
// 不传 --model，在这个弹窗外别处都看不到。
const selectedExecutorModelText = computed(() => toolsStore.executorModelText(tempTaskExecutor.value))
const selectedExecutorModelDetail = computed(() => toolsStore.executorModelDetail(tempTaskExecutor.value))
/**
 * 那行 hint 的完整文案（模型 + 括号里的别名/服务商）。
 * 给 `:title` 用：正文允许换行、通常能全显，但窗口极窄时仍会被挤到超出容器，
 * 悬停能看到完整值 —— 这是兜底，不是主要手段。
 */
const selectedExecutorModelLineTitle = computed(() =>
  [
    selectedExecutorModelText.value,
    selectedExecutorModelDetail.value ? `（${selectedExecutorModelDetail.value}）` : '',
  ].filter(Boolean).join(' ')
)

/** 下拉选项右侧的模型名 + 次要信息，拼成该选项的 title */
function optionExecutorModelTitle(id: TaskExecutorId): string {
  return [toolsStore.executorModelText(id), toolsStore.executorModelDetail(id)].filter(Boolean).join(' · ')
}

// 任务执行结束提示开关（全局，默认开）
const tempNotifyOnTaskDone = ref(false)
// 任务完成提示音开关（全局，默认开）。从属于上面的总开关：总开关关着时置灰不可点，
// 但值本身留着（后端也各自存一个键）—— 用户临时关掉总开关再打开，提示音设置还在。
const tempNotifySoundOnTaskDone = ref(true)
// 只读镜像，用来在开关下方如实展示"系统通知到底能不能发出去"：
// 权限已拒 / 环境不支持时，光看开关是不知道的，用户会以为开了却没动静。
const notifyPermissionState = ref<NotifyPermission>('default')

// 编辑器设置
const tempEditorAutoSave = ref(false)
// 文件树自动刷新:文件空间左侧资源管理器是否定时静默刷新(捕获编辑器/外部工具改动)
const tempFileTreeAutoRefresh = ref(true)

// AI 模型配置
const aiModels = ref<ModelInfo[]>([])
const editingModelId = ref<string | null | undefined>(undefined) // undefined=隐藏, null=新增, string=编辑

// AI 智能体运行时（全局设置，立即持久化，与模型列表一样不走"保存"按钮）
const aiMaxToolIterationsInput = ref(1000)
const savingAiSettings = ref(false)

async function handleAiMaxToolIterationsChange(value: number | undefined) {
  const next = Number(value)
  // 输入框被清空/输入非法时不发请求，直接回滚成当前生效值
  if (!Number.isFinite(next) || next <= 0) {
    aiMaxToolIterationsInput.value = configStore.aiMaxToolIterations
    return
  }
  if (next === configStore.aiMaxToolIterations) return

  savingAiSettings.value = true
  try {
    const ok = await configStore.saveAiSettings({ aiMaxToolIterations: next })
    // 后端会把越界值夹取到合法区间，成功后以 store 回写后的值为准，避免输入框与磁盘不一致
    aiMaxToolIterationsInput.value = configStore.aiMaxToolIterations
    if (ok) ElMessage.success($t('@42BB9:已保存'))
  } finally {
    savingAiSettings.value = false
  }
}

const currentThemeForForm = computed(() =>
  configStore.theme === 'light' ? 'light' : 'dark'
)
const currentProjectName = computed(() => {
  const path = configStore.currentDirectory.replace(/[\\/]+$/, '')
  return path.split(/[\\/]/).pop() || path
})

function handleAiDiffSummaryEnabledChange(value: string | number | boolean) {
  void configStore.setAiDiffSummaryEnabled(value === true)
}

const editingModelInitial = computed(() => {
  if (editingModelId.value === null) return null
  const m = aiModels.value.find(x => x.id === editingModelId.value)
  if (!m) return null
  return { endpoint: m.baseURL, modelName: m.model, displayName: m.name, apiKey: m.apiKey }
})

const hasChanges = computed(() => {
  if (activeTab.value === 'config') return true
  if (activeTab.value === 'general') {
    return tempTheme.value !== initTheme || tempLocale.value !== initLocale || tempTaskExecutor.value !== initTaskExecutor || tempNotifyOnTaskDone.value !== initNotifyOnTaskDone || tempNotifySoundOnTaskDone.value !== initNotifySoundOnTaskDone || editingModelId.value !== undefined
  }
  if (activeTab.value === 'git') {
    return (
      tempUserName.value !== initUserName ||
      tempUserEmail.value !== initUserEmail ||
      cfgAutoSetupRemote.value !== initAutoSetupRemote ||
      cfgPullRebase.value !== initPullRebase ||
      cfgFetchPrune.value !== initFetchPrune ||
      cfgCoreAutoCrlf.value !== initCoreAutoCrlf ||
      (cfgInitDefaultBranch.value || '').trim() !== initInitDefaultBranch
    )
  }
  if (activeTab.value === 'editor') {
    return tempEditorAutoSave.value !== configStore.ui.editorAutoSave ||
      tempFileTreeAutoRefresh.value !== configStore.ui.fileTreeAutoRefresh
  }
  return false
})

function startAddModel() {
  editingModelId.value = null
}

function startEditModel(m: ModelInfo) {
  editingModelId.value = m.id
}

function cancelEditModel() {
  editingModelId.value = undefined
}

async function handleAddModelSave(data: AiModelFormSaveData) {
  const wasAdding = editingModelId.value === null
  const finalName = data.displayName || data.modelName
  const autoId = wasAdding
    ? `model-${finalName.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 24)}-${Date.now().toString(36)}`
    : editingModelId.value!
  let updated: ModelInfo[]
  if (wasAdding) {
    const isFirst = aiModels.value.length === 0
    updated = [...aiModels.value, {
      id: autoId, name: finalName, apiKey: data.apiKey,
      baseURL: data.endpoint, model: data.modelName, isDefault: isFirst
    }]
  } else {
    updated = aiModels.value.map(m =>
      m.id === editingModelId.value
        ? { ...m, name: finalName, apiKey: data.apiKey || m.apiKey, baseURL: data.endpoint, model: data.modelName }
        : m
    )
  }
  const ok = await configStore.saveModels(updated)
  if (ok) {
    aiModels.value = updated
    editingModelId.value = undefined
    ElMessage.success(wasAdding ? $t('@42BB9:已添加模型') : $t('@42BB9:已更新模型'))
  }
}

async function handleDeleteModel(modelId: string) {
  const updated = aiModels.value.filter(m => m.id !== modelId)
  const ok = await configStore.saveModels(updated)
  if (ok) {
    aiModels.value = updated
    ElMessage.success($t('@42BB9:已删除模型'))
  }
}

async function handleSetDefaultModel(modelId: string) {
  const updated = aiModels.value.map(m => ({ ...m, isDefault: m.id === modelId }))
  const ok = await configStore.saveModels(updated)
  if (ok) {
    aiModels.value = updated
    ElMessage.success($t('@42BB9:已设置默认模型'))
  }
}

// Git 设置
const tempUserName = ref('')
const tempUserEmail = ref('')

// 配置编辑器
const configEditorText = ref('')
const configEditorSaving = ref(false)

// 常用全局 Git 配置
const cfgAutoSetupRemote = ref(false)
const cfgPullRebase = ref<'false' | 'true' | 'merges'>('false')
const cfgFetchPrune = ref(false)
const cfgCoreAutoCrlf = ref<'true' | 'input' | 'false'>('true')
const cfgInitDefaultBranch = ref('main')

// ===== 提交设置（由 configStore 统一管理，实时持久化） =====
// commitIsStandard → configStore.isStandardCommit
// commitSkipHooks → configStore.skipHooks
// commitAutoQuickPush → configStore.autoQuickPushOnEnter

// 初始值（用于仅保存变更项）
let initUserName = ''
let initUserEmail = ''
let initAutoSetupRemote = false
let initPullRebase: 'false' | 'true' | 'merges' = 'false'
let initFetchPrune = false
let initCoreAutoCrlf: 'true' | 'input' | 'false' = 'true'
let initInitDefaultBranch = 'main'
let initTheme: 'light' | 'dark' | 'auto' = 'light'
let initLocale: SupportLocale = 'zh-CN'
let initTaskExecutor: TaskExecutorId = 'claude'
let initNotifyOnTaskDone = false
let initNotifySoundOnTaskDone = true

// 同步 v-model
watch(() => props.modelValue, async (val) => {
  visible.value = val
  if (val) {
    // 打开时先强制刷新一次配置:
    // 另一个 g ui 实例(独立进程)改过的全局配置(AI 模型/主题等),
    // 本页面 configStore 里还是启动时的旧快照,不刷新就看不到对方的修改。
    await configStore.loadConfig(true)

    // 执行器模型同理强制重探：用户很可能刚改过 CLI 配置文件就想回来确认生效，
    // 走 TTL 缓存会显示改之前的模型名（那正是"看不到"的老问题）
    void toolsStore.fetchExecutorModels(true)

    // 打开时加载数据
    tempUserName.value = gitStore.userName
    tempUserEmail.value = gitStore.userEmail
    configEditorText.value = '' // 延迟加载，点击 tab 时才加载

    // 加载通用设置
    tempTheme.value = configStore.theme
    tempLocale.value = configStore.locale
    tempTaskExecutor.value = configStore.taskExecutor
    tempNotifyOnTaskDone.value = configStore.notifyOnTaskDone
    tempNotifySoundOnTaskDone.value = configStore.notifySoundOnTaskDone
    // 每次打开都重读权限：用户可能在浏览器地址栏里改过，或上一次授权弹窗刚被关掉
    notifyPermissionState.value = notificationPermission()
    // 资源管理器右键菜单状态：可能在别的实例里加过/删过，同样每次打开重读
    void loadExplorerMenuStatus()
    aiModels.value = [...configStore.models]
    aiMaxToolIterationsInput.value = configStore.aiMaxToolIterations
    editingModelId.value = undefined
    // 加载编辑器设置
    tempEditorAutoSave.value = configStore.ui.editorAutoSave
    tempFileTreeAutoRefresh.value = configStore.ui.fileTreeAutoRefresh

    // 外部指定了跳转 tab（footer / 头部按钮）→ 切过去
    if (props.initialTab) {
      activeTab.value = props.initialTab
    } else {
      activeTab.value = 'general'
    }

    try {
      isLoading.value = true
      await loadGlobalGitConfigs()
    } finally {
      isLoading.value = false
    }

    // 记录初始值
    initUserName = tempUserName.value
    initUserEmail = tempUserEmail.value
    initAutoSetupRemote = cfgAutoSetupRemote.value
    initPullRebase = cfgPullRebase.value
    initFetchPrune = cfgFetchPrune.value
    initCoreAutoCrlf = cfgCoreAutoCrlf.value
    initInitDefaultBranch = cfgInitDefaultBranch.value
    initTheme = tempTheme.value
    initLocale = tempLocale.value
    initTaskExecutor = tempTaskExecutor.value
    initNotifyOnTaskDone = tempNotifyOnTaskDone.value
    initNotifySoundOnTaskDone = tempNotifySoundOnTaskDone.value
  }
}, { immediate: true })

// 监听 initialTab 变化:支持 dialog 已打开期间外部再触发跳转
// (例:连续点击 footer 不同入口、或者外部编程式调度)
watch(() => props.initialTab, (newTab) => {
  if (newTab && visible.value) {
    activeTab.value = newTab
  }
})

// ---------------- Markdown 预览主题：实时预览卡片 ----------------
// 说明：这一整块必须放在 `visible` 声明之后 —— watch 的取值函数在注册时就会执行一次，
// 放到前面会踩 const 的暂时性死区。

/** 预览卡片里的示例文档：标题 / 正文 / 引用 / 列表 / 代码 / 表格各来一段，
 *  够看清一套主题的配色与排版。文案跟着语言走（中英文字形也是观感的一部分），
 *  markdown 结构留在代码里 —— 整段丢进语言文件会被 vue-i18n 把表格里的 `|`
 *  当成复数分隔符，消息编译失败后 $t 只会吐回原始 key。 */
const mdThemeSample = computed(() => [
  `# ${$t('@42BB9:Markdown 主题预览')}`,
  '',
  $t('@42BB9:这段话用来看主题的正文配色：**加粗**、*斜体*、`行内代码` 与 [链接](https://example.com)。'),
  '',
  `> ${$t('@42BB9:引用块：左侧竖条用的是主题强调色。')}`,
  '',
  `- ${$t('@42BB9:列表项一')}`,
  `- [x] ${$t('@42BB9:已完成的任务')}`,
  `- [ ] ${$t('@42BB9:待办的任务')}`,
  '',
  '```js',
  'const total = items.length * 2',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
].join('\n'))

/** 悬停中的主题名（仅预览，不写配置）；空串 = 卡片展示当前生效的那套 */
const mdThemeHovered = ref('')

/** 下拉是否展开。收起后仍会飘来 mouseenter（列表重排/隐藏时浏览器把事件落在光标下的那一项上），
 *  不挡住的话卡片会停在一个用户根本没在看的主题上 */
const mdThemeDropdownOpen = ref(false)

/** 卡片当前展示的主题名：悬停优先，否则用生效值 */
const mdThemePreviewName = computed(() => mdThemeHovered.value || configStore.markdownTheme)

/** 卡片容器（内容由 flowdash-md-preview 的 createPreview 注入） */
const mdThemePreviewRef = ref<HTMLElement | null>(null)

/** createPreview 实例。它的主题 CSS 是按实例作用域注入的
 *  （选择器前缀是一个随机 data 属性，优先级高于全局那套 .md-preview），
 *  所以卡片能显示"非当前"主题，而不会反过来把全应用的预览配色改掉。 */
let mdThemePreview: PreviewInstance | null = null
/** 实例上当前生效的主题名，避免每次同步都重建 <style> */
let mdThemePreviewApplied = ''

/** 懒创建。容器不存在（弹窗没开 / 已被 destroy-on-close 干掉）时返回 null 而不是抛错 */
function ensureMdThemePreview(): PreviewInstance | null {
  const host = mdThemePreviewRef.value
  if (!host) return null
  // 弹窗关闭会连容器一起销毁，重新打开是新节点：实例还在就换掉它，避免往旧节点里塞内容
  if (mdThemePreview && mdThemePreview.element !== host) {
    destroyMdThemePreview()
  }
  if (!mdThemePreview) {
    mdThemePreview = createPreview(host, {
      theme: configStore.markdownTheme,
      initialValue: mdThemeSample.value,
    })
    mdThemePreviewApplied = configStore.markdownTheme
  }
  return mdThemePreview
}

/** 把示例文档与目标主题刷到卡片上（内容没变时 update 是空操作） */
function syncMdThemePreview() {
  const preview = ensureMdThemePreview()
  if (!preview) return
  preview.update(mdThemeSample.value)
  if (mdThemePreviewApplied !== mdThemePreviewName.value) {
    preview.setTheme(mdThemePreviewName.value)
    mdThemePreviewApplied = mdThemePreviewName.value
  }
}

function destroyMdThemePreview() {
  mdThemePreview?.destroy()
  mdThemePreview = null
  mdThemePreviewApplied = ''
}

/** 悬停下拉项 → 卡片临时切到该主题（下拉已收起时的事件一律忽略） */
function onMarkdownThemeHover(theme: string) {
  if (!mdThemeDropdownOpen.value) return
  mdThemeHovered.value = theme
  syncMdThemePreview()
}

/** 下拉展开（可能是刚打开，容器这时才真正可用）时同步一次；
 *  收起（含点选后自动收起）→ 回到生效的主题，卡片不会停在"未应用"的那套上 */
function onMarkdownThemeDropdownVisible(opened: boolean) {
  mdThemeDropdownOpen.value = opened
  if (!opened) mdThemeHovered.value = ''
  syncMdThemePreview()
}

// destroy-on-close 下弹窗一关内容就没了，实例必须跟着销毁：
// 否则它注入到 head 的主题 <style> 会一直留着（虽然作用域是随机的，但没必要留）。
watch(visible, async (val) => {
  if (!val) {
    destroyMdThemePreview()
    return
  }
  // el-dialog 的内容要等一帧才挂上；最多等几帧，拿不到容器就先跳过（下次悬停还会重试）
  for (let i = 0; i < 5 && !mdThemePreviewRef.value; i += 1) await nextTick()
  syncMdThemePreview()
})

onBeforeUnmount(destroyMdThemePreview)

function handleVisibleChange(val: boolean) {
  emit('update:modelValue', val)
}

// 读取单个全局配置
async function getGlobalConfig(key: string): Promise<string> {
  try {
    const res = await fetch(`/api/git/global-config?key=${encodeURIComponent(key)}`)
    const data = await res.json()
    if (data.success) {
      return String(data.value || '')
    }
  } catch (e) {
    // ignore
  }
  return ''
}

// 设置单个全局配置
async function setGlobalConfig(key: string, value: string) {
  const res = await fetch('/api/git/global-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, value })
  })
  const data = await res.json()
  if (!data.success) throw new Error(data.error || `${$t('@42BB9:设置 ')}${key}${$t('@42BB9: 失败')}`)
}

// 加载常用配置
async function loadGlobalGitConfigs() {
  const [autoSetup, pullRebase, fetchPrune, autocrlf, defBranch] = await Promise.all([
    getGlobalConfig('push.autoSetupRemote'),
    getGlobalConfig('pull.rebase'),
    getGlobalConfig('fetch.prune'),
    getGlobalConfig('core.autocrlf'),
    getGlobalConfig('init.defaultBranch')
  ])

  cfgAutoSetupRemote.value = (autoSetup || 'false').toLowerCase() === 'true'
  const pr = (pullRebase || 'false').toLowerCase()
  cfgPullRebase.value = (pr === 'true' || pr === 'merges') ? pr as any : 'false'
  cfgFetchPrune.value = (fetchPrune || 'false').toLowerCase() === 'true'
  const ac = (autocrlf || 'true').toLowerCase()
  cfgCoreAutoCrlf.value = (ac === 'true' || ac === 'input') ? ac as any : 'false'
  cfgInitDefaultBranch.value = defBranch || 'main'
}

// 保存常用配置（仅保存已变更项）
async function saveGlobalGitConfigs() {
  const tasks: Promise<any>[] = []
  try {
    if (cfgAutoSetupRemote.value !== initAutoSetupRemote) {
      tasks.push(setGlobalConfig('push.autoSetupRemote', cfgAutoSetupRemote.value ? 'true' : 'false'))
    }
    if (cfgPullRebase.value !== initPullRebase) {
      tasks.push(setGlobalConfig('pull.rebase', cfgPullRebase.value))
    }
    if (cfgFetchPrune.value !== initFetchPrune) {
      tasks.push(setGlobalConfig('fetch.prune', cfgFetchPrune.value ? 'true' : 'false'))
    }
    if (cfgCoreAutoCrlf.value !== initCoreAutoCrlf) {
      tasks.push(setGlobalConfig('core.autocrlf', cfgCoreAutoCrlf.value))
    }
    const trimmed = (cfgInitDefaultBranch.value || '').trim()
    if (trimmed && trimmed !== initInitDefaultBranch) {
      tasks.push(setGlobalConfig('init.defaultBranch', trimmed))
    }
    if (tasks.length === 0) {
      // 无需保存
      return true
    }
    await Promise.all(tasks)
    ElMessage.success($t('@42BB9:已保存变更的 Git 配置'))
    // 更新初始值为最新
    initAutoSetupRemote = cfgAutoSetupRemote.value
    initPullRebase = cfgPullRebase.value
    initFetchPrune = cfgFetchPrune.value
    initCoreAutoCrlf = cfgCoreAutoCrlf.value
    initInitDefaultBranch = trimmed || initInitDefaultBranch
    return true
  } catch (e) {
    ElMessage.error((e as Error).message)
    return false
  }
}

// 保存通用设置
async function saveGeneralSettings() {
  const settings: { theme?: 'light' | 'dark' | 'auto', locale?: SupportLocale, taskExecutor?: TaskExecutorId, notifyOnTaskDone?: boolean, notifySoundOnTaskDone?: boolean } = {}

  // 保存主题设置（如果与初始值不同或需要强制保存）
  if (tempTheme.value !== initTheme) {
    settings.theme = tempTheme.value
    initTheme = tempTheme.value
  }

  // 保存语言设置（如果与初始值不同）
  if (tempLocale.value !== initLocale) {
    settings.locale = tempLocale.value
    localeStore.changeLocale(tempLocale.value)
    initLocale = tempLocale.value
  }

  // 保存任务执行器默认值（如果与初始值不同）
  if (tempTaskExecutor.value !== initTaskExecutor) {
    settings.taskExecutor = tempTaskExecutor.value
    initTaskExecutor = tempTaskExecutor.value
  }

  // 保存任务完成提示开关（如果与初始值不同）
  if (tempNotifyOnTaskDone.value !== initNotifyOnTaskDone) {
    settings.notifyOnTaskDone = tempNotifyOnTaskDone.value
    initNotifyOnTaskDone = tempNotifyOnTaskDone.value
  }

  // 保存提示音开关（如果与初始值不同）
  if (tempNotifySoundOnTaskDone.value !== initNotifySoundOnTaskDone) {
    settings.notifySoundOnTaskDone = tempNotifySoundOnTaskDone.value
    initNotifySoundOnTaskDone = tempNotifySoundOnTaskDone.value
  }

  // 只要有设置项就保存（包括主题或语言）
  if (settings.theme !== undefined || settings.locale !== undefined || settings.taskExecutor !== undefined || settings.notifyOnTaskDone !== undefined || settings.notifySoundOnTaskDone !== undefined) {
    const saved = await configStore.saveGeneralSettings(settings)
    if (saved) {
      ElMessage.success($t('@42BB9:通用设置已保存'))
    }
    return saved
  }

  return true
}

// 开关被拨到"开"的那一刻申请通知权限（开关默认开，这条平时主要覆盖"关掉过又打开"；
// 页面内首次点击时的自动申请在 App.vue 的 onUserGestureForNotifyPermission）。
//
// ⚠️ 必须挂在点击事件上，不能等任务跑完再补申请：浏览器只在**用户手势**里响应
// requestPermission（Chrome 之后不再允许非手势调用弹窗），在 SSE 回调里调只会拿回
// 'default'，然后就永久卡住 —— 用户会觉得"开了开关但从来没提示过"。
// 关掉时不申请（没意义），但把状态回读一次，保证下方提示行即时更新。
async function onNotifyToggleChange(value: string | number | boolean) {
  if (value === true) {
    notifyPermissionState.value = await requestNotificationPermission()
    if (notifyPermissionState.value === 'denied') {
      ElMessage.warning($t('@42BB9:浏览器已拒绝通知权限，将只在页面内提示'))
    }
  } else {
    notifyPermissionState.value = notificationPermission()
  }
}

// ===== 系统集成：资源管理器右键菜单（仅 Windows，写 HKCU 注册表）=====
// 状态不在 configStore 里（写的是注册表，不是配置文件），所以打开弹窗时单独问后端一次；
// 点按钮立即生效，不走 footer 的"保存设置" —— 注册表没有"未保存"这个中间态。
const explorerMenuSupported = ref(false)
const explorerMenuInstalled = ref(false)
const explorerMenuBusy = ref(false)

const explorerMenuHint = computed(() => {
  if (!explorerMenuSupported.value) return $t('@42BB9:仅支持 Windows 资源管理器')
  if (explorerMenuInstalled.value) return $t('@42BB9:已添加：右键文件夹（或文件夹空白处）即可用 g UI 打开该目录')
  return $t('@42BB9:右键文件夹（或文件夹空白处）即可用 g UI 打开该目录；Windows 11 需在「显示更多选项」中查找')
})

async function loadExplorerMenuStatus() {
  try {
    const res = await fetch('/api/explorer-context-menu')
    const data = await res.json()
    if (!data?.success) return
    explorerMenuSupported.value = data.supported === true
    explorerMenuInstalled.value = data.installed === true
  } catch {
    // 后端挂了就当"不支持"：按钮置灰，总比显示成"已添加"却点不动强
    explorerMenuSupported.value = false
  }
}

async function onToggleExplorerMenu() {
  const installing = !explorerMenuInstalled.value
  explorerMenuBusy.value = true
  try {
    const res = await fetch(`/api/explorer-context-menu/${installing ? 'install' : 'uninstall'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // 菜单标题跟随当前界面语言：用户此刻看到的是中文，右键菜单就写中文
      body: JSON.stringify({ label: $t('@42BB9:用 g UI 打开') }),
    })
    const data = await res.json().catch(() => null)
    if (!res.ok || !data?.success) {
      ElMessage.error(data?.error || $t('@42BB9:操作失败，请重试'))
      return
    }
    explorerMenuInstalled.value = installing
    ElMessage.success(installing ? $t('@42BB9:已添加到资源管理器右键菜单') : $t('@42BB9:已从资源管理器右键菜单移除'))
  } catch (e) {
    ElMessage.error((e as Error).message)
  } finally {
    explorerMenuBusy.value = false
  }
}

// 重置界面布局比例（左/中/右/上面板比例）
// configStore.resetUiLayout() 会：
//   1) 把 ui.layout 改回 defaultUiSettings.layout
//   2) 立即落盘到 ~/.zen-gitsync/config.json（不走防抖）
//   3) 返回新的 layout 让 App.vue 重新应用比例
async function onResetUiLayout() {
  try {
    // 触发 configStore 内置的 resetUiLayout（落盘 + 内存更新）
    const newLayout = await configStore.resetUiLayout()
    // 通知 App.vue 立刻把新比例应用到 DOM
    window.dispatchEvent(new CustomEvent('ui-layout-reset', { detail: { layout: newLayout } }))
    ElMessage.success($t('@42BB9:布局比例已重置为默认值'))
  } catch (e) {
    ElMessage.error(`${$t('@42BB9:重置布局失败: ')}${(e as Error).message}`)
  }
}

// 保存设置
async function handleSave() {  // 配置编辑 tab 单独处理
  // 模型表单尚未保存时拦截
  if (editingModelId.value !== undefined) {
    ElMessage.warning($t('@42BB9:模型尚未保存，请先保存或取消模型编辑'))
    return
  }
  if (activeTab.value === 'config') {
    await saveConfigJson()
    return
  }
  // 编辑器设置直接写入 store（watch 自动持久化到文件）
  if (activeTab.value === 'editor') {
    configStore.ui.editorAutoSave = tempEditorAutoSave.value
    configStore.ui.fileTreeAutoRefresh = tempFileTreeAutoRefresh.value
    ElMessage.success($t('@42BB9:编辑器设置已保存'))
    visible.value = false
    return
  }
  // 保存通用设置
  const generalSaved = await saveGeneralSettings()
  if (!generalSaved) return
  
  // 保存 Git 设置
  if (!tempUserName.value || !tempUserEmail.value) {
    ElMessage.warning($t('@42BB9:用户名和邮箱不能为空'))
    return
  }

  // 仅在用户信息发生变化时保存
  let userSaved = true
  if (tempUserName.value !== initUserName || tempUserEmail.value !== initUserEmail) {
    userSaved = await gitStore.restoreUserConfig(tempUserName.value, tempUserEmail.value)
    if (userSaved) {
      initUserName = tempUserName.value
      initUserEmail = tempUserEmail.value
    }
  }

  const cfgSaved = await saveGlobalGitConfigs()
  if (userSaved && cfgSaved) {
    visible.value = false
  }
}

// 点击配置 tab：加载配置 JSON
async function onClickConfigTab() {
  activeTab.value = 'config'
  if (configEditorText.value) return
  try {
    const formatResp = await fetch('/api/config/check-file-format')
    const formatData = await formatResp.json()
    if (!formatData.success) {
      ElMessage.warning(formatData.message || $t('@42BB9:配置文件格式可能有问题'))
    }
    configEditorText.value = JSON.stringify(configStore.config, null, 2)
  } catch {
    ElMessage.error($t('@42BB9:加载配置失败'))
  }
}

/**
 * 点击「记忆库」tab：首次进来才拉数据。
 *
 * 为什么不像别的 tab 那样直接 `activeTab = 'memory'`：panel 用的是 v-show
 * （本文件既有约定），意味着**打开设置弹窗时它就已经挂载了**。不懒加载的话，
 * 用户只是来改个主题，也会顺带触发一次 /api/memory/scopes。
 * 与「编辑配置」tab 的 onClickConfigTab 同一套理由与写法。
 */
const memoryPanelRef = ref<{ reload?: () => Promise<void> } | null>(null)
let memoryTabLoaded = false
function onClickMemoryTab() {
  activeTab.value = 'memory'
  if (memoryTabLoaded) return
  memoryTabLoaded = true
  // 组件自己 onMounted 就会 load 一次；这里只补一次"第二次点进来"的刷新，
  // 让用户在别处（比如任务跑完写了新经验）切回来能看到最新的
  nextTick(() => { memoryPanelRef.value?.reload?.() })
}

// 保存配置 JSON
async function saveConfigJson() {
  let parsed: any
  try {
    parsed = JSON.parse(configEditorText.value)
  } catch (e: any) {
    ElMessage.error(`${$t('@42BB9:JSON 解析失败: ')}${e.message || e}`)
    return
  }
  try {
    configEditorSaving.value = true
    const resp = await fetch('/api/config/saveAll', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: parsed })
    })
    const data = await resp.json()
    if (!data.success) {
      ElMessage.error(`${$t('@42BB9:保存失败: ')}${data.error || $t('@42BB9:未知错误')}`)
      return
    }
    await configStore.loadConfig()
    ElMessage.success($t('@42BB9:配置已保存'))
    visible.value = false
  } catch (err: any) {
    ElMessage.error(`${$t('@42BB9:保存配置失败: ')}${err.message || err}`)
  } finally {
    configEditorSaving.value = false
  }
}

// 打开系统配置文件
async function openSystemConfigFile() {
  try {
    const resp = await fetch('/api/config/open-file', { method: 'POST' })
    const data = await resp.json()
    if (data.success) {
      ElMessage.success($t('@42BB9:已用系统程序打开配置文件'))
    } else {
      ElMessage.error(data.error || $t('@42BB9:打开文件失败'))
    }
  } catch (err: any) {
    ElMessage.error(`${$t('@42BB9:打开文件失败: ')}${err.message || err}`)
  }
}
</script>

<style scoped>
/* 用户设置对话框样式 */
.user-settings-content {
  display: flex;
  gap: var(--spacing-lg);
  min-height: 400px;
}

/* 左侧标签页 - 现代化侧边栏设计 */
.settings-tabs {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 180px;
  flex-shrink: 0;
  padding: var(--spacing-sm);
  background: var(--bg-container);
  border-radius: var(--radius-xl);
  border: 1px solid var(--border-color);
}

.tab-item {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: var(--transition-ui-base);
  color: var(--el-text-color-regular);
  font-size: var(--font-size-sm);
  position: relative;
  user-select: none;
}

.tab-item::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 0;
  background: var(--color-primary);
  border-radius: 0 3px 3px 0;
  transition: height var(--transition-base) ease;
}

.tab-item:hover {
  background: rgba(0, 0, 0, 0.04);
  color: var(--el-text-color-primary);
}

.tab-item:hover::before {
  height: 50%;
}

.tab-item.active {
  background: var(--tint-primary-08);
  color: var(--color-primary);
  font-weight: 600;
}

.tab-item.active::before {
  height: 60%;
}

.tab-item .el-icon {
  font-size: var(--font-size-md);
}

/* 右侧面板 */
.settings-panels {
  flex: 1;
  min-width: 0;
}

.settings-panel {
  height: 100%;
  /* 设置项统一的两列节奏：标签列宽度 + 间隙 = 控件列的起始缩进 */
  --setting-label-width: 160px;
}

.user-form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
}

.basic-info-section {
  padding-top: 14px;
}

.basic-info-grid {
  display: flex;
  gap: var(--spacing-xl);
  align-items: center;
}

.form-item {
  flex: 1;
  margin-bottom: 0;
}

/* 用户设置-高级配置布局 */
.settings-section {
  margin-top: var(--spacing-base);
  padding-top: 14px;
}

.section-title {
  display: flex;
  align-items: center;
  margin-bottom: var(--spacing-lg);
  font-weight: 600;
  color: var(--color-text-title);
}

.settings-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--spacing-md) var(--spacing-xl);
  /* 两列网格里单元格只有内容区的一半宽，标签列沿用 160px 会把控件区压到 ~150px：
     实测下拉文案被截断、el-switch 的 active-text 被压成竖排单字。
     网格内收窄标签列，把省出来的宽度还给控件；单列区域仍用 160px 节奏。 */
  --setting-label-width: 118px;
}

.setting-row {
  display: grid;
  grid-template-columns: var(--setting-label-width) 1fr;
  gap: var(--spacing-md);
  align-items: center;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--el-text-color-regular);
  text-align: right;
  padding-right: var(--spacing-base);
}

.setting-label .qmark {
  margin-left: 6px;
  
  color: var(--el-text-color-secondary);
  vertical-align: -1px;
  cursor: help;
}

.setting-label .qmark:hover {
  color: var(--color-primary);
}


:deep(.settings-grid .el-switch) {
  --el-switch-on-color: var(--color-primary);
  --el-switch-off-color: var(--el-border-color);
}

:deep(.settings-grid .el-select) {
  width: 100%;
}

:deep(.settings-grid .el-input) {
  width: 100%;
}

/* "界面" 子分区专用样式 */
/* 命令控制台不跨整行——让它在 col 1 单元格内，避免里面的 slider 撑满整个对话框宽度。
   保持默认的 .setting-row 布局（160px label + 1fr control），
   1fr 区域 = col 1 宽度 - 160px，与"文件差异分割"slider 所在 col 2 的 1fr 区域等宽，
   两个 slider 自然对齐。 */
.setting-row--full {
  align-items: start; /* label 顶部对齐到 sub-options 顶部 */
}
/* 跨整行：说明文案长（系统集成那类），半宽单元格里会被压成好几行 */
.setting-row--span {
  grid-column: 1 / -1;
}
.console-sub-options {
  /* 3 个开关 + 比例滑条：两列网格，跨行后宽度够了就不必再竖着堆 4 层 */
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--spacing-sm) var(--spacing-xl);
}
/* 开关的 active-text 在窄容器里会被逐字折行（CJK min-content = 1 字宽），
   这里显式禁止换行，保证「默认展开 / 使用终端执行 / 显示终端会话」单行显示 */
:deep(.console-sub-options .el-switch__label) {
  white-space: nowrap;
}
/* 顶栏工具图标：两列网格，每项 = 品牌图标 + 名称 + 右侧开关。
   整体从控件列起（标签列 + 间隙），左侧留白和其它设置项的内容对齐，不贴分区标题的左边 */
.header-tools-row {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  padding-left: calc(var(--setting-label-width) + var(--spacing-md));
}
.header-tools {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px var(--spacing-xl);
}
.header-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.header-tool__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: 0 0 16px;
  font-size: var(--font-size-md);
}
.header-tool__name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--el-text-color-regular);
}
/* 开关贴格子右侧：两列的开关各成一列，扫一眼就知道哪些开了 */
.header-tool__switch {
  margin-left: auto;
  flex-shrink: 0;
  --el-switch-on-color: var(--color-primary);
  --el-switch-off-color: var(--el-border-color);
}
/* 取消勾选 = 该工具收进「更多」菜单：图标降饱和 + 名称转次要色，和开着的区分开 */
.header-tool.is-off .header-tool__icon {
  opacity: 0.55;
  filter: grayscale(0.6);
}
.header-tool.is-off .header-tool__name {
  color: var(--el-text-color-secondary);
}
.console-split-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: var(--spacing-xs);
}
.layout-actions {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  flex-wrap: wrap; /* 空间不足时让提示文案换行到下一行，而不是被压成一列字 */
}
/* CJK 文本在 flex 里的 min-content 只有一个字宽，不给下限会被压成竖排 */
.layout-actions .setting-hint-block {
  flex: 1 1 auto;
  min-width: 16ch;
}
.project-toggle {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-width: 0;
}
.project-toggle .setting-hint-block {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* 智能体运行时的说明较长，允许换行完整展示（默认 hint 是单行省略号截断） */
.project-toggle .ai-iterations-hint {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.5;
}
/* 任务完成提示的说明/告警同理：单行截断会把"浏览器已拒绝权限"这类关键信息吃掉 */
.project-toggle .notify-hint {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.5;
}
/* 「当前模型：xxx」这行第三个：它和上面两条不同 —— 上面是"说明"，这条是**事实值**。
   单行截断会把模型名腰斩在 `opencode-go/space-bunn…`（实测），而那正是这行唯一的信息量，
   截了等于没写。选项里的模型名（.executor-option__model）已经这么修过一次了。 */
.project-toggle .setting-hint-block.executor-model-line {
  white-space: normal;
  overflow: visible;
  text-overflow: clip;
  line-height: 1.5;
}
.notify-hint--warn {
  color: var(--color-warning-dark);
}
/* 提示音是「任务完成提示」的子选项：左侧竖线 + 缩进表达从属关系，别让它看起来和
   总开关平级 —— 平级的两个开关会让人以为"关了总开关声音还在"（实际不会响）。 */
.notify-sub {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 4px;
  /* 2026-10-04：原本是 border-left: 2px solid var(--el-border-color)。
     那根竖线在这里只承担「缩进」这一个职责（没有语义色彩），去掉之后
     由 padding-left 独自表达缩进。 */
}
.notify-sub__head {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}
.notify-sub__label {
  font-size: var(--font-size-xs);
  color: var(--el-text-color-regular);
}
/* 置灰时连说明一起降透明度，让"现在不生效"一眼看得出来 */
.notify-sub:has(.el-switch.is-disabled) .notify-sub__hint {
  opacity: var(--disabled-opacity);
}
.ai-iterations-input {
  width: 140px;
}
.setting-hint-inline {
  margin-left: 8px;
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
  font-weight: 400;
}
.setting-hint-block {
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
}
.setting-slider {
  width: 100%;
}
:deep(.setting-slider .el-slider__runway) {
  margin: 0;
}

/* 深色主题适配 */
html.dark .info-card {
  background: linear-gradient(135deg, var(--tint-primary-12) 0%, var(--tint-primary-06) 100%);
  border-color: var(--tint-primary-22);
}

html.dark .info-card:hover {
  border-color: var(--tint-primary-35);
  box-shadow: var(--shadow-md);
}

html.dark .basic-info-section {
  background: rgba(255, 255, 255, 0.03);
  border-color: rgba(255, 255, 255, 0.1);
}

html.dark .basic-info-section:hover {
  border-color: var(--tint-primary-30);
  box-shadow: var(--shadow-md);
}

html.dark .label-icon {
  color: rgba(255, 255, 255, 0.5);
}

.form-label {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  
  font-weight: 500;
  color: var(--color-text-title);
}

.label-icon {
  font-size: var(--font-size-md);
  color: var(--color-primary);
}

:deep(.modern-input .el-input__wrapper) {
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-input);
  box-shadow: var(--shadow-sm);
  transition: var(--transition-ui-base);
  background: var(--bg-container);
}

:deep(.modern-input .el-input__wrapper:hover) {
  border-color: var(--color-gray-300);
  box-shadow: var(--shadow-md);
}

:deep(.modern-input.is-focus .el-input__wrapper) {
  border-color: #3498db;
  box-shadow: 0 0 0 2px rgba(52, 152, 219, 0.1), 0 2px 6px rgba(0, 0, 0, 0.08);
}

:deep(.modern-input .el-input__inner) {
  
  color: var(--text-title);
  font-weight: 400;
}

:deep(.modern-input .el-input__inner::placeholder) {
  color: var(--color-gray-400);
  font-weight: 400;
}

.info-section {
  margin-bottom: var(--spacing-base);
}

.info-card {
  display: flex;
  align-items: flex-start;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: linear-gradient(135deg, var(--tint-primary-08) 0%, var(--tint-primary-4) 100%);
  border: 1px solid var(--tint-primary-18);
  border-radius: var(--radius-xl);
  position: relative;
  overflow: hidden;
  transition: var(--transition-ui-slow);
}

.info-card:hover {
  border-color: var(--tint-primary-30);
  box-shadow: var(--shadow-md);
}

.info-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
  background: linear-gradient(135deg, var(--color-primary) 0%, var(--color-primary-dark) 100%);
}

.info-icon {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-primary);
  flex-shrink: 0;
  margin-top: 0;
}

.info-icon .el-icon {
  font-size: var(--font-size-xl);
}

.info-content {
  flex: 1;
}

.info-title {
  margin: 0 0 6px 0;
  
  font-weight: 600;
  color: var(--color-text-title);
  letter-spacing: 0.3px;
}

.info-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--el-text-color-regular);
  line-height: 1.6;
}

.user-settings-footer {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0;
}

/* 配置编辑面板 */
.config-panel {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.config-json-editor-wrap {
  flex: 1;
  border-radius: var(--radius-lg);
  overflow: hidden;
  border: 1.5px solid var(--border-color-medium);
  transition: border-color var(--transition-base) ease;
  min-height: 280px;
}

.config-json-editor-wrap:focus-within {
  border-color: var(--color-primary);
  box-shadow: var(--shadow-focus);
}

:deep(.config-json-editor) {
  height: 100%;
  .el-textarea__inner {
    height: 280px;
    min-height: 280px;
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: 1.6;
    border: none;
    box-shadow: none;
    resize: none;
    border-radius: var(--radius-lg);
  }
}

.config-panel-actions {
  display: flex;
  justify-content: flex-start;
}

.system-config-btn {
  background: var(--bg-panel);
  color: var(--text-secondary);
  border: 1px solid var(--border-color-medium);
}

.system-config-btn:hover {
  background: var(--bg-panel-hover);
  border-color: var(--color-primary);
  color: var(--color-primary);
}

/* footer-actions、dialog-cancel-btn、dialog-confirm-btn 基础样式已移至 @/styles/common.scss */

/* 提交设置 - 单列布局 */
.commit-settings-grid {
  grid-template-columns: 1fr !important;
}

.commit-settings-grid .setting-label {
  text-align: left;
  padding-right: 0;
}

/* AI 模型配置 */
.model-section-title {
  justify-content: space-between;
}

.add-model-btn {
  font-size: var(--font-size-xs);
  padding: 4px 12px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--color-primary);
  background: transparent;
  color: var(--color-primary);
  cursor: pointer;
  transition: background var(--transition-base), color var(--transition-base);
}

.add-model-btn:hover {
  background: var(--color-primary);
  color: #fff;
}

.model-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.model-empty {
  font-size: var(--font-size-sm);
  color: var(--el-text-color-secondary);
  padding: 12px 0;
}

.model-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--radius-lg);
  background: var(--bg-container);
  transition: border-color var(--transition-base);
}

.model-card:hover {
  border-color: var(--color-primary);
}

.model-info {
  flex: 1;
  min-width: 0;
}

.model-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 3px;
}

.model-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-title);
}

.model-default-badge {
  font-size: var(--font-size-xs);
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: var(--tint-primary-12);
  color: var(--color-primary);
  font-weight: 500;
}

.model-meta {
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.model-btn {
  font-size: var(--font-size-sm);
  padding: 3px 10px;
  border-radius: var(--radius-md);
  border: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: var(--transition-ui-base);
}

.model-btn:hover {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.model-btn--danger:hover {
  border-color: var(--el-color-danger);
  color: var(--color-danger-dark);
}

.model-form {
  padding: 16px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--radius-xl);
  background: var(--bg-container);
  margin-top: 4px;
}

.model-form-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-title);
  margin-bottom: 14px;
}

.model-form-grid {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 14px;
}

.model-form-row {
  display: grid;
  grid-template-columns: 100px 1fr;
  gap: var(--spacing-md);
  align-items: center;
}

.model-form-label {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--el-text-color-regular);
  text-align: right;
  padding-right: var(--spacing-base);
}

.model-form-label .req {
  color: var(--color-danger-dark);
  margin-left: 2px;
}

.model-form-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.model-test-result {
  flex: 1;
  min-width: 0;
}

.model-test-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-sm);
  padding: 3px 10px;
  border-radius: var(--radius-lg);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-test-badge--ok {
  background: rgba(103, 194, 58, 0.12);
  color: #4caf50;
  border: 1px solid rgba(103, 194, 58, 0.3);
}

.model-test-badge--fail {
  background: rgba(245, 108, 108, 0.1);
  color: var(--color-danger-dark);
  border: 1px solid rgba(245, 108, 108, 0.25);
}

.model-test-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--el-border-color);
  background: transparent;
  color: var(--el-text-color-regular);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: var(--transition-ui-base);
}

.model-test-btn:hover:not(:disabled) {
  border-color: var(--color-primary);
  color: var(--color-primary);
}

.model-test-btn:disabled {
  opacity: var(--disabled-opacity);
  cursor: not-allowed;
}

@keyframes model-spin {
  to { transform: rotate(360deg); }
}

.model-test-spin {
  display: inline-block;
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: model-spin 0.7s linear infinite;
}

.preset-option-name {
  display: block;
  font-size: var(--font-size-sm);
  color: var(--color-text-title);
  font-weight: 500;
}

.preset-option-url {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
  margin-top: 1px;
}

:deep(.el-select-dropdown__item) {
  height: auto;
  padding: 6px 12px;
  line-height: 1.3;
}

/* 任务执行器下拉选项：右侧「未安装」小标（沿用 preset-option 的排版习惯） */
.executor-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.executor-option__icon { font-size: var(--font-size-base); flex: none; }

.executor-option__missing {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
}

/* 选项里那个模型名：承载信息的元文字，用 --text-meta 而不是 --text-tertiary
   （后者是对比度不达 AA 的装饰档，只配给状态点/图标用）。
   这里**不设 max-width** —— 设置弹窗有大把横向空间，配合 fit-input-width=false
   让它完整显示；模型名截成 `opencode-go/space-bunny-…` 等于白显示
   （窄栏那两处 picker 才需要截断，见各自的 max-width） */
.executor-option__model {
  white-space: nowrap;
  font-size: var(--font-size-xs);
  color: var(--text-meta);
}

/* 「当前模型：xxx（别名 · 服务商）」—— 事实值，比上一条说明文字实一档。
   ⚠️ 它在 `.project-toggle` 里，会被那条「单行 + 省略号」的 hint 规则吃掉模型名；
   允许换行的覆盖写在 `.notify-hint` 旁边（三条"别截断"的 hint 放一起），别在这重复。 */
.executor-model-line {
  font-weight: 500;
}
.executor-model-line__detail {
  font-weight: 400;
  color: var(--el-text-color-secondary);
  /* 括号里那段（别名 · 服务商 / CLI 内最近使用）整体换行，别断在括号中间 ——
     窄列下 "（CLI 内最 / 近使用）" 这种断法比截断好不了多少 */
  white-space: nowrap;
}

/* ---------------- Markdown 预览主题（全局唯一） ---------------- */
/* 左列下拉 + 右列实时预览卡片。下拉弹层贴着 select 左边缘、宽度 = select 宽度，
   卡片落在 320px 之后，所以展开时弹层不会盖住正在看的预览。 */
.md-theme-panel {
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
  gap: var(--spacing-lg);
  align-items: start;
  min-width: 0;
}

.md-theme-col {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
  min-width: 0;
}

.md-theme-select {
  width: 100%;
}

.md-theme-preview {
  min-width: 0;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: var(--radius-lg);
  overflow: hidden;
  /* 卡片底：主题自身会给 .md-preview 铺底色，这里只兜住加载/缺色时的观感 */
  background: var(--el-fill-color-blank);
}

.md-theme-preview__head {
  display: flex;
  align-items: center;
  gap: var(--spacing-base);
  padding: 5px 10px;
  font-size: var(--font-size-xs);
  color: var(--el-text-color-secondary);
  background: var(--el-fill-color-light);
  border-bottom: 1px solid var(--el-border-color-lighter);
}

.md-theme-preview__name {
  font-family: var(--font-mono);
  color: var(--el-text-color-primary);
}

.md-theme-preview__tag {
  margin-left: auto;
  flex: none;
  padding: 1px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--el-border-color-lighter);
  transition: color 0.15s, border-color 0.15s;
}

.md-theme-preview__tag.is-hover {
  color: var(--el-color-primary);
  border-color: var(--el-color-primary);
}

/* 固定高度：内容超出时由主题自己那层（overflow:auto）滚动，卡片高度不跳 */
.md-theme-preview__body {
  height: 208px;
}

/* 窄屏放不下两列：卡片落到下拉下方（弹层展开时可能压住卡片，收起后即可见） */
@media (max-width: 1100px) {
  .md-theme-panel {
    grid-template-columns: minmax(0, 1fr);
  }
}

/* 下拉项：左侧一块主题底色 + 主题名（el-option 的 slot 内容仍属本组件作用域，
   即便 dropdown 被 teleport 到 body，scoped 属性选择器也照样命中） */
.md-theme-option {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}

.md-theme-swatch {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 24px;
  height: 18px;
  border-radius: 4px;
  border: 1px solid var(--el-border-color-lighter);
  font-size: 11px;
  line-height: 1;
  font-weight: 600;
  overflow: hidden;
}
</style>
