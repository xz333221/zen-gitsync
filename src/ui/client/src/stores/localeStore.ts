import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { getLocale, setLocale, type SupportLocale } from '@/locales'
import { getElementPlusLocale } from '@/plugins/elementPlus'
import { useConfigStore } from './configStore'

export const useLocaleStore = defineStore('locale', () => {
  // 当前语言
  const currentLocale = ref<SupportLocale>(getLocale())

  // Element Plus 语言包
  const elementPlusLocale = computed(() => getElementPlusLocale(currentLocale.value))

  // 切换语言
  async function changeLocale(locale: SupportLocale) {
    setLocale(locale)
    currentLocale.value = locale
    
    // 同步保存到服务器配置
    const configStore = useConfigStore()
    if (configStore.locale !== locale) {
      await configStore.saveGeneralSettings({ locale })
    }
  }

  return {
    currentLocale,
    elementPlusLocale,
    changeLocale,
  }
})
