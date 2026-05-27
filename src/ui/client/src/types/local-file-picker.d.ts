declare module 'local-file-picker/client' {
  import type { DefineComponent } from 'vue'
  const FilePickerModal: DefineComponent<
    {
      visible?: boolean;
      mode?: 'file' | 'directory';
      multiple?: boolean;
      theme?: 'dark' | 'light';
      apiBase?: string;
    },
    object,
    object
  >
  export { FilePickerModal }
}
