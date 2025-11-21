<template>
  <svg :class="svgClass" aria-hidden="true">
    <use :xlink:href="iconName" />
  </svg>
</template>

<script lang="ts" setup name="SvgIcon">
  import { computed, defineProps } from 'vue'
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
}
</style>
