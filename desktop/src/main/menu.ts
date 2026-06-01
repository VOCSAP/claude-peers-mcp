// Custom application menu. The Electron default Edit menu (Undo / Redo / Cut /
// Copy / Paste / Select All) is misleading in a terminal app -- "Undo" reads as
// if it would undo the last prompt sent to a peer terminal. We keep only the
// clipboard ops that genuinely apply to an xterm selection (Copy / Paste) and a
// minimal View / Window, with DevTools exposed in development only.

import { app, Menu, type MenuItemConstructorOptions } from 'electron'

export function buildAppMenu(): Menu {
  const isMac = process.platform === 'darwin'
  const isDev = !app.isPackaged

  const template: MenuItemConstructorOptions[] = []

  if (isMac) {
    template.push({
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    })
  }

  template.push({
    label: 'File',
    submenu: [isMac ? { role: 'close' } : { role: 'quit' }]
  })

  // Deliberately minimal: no Undo/Redo/Cut/Select All (confusing for terminals).
  template.push({
    label: 'Edit',
    submenu: [
      { role: 'copy' },
      { role: 'paste' }
    ]
  })

  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      ...(isDev ? [{ role: 'toggleDevTools' } as MenuItemConstructorOptions] : []),
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' }
    ]
  })

  template.push({
    label: 'Window',
    submenu: [{ role: 'minimize' }, isMac ? { role: 'close' } : { role: 'close' }]
  })

  return Menu.buildFromTemplate(template)
}
