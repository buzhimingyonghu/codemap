declare module 'yaml' {
  export function parse(text: string): any
  export function parseDocument(text: string, options?: any): any
  export function isMap(value: unknown): value is any
  export function isScalar(value: unknown): value is any
  export function isSeq(value: unknown): value is any
  export interface Pair<K = any, V = any> { key: any; value: any }
  export interface YAMLMap<K = any, V = any> { items: any[]; flow?: boolean; range?: any; get(key: string, keep?: boolean): any; toJS(doc?: any): any }
}
