import { app, Menu, shell, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'

/**
 * The application menu.
 *
 * There was none — not a stub, not a default: no `Menu` anywhere in the main
 * process, so on Windows the app had no menu bar at all and on macOS it had
 * Electron's placeholder. Save and Open were bare hotkeys in the renderer, so
 * the only way to learn that either existed was to be told.
 *
 * A menu is the cheapest documentation an app has. Every item here already
 * worked; what was missing was any way to find it.
 *
 * **Everything routes through one channel.** Items send `menu:command` with a
 * name and the renderer dispatches to the store, rather than each item reaching
 * into the main process for a different piece of the editor. The renderer is
 * where the project lives; the menu is a remote control, and a remote control
 * with its own copy of the state is a remote control that disagrees with the
 * screen.
 */

export type MenuCommand =
  | 'new'
  | 'open'
  | 'save'
  | 'saveAs'
  | 'export'
  | 'undo'
  | 'redo'
  | 'cut'
  | 'copy'
  | 'paste'
  | 'duplicate'
  | 'delete'
  | 'selectAll'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomFit'
  | 'shortcuts'
  /** Not a menu item: the close guard sends it to keep a take in progress. */
  | 'stopRecording'

/** What the renderer tells us, so items can enable and disable correctly. */
export interface MenuState {
  canUndo: boolean
  canRedo: boolean
  hasSelection: boolean
  dirty: boolean
  /** A voice-over is counting in, recording, or being saved. */
  recording: boolean
}

export const EMPTY_MENU_STATE: MenuState = {
  canUndo: false,
  canRedo: false,
  hasSelection: false,
  dirty: false,
  recording: false
}

/**
 * Whether closing the window has to ask anything first.
 *
 * Unsaved changes, and a take in progress. The guard used to ask only about
 * the first, so closing the window — or Cmd+Q — mid-take tore the renderer
 * down with the microphone open and the take went with it: never saved, never
 * placed, not even a file in the voice-over folder. And a take in progress is
 * the one time the project is often NOT dirty yet, because the take lands on
 * the timeline only when it stops. Found by the B1 review.
 *
 * The take is asked about FIRST, because stopping it is what makes the project
 * dirty; asked the other way round, "Save" would save an edit without the take.
 */
export function mustAskBeforeClosing(state: MenuState): boolean {
  return state.recording || state.dirty
}

export function buildMenu(
  window: BrowserWindow | null,
  state: MenuState,
  recents: string[] = []
): Menu {
  const send = (command: MenuCommand) => (): void => {
    window?.webContents.send('menu:command', command)
  }

  const isMac = process.platform === 'darwin'

  /*
   * Recent projects, from our own list rather than the OS's.
   *
   * macOS has a native recent-documents menu and Windows has a jump list;
   * neither is readable back as a list to build a submenu from, so the app
   * keeps its own. `app.addRecentDocument` is still called on save and open, so
   * the OS lists work too.
   */
  const recentItems: MenuItemConstructorOptions[] =
    recents.length === 0
      ? [{ label: 'Nothing yet', enabled: false }]
      : recents.slice(0, 10).map((path) => ({
          label: path.split(/[\\/]/).pop() ?? path,
          toolTip: path,
          click: () => window?.webContents.send('menu:open', path)
        }))

  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: app.getName(),
            submenu: [
              { role: 'about' },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Project…', accelerator: 'CmdOrCtrl+N', click: send('new') },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Open Recent', submenu: recentItems },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { type: 'separator' },
        { label: 'Export…', accelerator: 'CmdOrCtrl+E', click: send('export') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        {
          label: 'Undo',
          accelerator: 'CmdOrCtrl+Z',
          enabled: state.canUndo,
          click: send('undo')
        },
        {
          label: 'Redo',
          accelerator: 'CmdOrCtrl+Shift+Z',
          enabled: state.canRedo,
          click: send('redo')
        },
        { type: 'separator' },
        /*
         * Not `role: 'cut'` and friends.
         *
         * The roles operate on the focused text field, which is right for a
         * text field and wrong for a timeline: pressing Copy with a clip
         * selected has to copy the CLIP. The store decides which is meant,
         * because only the store knows what is selected.
         */
        {
          label: 'Cut',
          accelerator: 'CmdOrCtrl+X',
          enabled: state.hasSelection,
          click: send('cut')
        },
        {
          label: 'Copy',
          accelerator: 'CmdOrCtrl+C',
          enabled: state.hasSelection,
          click: send('copy')
        },
        { label: 'Paste', accelerator: 'CmdOrCtrl+V', click: send('paste') },
        {
          label: 'Duplicate',
          accelerator: 'CmdOrCtrl+D',
          enabled: state.hasSelection,
          click: send('duplicate')
        },
        {
          label: 'Delete',
          accelerator: 'Delete',
          enabled: state.hasSelection,
          click: send('delete')
        },
        { type: 'separator' },
        { label: 'Select All', accelerator: 'CmdOrCtrl+A', click: send('selectAll') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { label: 'Zoom to Fit', accelerator: 'Shift+Z', click: send('zoomFit') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        // Kept because this app's hardest bugs are in the renderer and the
        // console is where they are read.
        { role: 'toggleDevTools' }
      ]
    },
    {
      label: 'Help',
      submenu: [
        { label: 'Keyboard Shortcuts', accelerator: 'CmdOrCtrl+/', click: send('shortcuts') },
        {
          label: 'Report an Issue',
          click: () => void shell.openExternal('https://github.com/rokzabishek-lang/forge/issues')
        }
      ]
    }
  ]

  return Menu.buildFromTemplate(template)
}

export function applyMenu(
  window: BrowserWindow | null,
  state: MenuState,
  recents: string[] = []
): void {
  Menu.setApplicationMenu(buildMenu(window, state, recents))
}
