declare module 'local-file-picker/client' {
  import type { DefineComponent } from 'vue'
  const FilePicker: DefineComponent<
    { visible?: boolean; apiBase?: string },
    object,
    object
  >
  export default FilePicker
}
