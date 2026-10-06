const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sideMemo', {
  getState: () => ipcRenderer.invoke('state:get'),
  listDisplays: () => ipcRenderer.invoke('displays:list'),
  saveTabs: (payload) => ipcRenderer.invoke('state:saveTabs', payload),
  saveSettings: (settings) => ipcRenderer.invoke('state:saveSettings', settings),

  setPanel: (expanded, opts) => ipcRenderer.invoke('panel:set', expanded, opts),
  setInteractive: (value) => ipcRenderer.invoke('panel:setInteractive', value),
  setTabDragging: (value) => ipcRenderer.invoke('tabs:dragging', value),
  moveTabToDock: (tabId, point) => ipcRenderer.invoke('tabs:moveToDock', { tabId, point }),
  onDropTarget: (cb) => ipcRenderer.on('tabs:dropTarget', (_e, v) => cb(v)),
  onReceiveTab: (cb) => ipcRenderer.on('tabs:receive', (_e, v) => cb(v)),
  focusPanel: () => ipcRenderer.invoke('panel:focus'),
  useWidth: (width) => ipcRenderer.invoke('panel:useWidth', width),
  setShortcuts: (next) => ipcRenderer.invoke('shortcuts:set', next),
  beginResize: () => ipcRenderer.invoke('panel:beginResize'),
  endResize: (width) => ipcRenderer.invoke('panel:endResize', width),
  setPinned: (value) => ipcRenderer.invoke('panel:setPinned', value),
  hideAll: () => ipcRenderer.invoke('panel:hideAll'),

  pickImages: (remaining) => ipcRenderer.invoke('images:pick', remaining),
  saveImage: (buffer, ext) => ipcRenderer.invoke('images:save', { buffer, ext }),
  pruneImages: () => ipcRenderer.invoke('images:prune'),

  pickFiles: () => ipcRenderer.invoke('files:pick'),
  saveFile: (buffer, name) => ipcRenderer.invoke('files:save', { buffer, name }),
  openFile: (token) => ipcRenderer.invoke('files:open', token),
  revealFile: (token) => ipcRenderer.invoke('files:reveal', token),
  deleteFile: (token) => ipcRenderer.invoke('files:delete', token),
  missingFiles: (tokens) => ipcRenderer.invoke('files:missing', tokens),
  onFilesChanged: (cb) => ipcRenderer.on('files:changed', () => cb()),

  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
  quit: () => ipcRenderer.invoke('app:quit'),

  onPanelState: (cb) => ipcRenderer.on('panel:state', (_e, v) => cb(v)),
  onEdgeHover: (cb) => ipcRenderer.on('panel:edgeHover', (_e, v) => cb(v)),
  onPinChange: (cb) => ipcRenderer.on('panel:pin', (_e, v) => cb(v)),
  onSettingsChanged: (cb) => ipcRenderer.on('settings:changed', (_e, v) => cb(v)),
  onOpenSettings: (cb) => ipcRenderer.on('ui:open-settings', () => cb()),
  updateDock: (patch) => ipcRenderer.invoke('docks:update', patch),
  addDock: () => ipcRenderer.invoke('docks:add'),
  removeDock: (id) => ipcRenderer.invoke('docks:remove', id),

  trashList: () => ipcRenderer.invoke('trash:list'),
  trashAdd: (tab) => ipcRenderer.invoke('trash:add', tab),
  trashRestore: (tabId) => ipcRenderer.invoke('trash:restore', tabId),
  trashDelete: (tabId) => ipcRenderer.invoke('trash:delete', tabId),
  trashEmpty: () => ipcRenderer.invoke('trash:empty'),

  backupNow: () => ipcRenderer.invoke('backup:now'),
  backupList: () => ipcRenderer.invoke('backup:list'),
  openBackupFolder: () => ipcRenderer.invoke('backup:openFolder'),

  dataLocation: () => ipcRenderer.invoke('data:location'),
  setDataLocation: (useDefault) => ipcRenderer.invoke('data:setLocation', useDefault),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),

  exportMemo: (scope) => ipcRenderer.invoke('memo:export', { scope }),
  importMemos: () => ipcRenderer.invoke('memo:import'),

  search: (query) => ipcRenderer.invoke('search:all', query),
  openSearchHit: (hit) => ipcRenderer.invoke('search:open', hit),

  onDisplaysChanged: (cb) => ipcRenderer.on('displays:changed', (_e, v) => cb(v)),
  onReload: (cb) => ipcRenderer.on('state:reload', (_e, v) => cb(v || {})),
  onSelectTab: (cb) => ipcRenderer.on('ui:select-tab', (_e, v) => cb(v)),
  onDocksChanged: (cb) => ipcRenderer.on('docks:changed', (_e, v) => cb(v)),
  onNewTab: (cb) => ipcRenderer.on('ui:new-tab', () => cb()),
  onNextTab: (cb) => ipcRenderer.on('ui:next-tab', () => cb()),
});
