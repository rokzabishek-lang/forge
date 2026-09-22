import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Loader2, Settings2, Sparkles } from 'lucide-react'
import { COPY_RULE, SPINE_RULE } from '@shared/director/apply'
import { buildSlots } from '@shared/director/menu'
import { isLoopback, type LlmProviderChoice, type LlmStatus } from '@shared/director/provider'
import { TONES } from '@shared/director/schema'
import { framesToSeconds } from '@shared/timeline'
import { useEditor } from '../store'

/**
 * The director's panel: a brief in, an ad out.
 *
 * Sits at the top of the Auto tab because ads and product demos are what the
 * product is for (docs/LLM.md). The user places the pictures — the slot list
 * is the media pool in order, each with a line of what it shows — types what
 * the product is, and presses Direct. Everything the director makes is an
 * ordinary clip with a reason on it, and Clear takes exactly its own work
 * away again, music trim included.
 *
 * The provider settings live behind a disclosure here rather than in a
 * separate settings screen, because there is no settings screen — the voice
 * key has lived in the settings file with no UI at all. A key typed here is
 * sent once and never read back; the field shows only that there is one.
 */

const input =
  'min-w-0 flex-1 rounded border border-ink-800 bg-ink-950 px-1.5 py-1 text-[11px] text-ink-200 placeholder:text-ink-700 focus:border-flame-500 focus:outline-none'
const small = 'rounded bg-ink-800 px-2 py-1 text-[10.5px] text-ink-400 hover:bg-ink-700 hover:text-ink-200 disabled:opacity-40'

function Field({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <label className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10.5px] text-ink-400">{label}</span>
      {children}
    </label>
  )
}

export function Director(): ReactNode {
  /** The six refinements, closed until someone wants them. */
  const [moreOpen, setMoreOpen] = useState(false)
  const project = useEditor((s) => s.project)
  const brief = useEditor((s) => s.directBrief)
  const setBrief = useEditor((s) => s.setDirectBrief)
  const slotNotes = useEditor((s) => s.slotNotes)
  const setSlotNote = useEditor((s) => s.setSlotNote)
  const directing = useEditor((s) => s.directing)
  const stage = useEditor((s) => s.directStage)
  const direct = useEditor((s) => s.direct)
  const clear = useEditor((s) => s.clearDirectorOutput)
  const last = useEditor((s) => s.lastDirection)
  const status = useEditor((s) => s.directorStatus)
  const config = useEditor((s) => s.directorConfig)
  const refresh = useEditor((s) => s.refreshDirector)
  const setProvider = useEditor((s) => s.setDirectorProvider)

  const [showSettings, setShowSettings] = useState(false)
  const [showNotes, setShowNotes] = useState(false)
  const [showSlots, setShowSlots] = useState(true)
  const [key, setKey] = useState('')

  useEffect(() => {
    void refresh()
  }, [refresh])

  const slots = buildSlots(project, slotNotes)
  const made = project.clips.filter(
    (c) => c.generatedBy?.rule === SPINE_RULE || c.generatedBy?.rule === COPY_RULE
  ).length

  const fps = project.settings.fps
  const musicClip = project.clips.find((clip) => {
    const track = project.tracks.find((t) => t.id === clip.trackId)
    const asset = project.assets.find((a) => a.id === clip.assetId)
    return track?.kind === 'audio' && asset?.hasAudio
  })
  const musicSeconds = musicClip
    ? framesToSeconds(musicClip.directorTrim?.duration ?? musicClip.duration, fps)
    : null
  const defaultSeconds = Math.min(30, musicSeconds ?? 30)

  /* Which provider would answer, and what it would say if asked now. */
  const chosen: LlmStatus | undefined = (() => {
    if (!status) return undefined
    if (config && config.provider !== 'auto') return status.find((p) => p.id === config.provider)
    return status.find((p) => p.ready && p.kind === 'local') ?? status.find((p) => p.ready) ?? status[0]
  })()
  const modelName =
    chosen?.id === 'ollama' ? config?.ollama.model : chosen?.id === 'openai' ? config?.openai.model : ''
  const canDirect = !directing && brief.product.trim().length > 0 && slots.length > 0

  /*
   * How many refinements are filled in, for the collapsed header.
   *
   * Without it, a brief carefully written and then collapsed looks like an
   * empty brief — and someone would fill it in twice.
   */
  const filledExtras = [
    brief.benefit,
    brief.audience,
    brief.cta,
    brief.language
  ].filter((v) => v.trim().length > 0).length + (brief.seconds === null ? 0 : 1)

  const ollama = status?.find((p) => p.id === 'ollama')
  const openai = status?.find((p) => p.id === 'openai')
  const openaiLocal = config ? isLoopback(config.openai.baseUrl) : true

  const modelPicker = (
    id: 'ollama' | 'openai',
    models: string[] | undefined,
    current: string
  ): ReactNode => {
    const options = models && models.length > 0 ? models : []
    if (options.length === 0) {
      return (
        <input
          className={input}
          value={current}
          placeholder="model name"
          onChange={(e) =>
            void setProvider({ [id]: { model: e.target.value } } as Parameters<typeof setProvider>[0])
          }
        />
      )
    }
    return (
      <select
        className={input}
        value={options.includes(current) ? current : ''}
        onChange={(e) =>
          void setProvider({ [id]: { model: e.target.value } } as Parameters<typeof setProvider>[0])
        }
      >
        <option value="">choose a model…</option>
        {options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    )
  }

  return (
    <section className="space-y-2 border-b border-ink-800 p-3">
      <div className="flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11.5px] text-ink-200">
          <Sparkles size={12} className="text-flame-400" />
          Director
        </span>
        <span className="text-[10px] text-ink-600">
          {slots.length} slot{slots.length === 1 ? '' : 's'}
        </span>
      </div>

      <p className="text-[10.5px] leading-snug text-ink-600">
        An ad from your pictures, your music and a line about the product. The model chooses
        the beats and writes the words; you place the pictures.
      </p>

      <Field label="Product">
        <input
          className={input}
          value={brief.product}
          placeholder="what is it? (required)"
          onChange={(e) => setBrief({ product: e.target.value })}
        />
      </Field>
      {/*
        Everything except Product, folded away.
        
        Product is the only required field and Direct is the only button that
        matters; the other six are refinements, and six empty boxes above the
        button read as six things you have to fill in before anything will
        happen. Closed by default, and it says how many are in there so it does
        not look like the panel is missing something.
      */}
      <button
        onClick={() => setMoreOpen((v) => !v)}
        className="mb-1 flex w-full items-center justify-between rounded px-1 py-1 text-[10px] uppercase tracking-wide text-ink-500 transition-colors hover:bg-ink-850 hover:text-ink-300"
      >
        <span>More {filledExtras > 0 && `· ${filledExtras} set`}</span>
        <ChevronDown
          size={12}
          className={`transition-transform ${moreOpen ? 'rotate-180' : ''}`}
        />
      </button>

      {moreOpen && (
        <>
      <Field label="Benefit">
        <input
          className={input}
          value={brief.benefit}
          placeholder="what it does for them"
          onChange={(e) => setBrief({ benefit: e.target.value })}
        />
      </Field>
      <Field label="Audience">
        <input
          className={input}
          value={brief.audience}
          placeholder="who it is for"
          onChange={(e) => setBrief({ audience: e.target.value })}
        />
      </Field>
      <Field label="Tone">
        <select
          className={input}
          value={brief.tone}
          onChange={(e) => setBrief({ tone: e.target.value as (typeof TONES)[number] })}
        >
          {TONES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </Field>
      <Field label="Call to action">
        <input
          className={input}
          value={brief.cta}
          placeholder="Shop now"
          onChange={(e) => setBrief({ cta: e.target.value })}
        />
      </Field>
      <Field label="Length">
        <input
          className={input}
          type="number"
          min={6}
          max={90}
          step={1}
          value={brief.seconds ?? ''}
          placeholder={`${defaultSeconds.toFixed(0)} s${musicSeconds !== null ? ' (from the music)' : ''}`}
          onChange={(e) =>
            setBrief({ seconds: e.target.value === '' ? null : Math.max(6, Math.min(90, Number(e.target.value))) })
          }
        />
      </Field>
      <Field label="Language">
        <input
          className={input}
          value={brief.language}
          placeholder="English"
          onChange={(e) => setBrief({ language: e.target.value })}
        />
      </Field>
        </>
      )}

      {/* The slots: the media pool in order, with a line about each. */}
      <button
        onClick={() => setShowSlots((v) => !v)}
        className="flex w-full items-center gap-1 text-[10.5px] uppercase tracking-wide text-ink-600 hover:text-ink-400"
      >
        {showSlots ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        Your pictures, in order
      </button>
      {showSlots &&
        (slots.length === 0 ? (
          <div className="text-[10.5px] text-ink-600">Import pictures or clips — they appear here in pool order.</div>
        ) : (
          <div className="space-y-1">
            {slots.map((slot) => (
              <div key={slot.id} className="flex items-center gap-2">
                <span className="w-16 shrink-0 truncate text-[10px] text-ink-500" title={slot.label}>
                  {slot.kind === 'video' ? `▶ ${slot.seconds?.toFixed(1)}s` : '▦'} {slot.label}
                </span>
                <input
                  className={input}
                  value={slotNotes[slot.assetId] ?? ''}
                  placeholder="what is in it?"
                  onChange={(e) => setSlotNote(slot.assetId, e.target.value)}
                />
              </div>
            ))}
          </div>
        ))}

      {/* Who answers. */}
      <div className="flex items-center justify-between gap-2 rounded bg-ink-950/60 px-2 py-1.5">
        <span className="min-w-0 truncate text-[10.5px] text-ink-400">
          {!status ? (
            'looking for a model…'
          ) : chosen?.ready ? (
            <>
              <span className="text-emerald-400">●</span> {chosen.label}
              {modelName ? ` · ${modelName}` : ''}
            </>
          ) : (
            <>
              <span className="text-flame-400">●</span> {chosen?.reason ?? 'no model available'}
            </>
          )}
        </span>
        <button onClick={() => setShowSettings((v) => !v)} className={small} title="Model settings">
          <Settings2 size={11} />
        </button>
      </div>

      {showSettings && config && (
        <div className="space-y-1.5 rounded border border-ink-800 p-2">
          <div className="flex gap-1">
            {(['auto', 'ollama', 'openai'] as LlmProviderChoice[]).map((p) => (
              <button
                key={p}
                onClick={() => void setProvider({ provider: p })}
                className={`flex-1 rounded px-1.5 py-1 text-[10.5px] ${
                  config.provider === p ? 'bg-flame-500 text-ink-950' : 'bg-ink-800 text-ink-400 hover:bg-ink-700'
                }`}
              >
                {p === 'auto' ? 'Auto' : p === 'ollama' ? 'Ollama' : openaiLocal ? 'LM Studio' : 'Hosted'}
              </button>
            ))}
          </div>

          <div className="text-[10px] uppercase tracking-wide text-ink-600">Ollama</div>
          <Field label="Server">
            <input
              className={input}
              value={config.ollama.baseUrl}
              onChange={(e) => void setProvider({ ollama: { baseUrl: e.target.value } })}
            />
          </Field>
          <Field label="Model">{modelPicker('ollama', ollama?.models, config.ollama.model)}</Field>
          {ollama && !ollama.ready && <div className="text-[10px] text-ink-500">{ollama.reason}</div>}

          <div className="pt-1 text-[10px] uppercase tracking-wide text-ink-600">
            OpenAI-shaped server — LM Studio, llama.cpp, or a hosted API
          </div>
          <Field label="Server">
            <input
              className={input}
              value={config.openai.baseUrl}
              placeholder="http://127.0.0.1:1234/v1"
              onChange={(e) => void setProvider({ openai: { baseUrl: e.target.value } })}
            />
          </Field>
          <Field label="Model">{modelPicker('openai', openai?.models, config.openai.model)}</Field>
          <Field label="Key">
            <input
              className={input}
              type="password"
              value={key}
              placeholder={config.openai.hasKey ? '•••••••• (saved)' : openaiLocal ? 'not needed locally' : 'paste your key'}
              onChange={(e) => setKey(e.target.value)}
            />
            <button
              className={small}
              disabled={key.trim().length === 0}
              onClick={() => {
                void setProvider({ openai: { apiKey: key.trim() } })
                setKey('')
              }}
            >
              Save
            </button>
            {config.openai.hasKey && (
              <button className={small} onClick={() => void setProvider({ openai: { apiKey: '' } })}>
                Clear
              </button>
            )}
          </Field>
          {openai && !openai.ready && <div className="text-[10px] text-ink-500">{openai.reason}</div>}
          <button onClick={() => void refresh()} className={small}>
            Check again
          </button>
        </div>
      )}

      <div className="flex gap-1">
        <button
          onClick={() => void direct()}
          disabled={!canDirect}
          className="flex flex-1 items-center justify-center gap-1.5 rounded bg-flame-500 px-2 py-1.5 text-[11px] font-medium text-ink-950 hover:bg-flame-400 disabled:opacity-40"
        >
          {directing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
          {directing ? stage ?? 'Working' : made > 0 ? 'Direct again' : 'Direct'}
        </button>
        {!directing && made > 0 && (
          <button onClick={clear} className={small}>
            Clear
          </button>
        )}
      </div>

      {last && (
        <div className="space-y-1 rounded bg-ink-950/60 px-2 py-1.5">
          <div className="text-[10.5px] text-ink-300">
            {last.baseline ? 'Standard cut' : `Directed by ${last.model}`}
          </div>
          {last.reasoning && <div className="text-[10.5px] italic leading-snug text-ink-500">{last.reasoning}</div>}
          {last.problems.length > 0 && (
            <>
              <button
                onClick={() => setShowNotes((v) => !v)}
                className="flex items-center gap-1 text-[10px] text-ink-500 hover:text-ink-300"
              >
                {showNotes ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                {last.problems.length} note{last.problems.length === 1 ? '' : 's'}
              </button>
              {showNotes && (
                <ul className="space-y-0.5">
                  {last.problems.map((p, i) => (
                    <li key={i} className="text-[10px] leading-snug text-ink-500">
                      {p}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}

      {made > 0 && !directing && (
        <div className="text-[10.5px] text-emerald-400">
          {made} clips placed. They are ordinary clips — move, trim or delete any of them.
        </div>
      )}
    </section>
  )
}
