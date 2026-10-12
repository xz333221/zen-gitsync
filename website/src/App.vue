<script setup>
import SiteHeader from './components/SiteHeader.vue'
import HeroSection from './components/HeroSection.vue'
import QuickCommitSection from './components/QuickCommitSection.vue'
import WorkbenchSection from './components/WorkbenchSection.vue'
import AgentSection from './components/AgentSection.vue'
import FeatureSplit from './components/FeatureSplit.vue'
import MindmapSection from './components/MindmapSection.vue'
import InstallSection from './components/InstallSection.vue'
import SiteFooter from './components/SiteFooter.vue'
import { SHOTS } from './data/site.js'

const gitPoints = [
  { title: '选中什么，就提交什么', desc: '在文件列表里勾好改动，快捷提交只走选中的那几个文件。' },
  { title: '分支、远端、stash、tag 在同一页', desc: '建分支、切分支、加远端、暂存 stash、打 tag,不用回终端。' },
  { title: '提交信息交给 AI', desc: '从 diff 生成提交信息，也能一键跑完"生成 → 暂存 → 提交 → 推送"。' },
  { title: '远端仓库就在手边', desc: '列出 GitHub / Gitee 账号下的仓库，能搜、能克隆，还标出本地已有的副本。' }
]

const filePoints = [
  { title: '当成笔记本来用', desc: 'Markdown、代码、图片都能直接预览，拖进来就能读。' },
  { title: '复制富文本', desc: 'Markdown 一键复制成带样式的富文本，粘到公众号一类平台不用重排。' },
  { title: '对着文件问智能体', desc: '打开的文件就是上下文，直接问这段在做什么，或者让它动手改。' }
]
</script>

<template>
  <SiteHeader />

  <main>
    <HeroSection />
    <QuickCommitSection />
    <WorkbenchSection />
    <AgentSection />

    <FeatureSplit
      id="git"
      alt
      reverse
      title="界面打开就是 Git 总览"
      body="g ui 的首页把改动、分支、远端、仓库浏览器放在一起。看得见自己在哪一步，再决定要不要提交。"
      :points="gitPoints"
      :shot="SHOTS.gitView"
      shot-alt="Git 总览页：左侧文件改动列表，中间 diff 对比，顶部是分支与提交区域"
      caption="Git 总览页：改动、diff、提交区在同一屏"
    />

    <FeatureSplit
      id="filespace"
      title="文件空间，顺便当了笔记本"
      body="常用的第二个板块。预览、复制、改文件，还能顺手把正在读的东西丢给智能体。"
      :points="filePoints"
      :shot="SHOTS.fileSpace"
      shot-alt="文件空间：左侧文件树，右侧 Markdown 预览，顶部有复制富文本按钮"
      caption="文件空间：Markdown 预览与复制富文本"
    />

    <MindmapSection />
    <InstallSection />
  </main>

  <SiteFooter />
</template>
