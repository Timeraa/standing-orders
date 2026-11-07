// Surface module: the small animated regions of the band and the pane. Pure
// drawing from props (no `$`), so a frame redraws only its own few cells and
// never the pane or the atoms. A timer runs only while something moves: the
// spinner while it is mounted, a bar for ~300 ms after its value changed, a
// flash for ~900 ms after it appeared. At rest nothing ticks.
import type { ClientSurface } from 'claude-code'

type Spinner = { kind: 'spinner'; label?: string; color?: string; ascii?: boolean }
type Bar = { kind: 'bar'; name: string; percent: number; color: string; width: number; text: string; ascii?: boolean }
type Flash = { kind: 'flash'; head: string; body: string; dim?: boolean }
type Props = Spinner | Bar | Flash

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const ASCII = ['|', '/', '-', '\\']
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉']
const FRAME_MS = 80
const EASE_MS = 300
const FLASH_MS = 900

/** `width` cells for `percent`: full blocks, one eighth-block edge, then the empty track. */
export function barCells(percent: number, width: number, ascii = false) {
  const w = Math.max(1, Math.floor(width))
  const p = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0))
  if (ascii) {
    const on = Math.round((p / 100) * w)
    return '#'.repeat(on) + '-'.repeat(w - on)
  }
  const eighths = Math.round((p / 100) * w * 8)
  const full = Math.floor(eighths / 8)
  const edge = EIGHTHS[eighths % 8] ?? ''
  return '█'.repeat(full) + edge + '░'.repeat(Math.max(0, w - full - (edge ? 1 : 0)))
}

/** The bright 3-char window of a shimmering label at `frame`, as [start, end). It slides in, across and out. */
export function shimmerWindow(length: number, frame: number): [number, number] {
  if (length <= 0) return [0, 0]
  const end = frame % (length + 3)
  return [Math.max(0, end - 3), Math.min(length, end)]
}

/** Ease-out from `from` to `to` after `elapsed` of `EASE_MS`. */
export function ease(from: number, to: number, elapsed: number) {
  const t = Math.min(1, Math.max(0, elapsed / EASE_MS))
  return from + (to - from) * (1 - (1 - t) * (1 - t))
}

type State = { n: number; shown: number; from: number; to: number; t0: number; stop?: () => void; off?: boolean }
const blank = (t0: number): State => ({ n: 0, shown: 0, from: 0, to: 0, t0 })

export default function Motion(props: Props, surface: ClientSurface<State>) {
  const { Box, Text } = surface.elements
  const s = surface.state

  if (props.kind === 'spinner') {
    if (!s) {
      let n = 0
      // ponytail: runs while mounted; the parent ending its render unmounts it, which ends the timer.
      surface.every(FRAME_MS, () => surface.setState({ ...blank(0), n: ++n }))
    }
    const n = s?.n ?? 0
    const frames = props.ascii ? ASCII : BRAILLE
    const text = props.label ?? ''
    const [a, b] = shimmerWindow(text.length, n)
    return (
      <Box>
        <Text color={props.color}>{frames[n % frames.length]}</Text>
        {text ? (
          <Text dimColor> {text.slice(0, a)}<Text bold dimColor={false}>{text.slice(a, b)}</Text>{text.slice(b)}</Text>
        ) : null}
      </Box>
    )
  }

  if (props.kind === 'bar') {
    const target = Math.min(100, Math.max(0, props.percent))
    let shown = s ? s.shown : target
    if (!s) {
      surface.setState({ ...blank(0), shown: target, from: target, to: target })
    } else if (s.to !== target) {
      // A new value: ease from what is on screen. The timer stops itself on arrival.
      s.stop?.()
      const from = s.shown
      const stop = surface.every(FRAME_MS, () => {
        const cur = surface.state
        if (!cur) return
        const elapsed = Date.now() - cur.t0
        const arrived = elapsed >= EASE_MS
        if (arrived) cur.stop?.()
        surface.setState({ ...cur, shown: arrived ? cur.to : ease(cur.from, cur.to, elapsed), stop: arrived ? undefined : cur.stop })
      })
      surface.setState({ ...blank(Date.now()), shown: from, from, to: target, stop })
      shown = from
    }
    return (
      <Box>
        <Text dimColor>{props.name} {props.ascii ? '[' : '▕'}</Text>
        {/* the empty track is dim, so only the fill reads as the value */}
        <Text color={props.color}>{barCells(shown, props.width, props.ascii).replace(/[░-]+$/, '')}</Text>
        <Text dimColor>{(barCells(shown, props.width, props.ascii).match(/[░-]+$/) ?? [''])[0]}</Text>
        <Text dimColor>{props.ascii ? ']' : '▏'}</Text>
        <Text color={props.color}> {props.text}</Text>
      </Box>
    )
  }

  // flash: highlighted for a moment from mount, then the entry's normal look.
  if (!s) {
    const t0 = Date.now()
    const stop = surface.every(FRAME_MS, () => {
      if (Date.now() - t0 < FLASH_MS) return
      surface.state?.stop?.()
      surface.setState({ ...blank(t0), off: true })
    })
    surface.setState({ ...blank(t0), stop })
  }
  const lit = !s?.off
  return (
    <Box>
      {props.head ? <Text dimColor={!lit} inverse={lit}>{props.head} </Text> : null}
      <Box flexShrink={1}>
        <Text bold={lit} dimColor={!lit && !!props.dim}>{props.body}</Text>
      </Box>
    </Box>
  )
}
