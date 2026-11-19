import { translate as sharedTranslate, type Locale } from '../../../../src/shared/i18n'

export * from '../../../../src/shared/i18n'

const OVERRIDES: Record<Locale, Record<string, string>> = {
  zh: {
    'Code Map': '架构图',
    'Code Map (⇧⌘Y)': '架构图 (⇧⌘Y)',
    'Toggle Code Map': '切换架构图',
    'Show in Code Map': '在架构图中显示',
    'Show Code Map Checks': '显示架构图校验',
    'Back to Code Map': '回到架构图',
    'Back to Code Map (Esc)': '回到架构图 (Esc)',
    'Open Code Map': '打开架构图',
    'Reading the code map': '正在读取架构图',
    'Cannot load the code map': '无法读取架构图',
    'Code map updated': '架构图已更新',
    'No code map loaded': '还没有读取架构图',
    'Code map of {name}': '{name} 的架构图',
    'Folders outside the open folder the code map may read': '允许架构图读取的外部文件夹',
    'None yet. The code map asks before reading a folder outside the open folder.': '还没有。读取打开的文件夹之外的目录前，架构图会先询问。',
    Map: '地图',
    Architecture: '架构',
    'Architecture Map': '架构图',
    Follow: '跟随',
    Info: '详情',
    Expand: '展开',
    Sidebar: '侧边栏',
    'Follow Active Editor Cursor': '跟随当前编辑器光标',
    'Toggle Details / Prefixes Drawer': '切换详情 / 前缀抽屉',
    'Open Full Map in Editor Area': '在编辑区全屏打开地图',
    'Dock Map in Sidebar': '把地图停靠到侧边栏'
  },
  en: {
    'Code Map': 'Architecture Map',
    'Code Map (⇧⌘Y)': 'Architecture Map (⇧⌘Y)',
    'Toggle Code Map': 'Toggle Architecture Map',
    'Show in Code Map': 'Show in Architecture Map',
    'Show Code Map Checks': 'Show Architecture Map Checks',
    'Back to Code Map': 'Back to Architecture Map',
    'Back to Code Map (Esc)': 'Back to Architecture Map (Esc)',
    'Open Code Map': 'Open Architecture Map',
    'Reading the code map': 'Reading the architecture map',
    'Cannot load the code map': 'Cannot load the architecture map',
    'Code map updated': 'Architecture map updated',
    'No code map loaded': 'No architecture map loaded',
    'Code map of {name}': 'Architecture map of {name}',
    'Folders outside the open folder the code map may read': 'Folders outside the open folder the architecture map may read',
    'None yet. The code map asks before reading a folder outside the open folder.':
      'None yet. The architecture map asks before reading a folder outside the open folder.',
    Map: 'Map',
    Architecture: 'Arch',
    'Architecture Map': 'Architecture Map',
    Follow: 'Follow',
    Info: 'Info',
    Expand: 'Expand',
    Sidebar: 'Sidebar',
    'Follow Active Editor Cursor': 'Follow Active Editor Cursor',
    'Toggle Details / Prefixes Drawer': 'Toggle Details / Prefixes Drawer',
    'Open Full Map in Editor Area': 'Open Full Map in Editor Area',
    'Dock Map in Sidebar': 'Dock Map in Sidebar'
  }
}

export function translate(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const text = OVERRIDES[locale]?.[key]
  if (text == null) return sharedTranslate(locale, key, vars)
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match))
}
