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
  <svg :class="svgClass" aria-hidden="true">
    <use :xlink:href="iconName" />
  </svg>
</template>

<script lang="ts" setup name="SvgIcon">
  import { computed } from 'vue'
const props = defineProps({
    iconClass: {
        type: String,
        required: true,
    },
    className: {
        type: String,
        default: '',
    },
})
  const iconName = computed(() => {
      return `#icon-${props.iconClass}`
  })
  const svgClass = computed(() => {
      if (props.className) {
          return `svg-icon ${props.className}`
      } else {
          return 'svg-icon'
      }
  })
// export default {
//   name: 'SvgIcon',
//   props: {
//     iconClass: {
//       type: String,
//       required: true
//     },
//     className: {
//       type: String,
//       default: ''
//     }
//   },
//   computed: {
//     iconName() {
//       return `#icon-${this.iconClass}`
//     },
//     svgClass() {
//       if (this.className) {
//         return 'svg-icon ' + this.className
//       } else {
//         return 'svg-icon'
//       }
//     }
//   }
// }
</script>

<style scoped>
.svg-icon {
  width: 1em;
  height: 1em;
  vertical-align: -0.15em;
  fill: currentColor;
  overflow: hidden;
  color: var(--text-secondary);
}
</style>
