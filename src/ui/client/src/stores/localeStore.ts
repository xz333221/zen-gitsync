import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getLocale, setLocale, type SupportLocale } from '@/locales'
import { getElementPlusLocale } from '@/plugins/elementPlus'

export const useLocaleStore = defineStore('locale', () => {
  // 当前语言
  const currentLocale = ref<SupportLocale>(getLocale())

  // Element Plus 语言包
  const elementPlusLocale = computed(() => getElementPlusLocale(currentLocale.value))

  // 切换语言
  function changeLocale(locale: SupportLocale) {
    setLocale(locale)
    currentLocale.value = locale
  }

  return {
    currentLocale,
    elementPlusLocale,
    changeLocale,
  }
})
