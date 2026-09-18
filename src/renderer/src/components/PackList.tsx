import { useEffect, type ReactNode } from 'react'
import { Download, Loader2, RefreshCw, Trash2, X } from 'lucide-react'
import { packButton, type PackListing } from '@shared/assets/pack'
import { usePacks } from '../packs'

/**
 * The asset packs, as a list of buttons.
 *
 * The app works with none of them — eight built-in transitions, system fonts,
 * an empty catalog that scans cleanly — so nothing here is a prerequisite and
 * nothing here is allowed to look like one. It is an offer, in the one place
 * somebody would go looking: the Library, which is where the absence shows.
 *
 * What each button SAYS is decided by `packButton` in shared, and tested there.
 * This draws it.
 */
export function PackList(): ReactNode {
  const packs = usePacks((s) => s.packs)
  const loaded = usePacks((s) => s.loaded)
  const loading = usePacks((s) => s.loading)
  const error = usePacks((s) => s.error)
  const inFlight = usePacks((s) => s.inFlight)
  const failed = usePacks((s) => s.failed)
  const load = usePacks((s) => s.load)
  const watch = usePacks((s) => s.watch)

  useEffect(() => {
    if (!loaded && !loading) void load()
  }, [loaded, loading, load])

  useEffect(() => watch(), [watch])

  const anyPublished = packs.some((pack) => pack.state.kind !== 'unpublished')

  return (
    <div className="flex flex-col gap-2 p-2">
      <div className="flex items-center gap-1.5 px-0.5">
        <span className="flex-1 text-[10.5px] uppercase tracking-wide text-ink-600">
          Asset packs
        </span>
        <button
          onClick={() => void load(true)}
          title="Check for newer packs"
          className="rounded p-0.5 text-ink-600 hover:bg-ink-800 hover:text-ink-200"
        >
          <RefreshCw size={11} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>

      {error && (
        <p className="px-0.5 text-[10.5px] leading-relaxed text-amber-400">
          Could not check for packs — {error}
        </p>
      )}

      {loaded && packs.length === 0 && !error && (
        <p className="px-0.5 text-[10.5px] leading-relaxed text-ink-600">
          This build knows about no packs.
        </p>
      )}

      {packs.map((pack) => (
        <PackRow
          key={pack.id}
          pack={pack}
          inFlight={inFlight.get(pack.id) ?? null}
          error={failed.get(pack.id) ?? null}
        />
      ))}

      {loaded && packs.length > 0 && !anyPublished && (
        /*
         * Said once, under the list, rather than on each disabled button.
         *
         * Every pack being unreleased is a fact about the project, not about
         * the packs — and a person reading four greyed buttons with no
         * explanation reasonably concludes the feature is broken.
         */
        <p className="px-0.5 text-[10.5px] leading-relaxed text-ink-600">
          None have been released yet. Everything in the editor works without
          them — they add fonts, transitions, titles and stickers to choose from.
        </p>
      )}
    </div>
  )
}

function PackRow({
  pack,
  inFlight,
  error
}: {
  pack: PackListing
  inFlight: { progress: number | null; message: string } | null
  error: string | null
}): ReactNode {
  const install = usePacks((s) => s.install)
  const cancel = usePacks((s) => s.cancel)
  const remove = usePacks((s) => s.remove)

  const button = packButton(pack, pack.state, inFlight, error)

  const press = (): void => {
    if (button.action === 'install') void install(pack.id)
    else if (button.action === 'cancel') void cancel(pack.id)
    else if (button.action === 'remove') void remove(pack.id)
  }

  const Icon =
    button.action === 'cancel'
      ? X
      : button.action === 'remove'
        ? Trash2
        : button.action === 'install'
          ? Download
          : null

  return (
    <div className="rounded-md border border-ink-700 bg-ink-850 p-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11.5px] text-ink-200">{pack.name}</div>
          {/*
            A summary is clamped; a failure is not. Two lines is plenty for
            "88 fonts, 412 transitions…", but the reason a download failed is
            the one line here somebody actually has to read, and "did not match
            its…" tells them nothing they can act on.
          */}
          <div
            title={button.detail}
            className={`mt-0.5 text-[10px] leading-snug ${
              error ? 'text-red-400' : 'line-clamp-2 text-ink-400'
            }`}
          >
            {button.detail}
          </div>
        </div>

        <button
          onClick={press}
          disabled={button.action === null}
          className={`flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[10.5px] transition-colors ${
            button.action === null
              ? 'cursor-default bg-ink-800 text-ink-600'
              : button.action === 'remove'
                ? 'bg-ink-800 text-ink-400 hover:bg-ink-700 hover:text-ink-200'
                : 'bg-flame-500 font-medium text-ink-950 hover:bg-flame-400'
          }`}
        >
          {button.busy ? (
            <Loader2 size={10} className="animate-spin" />
          ) : (
            Icon && <Icon size={10} />
          )}
          {button.label}
        </button>
      </div>

      {button.busy && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-ink-800">
          {/*
            An indeterminate stage gets a moving stripe, not a bar at zero.
            Checksumming and unpacking an 81MB pack takes real seconds, and a bar
            frozen at the left during them reads as the app having hung — which
            is the exact moment somebody force-quits it.
          */}
          {button.progress === null ? (
            <div className="h-full w-1/3 animate-pulse rounded-full bg-flame-500/70" />
          ) : (
            <div
              className="h-full rounded-full bg-flame-500 transition-[width] duration-200"
              style={{ width: `${Math.round(button.progress * 100)}%` }}
            />
          )}
        </div>
      )}
    </div>
  )
}
