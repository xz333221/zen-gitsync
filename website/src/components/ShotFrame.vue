<script setup>
defineProps({
  src: { type: String, required: true },
  alt: { type: String, required: true },
  caption: { type: String, default: '' },
  eager: { type: Boolean, default: false },
  bleed: { type: Boolean, default: false },
  // 浅色画布的产品截图(例如思维导图):加深边框与投影，让它像贴在深色页面上的"一张纸"
  paper: { type: Boolean, default: false },
  // 视频版:src 指向 .mp4,自动静音循环播放;poster 用同画面的截图兜底(加载中/不自动播放时)
  video: { type: Boolean, default: false },
  poster: { type: String, default: '' }
})
</script>

<template>
  <figure class="shot" :class="{ 'shot--bleed': bleed, 'shot--paper': paper }">
    <div class="shot__frame">
      <video
        v-if="video"
        :src="src"
        :poster="poster || undefined"
        :aria-label="alt"
        autoplay
        muted
        loop
        playsinline
        preload="metadata"
      ></video>
      <img v-else :src="src" :alt="alt" :loading="eager ? 'eager' : 'lazy'" decoding="async" />
    </div>
    <figcaption v-if="caption" class="shot__cap">{{ caption }}</figcaption>
  </figure>
</template>

<style scoped>
.shot {
  margin: 0;
}

.shot__frame {
  border: 1px solid var(--line-2);
  border-radius: var(--r-2);
  overflow: hidden;
  background: var(--panel);
  box-shadow: var(--shadow-1);
  transition:
    transform var(--dur-2) var(--ease-spring),
    border-color var(--dur-2) var(--ease-out),
    box-shadow var(--dur-2) var(--ease-out);
}

.shot__frame:hover {
  transform: translateY(-3px);
  border-color: var(--line-3);
  box-shadow: var(--shadow-2);
}

.shot__frame img,
.shot__frame video {
  display: block;
  width: 100%;
  height: auto;
}

.shot--bleed .shot__frame {
  border-radius: var(--r-3);
}

.shot--paper .shot__frame {
  border-color: rgba(255, 255, 255, 0.2);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.08) inset,
    0 30px 70px rgba(0, 0, 0, 0.55);
}

.shot__cap {
  margin-top: 12px;
  color: var(--text-3);
  font-family: var(--font-mono);
  font-size: 0.75rem;
  letter-spacing: -0.01em;
}
</style>
