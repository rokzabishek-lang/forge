import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Group, Panel, Separator } from 'react-resizable-panels'
import { tinykeys } from 'tinykeys'
import { AlertCircle, Info, X } from 'lucide-react'
import { projectDuration } from '@shared/timeline'
import { AUTOSAVE_INTERVAL_MS } from '@shared/project/recovery'
import { useEditor } from './store'
import { LeftPanel } from './components/LeftPanel'
import { Preview } from './components/Preview'
import { Timeline } from './components/Timeline'
import { Transport } from './components/Transport'
import { Inspector } from './components/Inspector'
import { Toolbox } from './components/Toolbox'
import { Shortcuts } from './components/Shortcuts'
import { SourceBar } from './components/SourceBar'
import { CurvePanel } from './components/CurvePanel'

function Divider({ vertical = false }: { vertical?: boolean }): ReactNode {
  return (
    <Separator
      className={
        vertical
          ? 'h-px bg-ink-800 transition-colors hover:bg-flame-500 active:bg-flame-500'
          : 'w-px bg-ink-800 transition-colors hover:bg-flame-500 active:bg-flame-500'
      }
    />
  )
}

function Notices(): ReactNode {
  const notices = useEditor((s) => s.notices)
  const dismiss = useEditor((s) => s.dismissNotice)
  if (notices.length === 0) return null

  return (
    <div className="pointer-events-none absolute bottom-3 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-1.5">
      {notices.slice(-4).map((notice) => (
        <div
          key={notice.id}
          className={`pointer-events-auto flex max-w-lg items-start gap-2 rounded-md border px-3 py-2 text-[11.5px] shadow-lg ${
            notice.tone === 'error'
              ? 'border-red-900 bg-red-950/95 text-red-200'
              : 'border-ink-700 bg-ink-850/95 text-ink-200'
          }`}
        >
          {notice.tone === 'error' ? (
            <AlertCircle size={13} className="mt-px shrink-0" />
          ) : (
            <Info size={13} className="mt-px shrink-0" />
          )}
          <span className="flex-1 leading-snug">{notice.text}</span>
          <button onClick={() => dismiss(notice.id)} className="shrink-0 opacity-60 hover:opacity-100">
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function Header(): ReactNode {
  const project = useEditor((s) => s.project)
  const dirty = useEditor((s) => s.dirty)
  const projectPath = useEditor((s) => s.projectPath)
  const sidecarReady = useEditor((s) => s.sidecarReady)
  const sidecarError = useEditor((s) => s.sidecarError)

  return (
    <div className="drag-region flex h-9 shrink-0 items-center justify-center border-b border-ink-800 bg-ink-900">
      <span className="text-[11.5px] text-ink-400">
        <span className="font-medium text-ink-200">{project.name || 'Untitled'}</span>
        {dirty && <span className="ml-1 text-flame-500">•</span>}
        {projectPath && <span className="ml-2 text-ink-600">{projectPath}</span>}
      </span>
      <span
        className="no-drag absolute right-16 font-mono text-[9px] text-ink-700"
        title={`Build ${BUILD_STAMP} — if this timestamp is old, the running app is stale`}
      >
        {BUILD_STAMP.slice(11, 19)}
      </span>
      <span
        className="absolute right-3 flex items-center gap-1.5 text-[10px] text-ink-600"
        title={sidecarError ?? (sidecarReady ? 'AI sidecar running' : 'AI sidecar starting')}
      >
        <span
          className={`size-1.5 rounded-full ${
            sidecarError ? 'bg-red-500' : sidecarReady ? 'bg-emerald-500' : 'bg-ink-600'
          }`}
        />
        AI
      </span>
    </div>
  )
}

declare const __BUILD_STAMP__: string
/** Falls back when running outside the Vite build (tests, type-checking). */
const BUILD_STAMP = typeof __BUILD_STAMP__ === 'string' ? __BUILD_STAMP__ : 'dev'

export default function App(): ReactNode {
  const setJobs = useEditor((s) => s.setJobs)
  const notify = useEditor((s) => s.notify)
  const [shortcutsOpen, setShortcutsOpen] = useState(false)
  /** An autosave holding work the saved file does not, offered once at launch. */
  const [recovery, setRecovery] = useState<{ file: string; name: string; savedAt: number } | null>(
    null
  )

  useEffect(() => window.forge.onJobsChanged(setJobs), [setJobs])

  useEffect(
    () =>
      window.forge.onTranscribeProgress(({ assetId, progress, message }) =>
        useEditor.getState().setTranscribeProgress(assetId, progress, message)
      ),
    []
  )

  useEffect(
    () =>
      window.forge.onParallaxProgress(({ assetId, progress, message }) =>
        useEditor.getState().setBakeProgress(assetId, progress, message)
      ),
    []
  )

  useEffect(
    () =>
      window.forge.onSidecarStatus((status) => {
        const state = useEditor.getState()
        if (status.state === 'ready') state.setSidecar(true, null)
        else if (status.state === 'failed') state.setSidecar(false, status.error)
        else state.setSidecar(false, null)
      }),
    []
  )

  // The sidecar may already be up before the window finished loading, in which
  // case its status broadcast was missed.
  useEffect(() => {
    void window.forge
      .sidecarStatus()
      .then((status) => {
        const state = useEditor.getState()
        if (status.state === 'ready') state.setSidecar(true, null)
        else if (status.state === 'failed') state.setSidecar(false, status.error)
      })
      .catch(() => undefined)
  }, [])

  useEffect(() => {
    void window.forge.listJobs().then(setJobs).catch(() => undefined)
  }, [setJobs])

  // Saved export settings, read once at startup.
  useEffect(() => {
    void useEditor.getState().loadPresets()
  }, [])

  /*
   * Save, from wherever the request came from.
   *
   * One function so the hotkey, the menu, the header button and the close
   * guard cannot drift — and so the close guard gets a truthful answer about
   * whether the write happened. A cancelled Save dialog returns null, which is
   * "not saved", which is a reason to stay open rather than to close and hope.
   */
  const saveNow = useCallback(
    async (forceDialog = false): Promise<boolean> => {
      const { project, projectPath, decisions, markSaved } = useEditor.getState()
      try {
        const path = await window.forge.saveProject(project, projectPath, decisions, forceDialog)
        if (!path) return false
        markSaved(path)
        window.forge.rememberRecent(path)
        // The autosave has nothing left to offer once its work is in the file.
        if (project.id) void window.forge.clearAutosave(project.id).catch(() => undefined)
        return true
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err))
        return false
      }
    },
    [notify]
  )

  const openNow = useCallback(
    async (path?: string): Promise<void> => {
      try {
        const opened = await window.forge.openProject(path)
        if (!opened) return
        useEditor.getState().loadProject(opened.project, opened.path, opened.decisions)
        if (opened.path) window.forge.rememberRecent(opened.path)
      } catch (err) {
        notify(err instanceof Error ? err.message : String(err))
      }
    },
    [notify]
  )

  /*
   * Autosave, every minute, only while there is something to save.
   *
   * Written beside the project rather than over it: an autosave is a copy to
   * recover FROM, and overwriting the file the user has not chosen to save
   * would be the crash doing the saving. The clock is an interval rather than
   * a debounce on every edit — on a busy timeline a debounce never fires.
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const { project, projectPath, decisions, dirty } = useEditor.getState()
      if (!dirty) return
      void window.forge.autosaveProject(project, projectPath, decisions).catch(() => undefined)
    }, AUTOSAVE_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [])

  /*
   * What the menu needs to know, whenever it changes.
   *
   * Subscribed to the store rather than read on a timer: the items have to be
   * right the instant the menu is opened, and a menu that enables Undo a
   * second after you could have used it is worse than one that never does.
   */
  useEffect(() => {
    const report = (): void => {
      const s = useEditor.getState()
      window.forge.reportMenuState({
        canUndo: s.past.length > 0,
        canRedo: s.future.length > 0,
        hasSelection: s.selectedClipIds.length > 0,
        dirty: s.dirty
      })
    }
    report()
    return useEditor.subscribe(report)
  }, [])

  /** The menu is a remote control; the store is where the editor lives. */
  useEffect(() => {
    const offCommand = window.forge.onMenuCommand((command) => {
      const s = useEditor.getState()
      switch (command) {
        case 'new': s.newProject(); break
        case 'open': void openNow(); break
        // The close guard is waiting on this answer, so it is always sent.
        case 'save': void saveNow().then((ok) => window.forge.reportSaved(ok)); break
        case 'saveAs': void saveNow(true); break
        case 'export': s.requestExport(); break
        case 'undo': s.undo(); break
        case 'redo': s.redo(); break
        case 'cut': s.cutSelection(); break
        case 'copy': s.copySelection(); break
        case 'paste': void s.pasteClipboard(); break
        case 'duplicate': void s.duplicateSelection(); break
        case 'delete': s.deleteSelection(); break
        case 'selectAll': s.selectAll(); break
        case 'zoomIn': s.setZoom(s.zoom * 1.4); break
        case 'zoomOut': s.setZoom(s.zoom / 1.4); break
        case 'zoomFit': window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Z', shiftKey: true })); break
        case 'shortcuts': setShortcutsOpen(true); break
        default: break
      }
    })
    const offOpen = window.forge.onMenuOpen((path) => void openNow(path))
    return () => {
      offCommand()
      offOpen()
    }
  }, [openNow, saveNow])

  /*
   * Anything to recover, asked once at launch.
   *
   * Only autosaves NEWER than their saved file reach here — see
   * project/recovery.ts — so this prompt appears when something was actually
   * lost and stays quiet otherwise. A prompt that appears every launch is one
   * nobody reads.
   */
  useEffect(() => {
    void window.forge
      .recoveries()
      .then((found) => setRecovery(found[0] ?? null))
      .catch(() => undefined)
  }, [])

  // Keyboard is how an NLE is actually driven.
  useEffect(() => {
    const state = useEditor.getState
    return tinykeys(window, {
      Space: (e) => {
        e.preventDefault()
        state().setPlaying(!state().playing)
      },
      KeyS: () => state().splitAtPlayhead(),
      ArrowLeft: () => state().setPlayhead(state().playhead - 1),
      ArrowRight: () => state().setPlayhead(state().playhead + 1),
      '$mod+ArrowLeft': () => state().setPlayhead(state().playhead - state().project.settings.fps),
      '$mod+ArrowRight': () => state().setPlayhead(state().playhead + state().project.settings.fps),
      Home: () => state().setPlayhead(0),
      End: () => state().setPlayhead(projectDuration(state().project)),
      '$mod+z': (e) => {
        e.preventDefault()
        state().undo()
      },
      '$mod+Shift+z': (e) => {
        e.preventDefault()
        state().redo()
      },
      /*
       * Delete leaves the gap; SHIFT-Delete closes it.
       *
       * Premiere's split, and the right way round for this app: everything the
       * automations place sits on a beat, so rippling by default would drag the
       * rest of a reel off the music. Rippling is the deliberate gesture.
       */
      Delete: () => state().deleteSelection(),
      Backspace: () => state().deleteSelection(),
      'Shift+Delete': () => state().rippleDeleteSelection(),
      'Shift+Backspace': () => state().rippleDeleteSelection(),

      // I and O: Premiere's, Resolve's, and every NLE's since.
      i: () => state().setRangeIn(state().playhead),
      o: () => state().setRangeOut(state().playhead),
      'Alt+x': () => state().clearRange(),

      '$mod+a': (e) => {
        e.preventDefault()
        state().selectAll()
      },
      '$mod+c': () => state().copySelection(),
      '$mod+x': () => state().cutSelection(),
      '$mod+v': () => void state().pasteClipboard(),
      '$mod+d': (e) => {
        e.preventDefault()
        void state().duplicateSelection()
      },

      /*
       * Nudge on ALT-arrow, not on the bare arrows.
       *
       * FIX.md asked for the bare arrows, and they were already taken: they
       * step the PLAYHEAD one frame, which is the more fundamental gesture and
       * has been there since the beginning. Alt-arrow is what Premiere nudges
       * with, so this is the convention rather than a compromise. One frame,
       * ten with shift, the whole selection, one undo entry.
       */
      'Alt+ArrowLeft': (e) => {
        e.preventDefault()
        state().nudgeSelection(-1)
      },
      'Alt+ArrowRight': (e) => {
        e.preventDefault()
        state().nudgeSelection(1)
      },
      'Alt+Shift+ArrowLeft': (e) => {
        e.preventDefault()
        state().nudgeSelection(-10)
      },
      'Alt+Shift+ArrowRight': (e) => {
        e.preventDefault()
        state().nudgeSelection(10)
      },
      // Save and Open go through the same functions the menu uses, so the
      // hotkey and the menu item cannot drift apart.
      '$mod+s': (e) => {
        e.preventDefault()
        void saveNow()
      },
      '$mod+Shift+s': (e) => {
        e.preventDefault()
        void saveNow(true)
      },
      '$mod+o': (e) => {
        e.preventDefault()
        void openNow()
      },
      '$mod+/': (e) => {
        e.preventDefault()
        setShortcutsOpen(true)
      }
    })
  }, [notify, saveNow, openNow])

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-ink-950 text-ink-200">
      {/*
        Work the app saved for you while you were not looking.
        
        Shown only when an autosave is genuinely newer than its file — which
        means something was lost — and dismissed for good either way, so a
        prompt that appeared once does not appear again at the next launch.
      */}
      {recovery && (
        <div className="flex items-center gap-3 border-b border-flame-500/40 bg-flame-500/10 px-4 py-2 text-[12px]">
          <span className="text-ink-200">
            Forge has unsaved work from <strong>{recovery.name}</strong>, autosaved{' '}
            {new Date(recovery.savedAt).toLocaleString()}.
          </span>
          <button
            onClick={() => {
              const file = recovery.file
              setRecovery(null)
              void window.forge
                .recoverProject(file)
                .then((opened) => {
                  if (opened) {
                    useEditor.getState().loadProject(opened.project, opened.path, opened.decisions)
                  }
                })
                .catch((err: unknown) =>
                  notify(err instanceof Error ? err.message : String(err))
                )
            }}
            className="rounded bg-flame-500 px-2 py-1 font-medium text-ink-950 hover:bg-flame-400"
          >
            Recover
          </button>
          <button
            onClick={() => setRecovery(null)}
            className="rounded px-2 py-1 text-ink-400 hover:bg-ink-800 hover:text-ink-200"
          >
            Discard
          </button>
        </div>
      )}

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}

      <Header />

      <SourceBar />

      <Group orientation="vertical" className="flex-1">
        <Panel defaultSize="62" minSize="30">
          <Group orientation="horizontal">
            <Panel defaultSize="22" minSize="14" maxSize="40">
              <LeftPanel />
            </Panel>
            <Divider />
            <Panel defaultSize="60" minSize="30">
              {/* The tool strip belongs to the picture, so it travels with it. */}
              <div className="flex h-full">
                <Toolbox />
                <div className="min-w-0 flex-1">
                  <Preview />
                </div>
              </div>
            </Panel>
            <Divider />
            <Panel defaultSize="21" minSize="15" maxSize="34">
              <Inspector />
            </Panel>
          </Group>
        </Panel>

        <Divider vertical />

        <Panel defaultSize="38" minSize="18">
          {/*
            The curve sits beside the timeline, on the same horizontal axis, so
            the shape of a move and the clip it belongs to line up.
          */}
          <Group orientation="horizontal">
            <Panel defaultSize="72" minSize="40">
              <div className="flex h-full flex-col">
                <Transport />
                <div className="min-h-0 flex-1">
                  <Timeline />
                </div>
              </div>
            </Panel>
            <Divider />
            <Panel defaultSize="28" minSize="16" maxSize="45">
              <CurvePanel />
            </Panel>
          </Group>
        </Panel>
      </Group>

      <Notices />
    </div>
  )
}
