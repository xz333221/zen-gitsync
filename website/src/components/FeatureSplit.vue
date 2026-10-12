<script setup>
import ShotFrame from './ShotFrame.vue'

defineProps({
  id: { type: String, default: undefined },
  title: { type: String, required: true },
  body: { type: String, required: true },
  points: { type: Array, default: () => [] }, // [{ title, desc }]
  shot: { type: String, default: '' },
  shotAlt: { type: String, default: '' },
  caption: { type: String, default: '' },
  reverse: { type: Boolean, default: false },
  alt: { type: Boolean, default: false } // 交替背景
})
</script>

<template>
  <section :id="id" class="section" :class="{ 'section--alt': alt }">
    <div class="shell split" :class="{ 'split--reverse': reverse }">
      <div class="split__copy">
        <h2 class="h2" v-reveal>{{ title }}</h2>
        <p class="lede split__body" v-reveal="80">{{ body }}</p>

        <ul v-if="points.length" class="split__points">
          <li v-for="(p, i) in points" :key="p.title" v-reveal="140 + i * 70">
            <h3 class="h3 point__title">{{ p.title }}</h3>
            <p class="body-2 point__desc">{{ p.desc }}</p>
          </li>
        </ul>
      </div>

      <div class="split__visual" v-reveal="130">
        <slot name="visual">
          <ShotFrame :src="shot" :alt="shotAlt" :caption="caption" />
        </slot>
      </div>
    </div>
  </section>
</template>

<style scoped>
.split {
  display: grid;
  grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.15fr);
  gap: clamp(30px, 4.6vw, 72px);
  align-items: center;
}

.split__copy {
  display: grid;
  gap: 16px;
  align-content: center;
}

.split__body {
  max-width: 46ch;
}

.split__points {
  display: grid;
  gap: 20px;
  margin-top: 8px;
}

.point__title {
  color: var(--text);
}

.point__desc {
  margin-top: 5px;
  max-width: 44ch;
}

/* 反向区块：图在左、文在右(左右交替，避免连续同向) */
.split--reverse .split__copy {
  order: 2;
}
.split--reverse .split__visual {
  order: 1;
}

@media (max-width: 900px) {
  .split {
    grid-template-columns: minmax(0, 1fr);
    gap: 30px;
  }
  .split--reverse .split__copy,
  .split--reverse .split__visual {
    order: initial;
  }
}
</style>
