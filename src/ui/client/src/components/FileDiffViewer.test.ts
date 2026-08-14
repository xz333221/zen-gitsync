import { beforeEach, describe, expect, test } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { nextTick } from 'vue'
import { useConfigStore } from '@/stores/configStore'
import FileDiffViewer from './FileDiffViewer.vue'

const slotStub = { template: '<div><slot /></div>' }

describe('FileDiffViewer AI summaries', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  test('renders separate overall and selected-file summaries only when enabled', async () => {
    const store = useConfigStore()
    store.setCurrentDirectory('C:\\repo')
    const wrapper = mount(FileDiffViewer, {
      props: {
        files: [{ path: 'src/a.ts', type: 'modified' }],
        selectedFile: 'src/a.ts',
        diffContent: '+changed',
        context: 'git-status',
      },
      global: {
        stubs: {
          AiDiffSummary: {
            props: ['scope'],
            template: '<div class="summary-stub" :data-scope="scope" />',
          },
          ElSplitter: slotStub,
          ElSplitterPanel: slotStub,
          ElScrollbar: slotStub,
          ElTooltip: slotStub,
          ElButton: slotStub,
          ElInput: true,
          ElEmpty: true,
          ElIcon: slotStub,
          FileActionButtons: true,
          FileTreeView: true,
          IconButton: slotStub,
          SvgIcon: true,
          ImagePreview: true,
          MonacoDiffViewer: true,
          MonacoEditor: true,
        },
      },
    })

    expect(wrapper.findAll('.summary-stub').map(node => node.attributes('data-scope')))
      .toEqual(['overall', 'file'])

    await store.setAiDiffSummaryEnabled(false)
    await nextTick()
    expect(wrapper.findAll('.summary-stub')).toHaveLength(0)
  })
})
