/**
 * 静态翻译函数类型声明
 */

/**
 * 翻译函数
 * @param key - 翻译键名
 * @param params - 翻译参数
 * @returns 翻译后的文本
 */
export declare function $t(key: string, params?: Record<string, any>): string

/**
 * 检查翻译键是否存在
 * @param key - 翻译键名
 * @returns 是否存在该键
 */
export declare function $te(key: string): boolean


export default $t
