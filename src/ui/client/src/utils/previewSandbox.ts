/**
 * HTML 预览 iframe 沙箱策略单点 — DiffPreviewPanel / EditorView 两处复用。
 *
 * 背景: 预览 iframe 之前是 sandbox="allow-same-origin"(无 allow-scripts),
 * 预览页里所有 JS 被禁用,报告类 HTML 的按钮/折叠/tab 全部点不动。
 *
 * 现行策略:
 *   - sandbox = "allow-scripts allow-forms allow-popups allow-modals"
 *     → JS/表单/弹窗/JS 对话框可用,但【不带】allow-same-origin,
 *       预览页运行在不透明 origin,无法访问宿主应用的 DOM/localStorage(防沙箱逃逸)。
 *   - 不透明 origin 下访问 window.localStorage / sessionStorage / document.cookie
 *     会直接抛 SecurityError,很多生成的报告页(主题持久化等)会在顶层脚本里
 *     无保护地访问它们 → 整个脚本挂掉、交互依旧失效。
 *     因此向 srcdoc 注入一段内存版 storage/cookie shim 兜底。
 */

/** 预览 iframe 统一使用的 sandbox 属性值 */
export const PREVIEW_IFRAME_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'

// 注入到预览页最前面的 shim 脚本:仅当原生 storage/cookie 不可用(抛 SecurityError)时
// 才用内存版实现遮蔽,可用时保持原生行为。注意结尾 </script> 必须转义,避免截断宿主 HTML。
const SHIM_SCRIPT = `<script>(function(){
try{window.localStorage.getItem('__zk')}catch(e){
var d={};var s={getItem:function(k){return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[k]=String(v)},removeItem:function(k){delete d[k]},clear:function(){d={}},key:function(i){var ks=Object.keys(d);return i<ks.length?ks[i]:null}};
Object.defineProperty(window,'localStorage',{get:function(){return s},configurable:true});
Object.defineProperty(window,'sessionStorage',{get:function(){return s},configurable:true});}
try{document.cookie='__zk=1'}catch(e){
try{Object.defineProperty(document,'cookie',{get:function(){return ''},set:function(){},configurable:true})}catch(e2){}}
})()</` + `script>`

/**
 * 向 HTML 源码注入沙箱兼容 shim。
 * 插入点优先级: <meta charset> 之后(避免把 charset 声明挤出前 1024 字节影响编码探测)
 * → <head> 开标签后 → <html> 开标签后 → <!DOCTYPE> 后 → 直接前置。
 */
export function injectHtmlPreviewShims(html: string): string {
  if (!html) return html
  const patterns = [/<meta[^>]+charset[^>]*>/i, /<head[^>]*>/i, /<html[^>]*>/i, /<!doctype[^>]*>/i]
  for (const re of patterns) {
    const m = html.match(re)
    if (m && m.index !== undefined) {
      const idx = m.index + m[0].length
      return html.slice(0, idx) + SHIM_SCRIPT + html.slice(idx)
    }
  }
  return SHIM_SCRIPT + html
}
