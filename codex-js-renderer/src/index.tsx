import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Box, Text, Static, render, useApp, useInput } from 'ink'

// ─── Types ───────────────────────────────────────────────────────────────────

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: JsonValue
  result?: JsonValue
  error?: { message?: string }
}

type EntryKind =
  | 'user'
  | 'research'
  | 'repository'
  | 'edit'
  | 'validation'
  | 'execution'
  | 'plan'
  | 'reasoning'
  | 'response'
  | 'external'
  | 'review'
  | 'session'

type FeedEntry = {
  id: string
  intent: string
  action?: string
  result?: string
  kind: EntryKind
  timestamp: number
  isError?: boolean
  isWarning?: boolean
  fullText?: string
}

type ActiveItem = {
  entry: FeedEntry
  startTime: number
  outputLines: string[]
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const SPINNER_INTERVAL_MS = 120

// ─── AppServerClient ─────────────────────────────────────────────────────────

class AppServerClient {
  private child
  private nextId = 1
  private pending = new Map<
    number,
    { resolve: (v: JsonValue) => void; reject: (e: Error) => void }
  >()
  private notificationListeners = new Set<(m: JsonRpcMessage) => void>()
  private stderrListeners = new Set<(l: string) => void>()
  private exitListeners = new Set<(c: number | null) => void>()

  constructor(private readonly binary: string) {
    this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })
    const out = readline.createInterface({ input: this.child.stdout })
    out.on('line', l => {
      if (!l.trim()) return
      try { this.handleMessage(JSON.parse(l)) } catch {}
    })
    const err = readline.createInterface({ input: this.child.stderr })
    err.on('line', l => this.stderrListeners.forEach(fn => fn(l)))
    this.child.on('exit', code => {
      const e = new Error(`app-server exited (${code ?? '?'})`)
      for (const p of this.pending.values()) p.reject(e)
      this.pending.clear()
      this.exitListeners.forEach(fn => fn(code))
    })
  }

  onNotification(fn: (m: JsonRpcMessage) => void) {
    this.notificationListeners.add(fn)
    return () => this.notificationListeners.delete(fn)
  }
  onStderr(fn: (l: string) => void) {
    this.stderrListeners.add(fn)
    return () => this.stderrListeners.delete(fn)
  }
  onExit(fn: (c: number | null) => void) {
    this.exitListeners.add(fn)
    return () => this.exitListeners.delete(fn)
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: { name: 'codex_fork_js_renderer', title: 'Codex Fork JS Renderer', version: '0.3.0' },
      capabilities: { experimentalApi: true, optOutNotificationMethods: [] },
    })
    this.notify('initialized')
  }

  request<T extends JsonValue = JsonValue>(method: string, params: JsonValue): Promise<T> {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: JsonValue) => void, reject })
    })
  }

  notify(method: string, params?: JsonValue) {
    this.child.stdin.write(`${JSON.stringify(params === undefined ? { method } : { method, params })}\n`)
  }

  close() { this.child.kill('SIGTERM') }

  private handleMessage(msg: JsonRpcMessage) {
    if (typeof msg.id !== 'undefined' && ('result' in msg || 'error' in msg)) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      msg.error ? p.reject(new Error(msg.error.message ?? 'RPC error')) : p.resolve(msg.result ?? null)
      return
    }
    if (msg.method) this.notificationListeners.forEach(fn => fn(msg))
  }
}

// ─── CLI Utilities ───────────────────────────────────────────────────────────

function launchCwd() { return process.env.CODEX_FORK_UI_LAUNCH_CWD || process.cwd() }

function backendBinary() {
  const c = process.env.CODEX_FORK_BACKEND_BIN
  if (c && existsSync(c)) return c
  return path.resolve(process.cwd(), '..', 'codex-rs', 'target', 'debug', 'codex')
}

function parseArgs(argv: string[]) {
  let cwd = launchCwd(), model: string | undefined, resumeThreadId: string | undefined
  let resumeLast = false, listSessions = false, interactiveResume = false
  const prompt: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a) continue
    if (a === '--cwd' || a === '-C') { cwd = argv[++i] || cwd }
    else if (a === '--model' || a === '-m') { model = argv[++i] || model }
    else if (a === '--resume') { resumeThreadId = argv[++i] || resumeThreadId }
    else if (a === '--last') { resumeLast = true }
    else if (a === '--list') { listSessions = true }
    else if (a === 'resume' && i === 0) { interactiveResume = true }
    else { prompt.push(a) }
  }
  return { cwd, model, resumeThreadId, resumeLast, listSessions, interactiveResume, initialPrompt: prompt.join(' ').trim() }
}

async function resolveResumeThreadId(client: AppServerClient, cwd: string) {
  const local = await client.request('thread/list', { limit: 1, sortKey: 'updated_at', archived: false, cwd }) as any
  if (local?.data?.[0]?.id) return local.data[0].id as string
  const global = await client.request('thread/list', { limit: 1, sortKey: 'updated_at', archived: false }) as any
  return (global?.data?.[0]?.id as string) || undefined
}

// ─── Text Utilities ──────────────────────────────────────────────────────────

function firstSentence(text: string, maxLen = 160): string {
  const c = text.replace(/\s+/g, ' ').trim()
  const m = c.match(/^[^.!?\n]+[.!?]?/)
  const s = m ? m[0].trim() : c
  return s.length > maxLen ? s.slice(0, maxLen - 1) + '…' : s
}

function truncate(text: string, maxLen = 120): string {
  const c = text.replace(/\s+/g, ' ').trim()
  return c.length > maxLen ? c.slice(0, maxLen - 1) + '…' : c
}

function summarizeShellBrief(command: string): string {
  const steps = command.split(/[;&|]+/).map(s => s.trim()).filter(Boolean)
  if (!steps.length) return command
  const first = steps[0].split(/\s+/).slice(0, 6).join(' ')
  return steps.length === 1 ? first : `${first} (+${steps.length - 1} more)`
}

// ─── Markdown Renderer ───────────────────────────────────────────────────────

function MarkdownText({ text, indent = '  ' }: { text: string; indent?: string }) {
  const lines = text.split('\n')
  const w = process.stdout.columns || 80
  const hrLine = '─'.repeat(Math.max(20, Math.min(w - indent.length - 2, 72)))
  const elements: React.ReactNode[] = []
  let inCodeBlock = false
  let codeLines: string[] = []
  let codeKey = 0

  const flushCode = () => {
    if (codeLines.length > 0) {
      elements.push(
        <Box key={`code-${codeKey++}`} flexDirection="column" marginTop={0} marginBottom={0}>
          {codeLines.map((cl, ci) => (
            <Text key={ci} color="gray">{indent}  {cl}</Text>
          ))}
        </Box>,
      )
      codeLines = []
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Code block toggle
    if (line.trimStart().startsWith('```')) {
      if (inCodeBlock) {
        flushCode()
        inCodeBlock = false
      } else {
        inCodeBlock = true
      }
      continue
    }

    if (inCodeBlock) {
      codeLines.push(line)
      continue
    }

    // Horizontal rule
    if (/^---+$/.test(line.trim()) || /^===+$/.test(line.trim()) || /^\*\*\*+$/.test(line.trim())) {
      elements.push(<Text key={i} color="gray" dimColor>{indent}{hrLine}</Text>)
      continue
    }

    // Headers
    const headerMatch = line.match(/^(#{1,3})\s+(.+)/)
    if (headerMatch) {
      const level = headerMatch[1].length
      const content = headerMatch[2]
      elements.push(
        <Text key={i} bold={level <= 2} color={level === 1 ? 'white' : 'white'}>
          {indent}{content}
        </Text>,
      )
      continue
    }

    // Bullet lists
    const bulletMatch = line.match(/^(\s*)([-*])\s+(.+)/)
    if (bulletMatch) {
      const bulletIndent = bulletMatch[1]
      const content = bulletMatch[3]
      elements.push(
        <Text key={i}>{indent}{bulletIndent}  • {renderInlineMarkdown(content)}</Text>,
      )
      continue
    }

    // Numbered lists
    const numMatch = line.match(/^(\s*)\d+[.)]\s+(.+)/)
    if (numMatch) {
      const numIndent = numMatch[1]
      const content = numMatch[2]
      elements.push(
        <Text key={i}>{indent}{numIndent}  {renderInlineMarkdown(content)}</Text>,
      )
      continue
    }

    // Empty lines
    if (!line.trim()) {
      elements.push(<Text key={i}>{' '}</Text>)
      continue
    }

    // Regular text with inline markdown
    elements.push(<Text key={i}>{indent}{renderInlineMarkdown(line)}</Text>)
  }

  flushCode()

  return <Box flexDirection="column">{elements}</Box>
}

function renderInlineMarkdown(text: string): React.ReactNode {
  // Process inline markdown: **bold**, *italic*, `code`
  const parts: React.ReactNode[] = []
  let remaining = text
  let key = 0

  while (remaining.length > 0) {
    // Bold: **text**
    const boldMatch = remaining.match(/^(.*?)\*\*(.+?)\*\*(.*)/)
    if (boldMatch) {
      if (boldMatch[1]) parts.push(<Text key={key++}>{boldMatch[1]}</Text>)
      parts.push(<Text key={key++} bold>{boldMatch[2]}</Text>)
      remaining = boldMatch[3]
      continue
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^(.*?)`(.+?)`(.*)/)
    if (codeMatch) {
      if (codeMatch[1]) parts.push(<Text key={key++}>{codeMatch[1]}</Text>)
      parts.push(<Text key={key++} color="gray">{codeMatch[2]}</Text>)
      remaining = codeMatch[3]
      continue
    }

    // Italic: *text* (but not **)
    const italicMatch = remaining.match(/^(.*?)\*([^*]+?)\*(.*)/)
    if (italicMatch) {
      if (italicMatch[1]) parts.push(<Text key={key++}>{italicMatch[1]}</Text>)
      parts.push(<Text key={key++} dimColor>{italicMatch[2]}</Text>)
      remaining = italicMatch[3]
      continue
    }

    // No more inline markdown
    parts.push(<Text key={key++}>{remaining}</Text>)
    break
  }

  return <>{parts}</>
}

// ─── Intent Synthesis ────────────────────────────────────────────────────────

function synthesizeCommandIntent(item: any): { intent: string; action: string; kind: EntryKind } {
  const actions: any[] = Array.isArray(item.commandActions) ? item.commandActions : []
  const raw = String(item.command || '')
  const lower = raw.toLowerCase()

  if (actions.length && actions.every((a: any) => a.type === 'read')) {
    const files = actions.map((a: any) => path.basename(a.path || a.name || 'file')).slice(0, 4)
    return { intent: `Examining ${files.join(', ')}`, action: `read ${files.join(', ')}`, kind: 'research' }
  }
  if (actions.length && actions.every((a: any) => a.type === 'search')) {
    const q = actions.find((a: any) => a.query)?.query || 'pattern'
    const p = actions.find((a: any) => a.path)?.path
    return { intent: `Looking for "${q}"${p ? ` in ${p}` : ''}`, action: `search "${q}"`, kind: 'research' }
  }
  if (actions.length && actions.every((a: any) => a.type === 'listFiles')) {
    return { intent: `Exploring ${actions[0]?.path || '.'} structure`, action: `list`, kind: 'research' }
  }
  if (actions.length && actions.every((a: any) => ['read', 'search', 'listFiles'].includes(a.type))) {
    return { intent: 'Investigating project structure', action: summarizeShellBrief(raw), kind: 'research' }
  }
  if (/^git\s+(status|diff|log|branch|rev-parse|show)/.test(lower)) {
    const intents: Record<string, string> = { status: 'Checking for uncommitted changes', diff: 'Reviewing current changes', log: 'Looking at recent history', branch: 'Checking current branch', show: 'Inspecting a commit' }
    return { intent: intents[lower.split(/\s+/)[1] || ''] || 'Checking repository state', action: summarizeShellBrief(raw), kind: 'repository' }
  }
  if (/^git\s+(add|commit|push|merge|rebase|checkout|stash)/.test(lower)) {
    return { intent: `Running git ${lower.split(/\s+/)[1]}`, action: summarizeShellBrief(raw), kind: 'repository' }
  }
  if (/\b(pytest|jest|vitest|npm test|pnpm test|cargo test|go test)\b/.test(lower)) {
    return { intent: 'Running tests to verify changes', action: summarizeShellBrief(raw), kind: 'validation' }
  }
  if (/\b(cargo build|npm run build|pnpm build|tsc|gradle|make)\b/.test(lower)) {
    return { intent: 'Building to check for errors', action: summarizeShellBrief(raw), kind: 'validation' }
  }
  if (/\b(eslint|prettier|rustfmt|gofmt|black|ruff)\b/.test(lower)) {
    return { intent: 'Checking code style', action: summarizeShellBrief(raw), kind: 'validation' }
  }
  if (/\b(npm install|pnpm install|yarn add|pip install|cargo add)\b/.test(lower)) {
    return { intent: 'Installing dependencies', action: summarizeShellBrief(raw), kind: 'execution' }
  }
  return { intent: summarizeShellBrief(raw), action: summarizeShellBrief(raw), kind: 'execution' }
}

function itemToFeedEntry(item: any): FeedEntry | null {
  if (!item?.type || item.type === 'userMessage' || item.type === 'hookPrompt') return null

  if (item.type === 'plan') {
    const t = String(item.text || '').trim()
    if (!t) return null
    return { id: item.id, intent: firstSentence(t), action: t.split('\n').length > 1 ? `${t.split('\n').filter(Boolean).length} steps` : undefined, kind: 'plan', timestamp: Date.now(), fullText: t }
  }
  if (item.type === 'reasoning') {
    const t = Array.isArray(item.summary) ? item.summary.join('\n') : String(item.content || '')
    const s = firstSentence(t)
    if (!s) return null
    return { id: item.id, intent: s, kind: 'reasoning', timestamp: Date.now(), fullText: t }
  }
  if (item.type === 'agentMessage') {
    const t = String(item.text || '').trim()
    if (!t) return null
    return { id: item.id, intent: t, kind: 'response', timestamp: Date.now(), fullText: t }
  }
  if (item.type === 'commandExecution') {
    const { intent, action, kind } = synthesizeCommandIntent(item)
    const failed = item.status === 'failed' || item.status === 'declined'
    return { id: item.id, intent, action, result: failed && item.aggregatedOutput ? truncate(String(item.aggregatedOutput).trim(), 200) : undefined, kind, timestamp: Date.now(), isError: failed, isWarning: failed }
  }
  if (item.type === 'fileChange') {
    const ch: any[] = Array.isArray(item.changes) ? item.changes : []
    const files = ch.map((c: any) => path.basename(c.path || c.filePath || c.file_name || '')).filter(Boolean)
    const a = ch.reduce((s: number, c: any) => s + (c.linesAdded || 0), 0)
    const r = ch.reduce((s: number, c: any) => s + (c.linesRemoved || 0), 0)
    const fl = files.length ? files.slice(0, 3).join(', ') + (files.length > 3 ? ` +${files.length - 3}` : '') : `${ch.length} files`
    return { id: item.id, intent: `Updating ${fl}`, action: `modified ${fl}${a || r ? ` (+${a} −${r})` : ''}`, kind: 'edit', timestamp: Date.now() }
  }
  if (item.type === 'mcpToolCall') {
    return { id: item.id, intent: `Using ${item.server || 'tool'}.${item.tool || 'call'}`, kind: 'external', timestamp: Date.now(), isError: item.status === 'failed' }
  }
  if (item.type === 'webSearch') {
    return { id: item.id, intent: `Researching: ${item.query || 'web search'}`, kind: 'external', timestamp: Date.now() }
  }
  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    return { id: item.id, intent: item.type === 'enteredReviewMode' ? 'Entering code review' : 'Finished code review', kind: 'review', timestamp: Date.now() }
  }
  if (item.type === 'contextCompaction') {
    return { id: item.id, intent: 'Compacting context', kind: 'session', timestamp: Date.now() }
  }
  return null
}

// ─── Slash Commands ──────────────────────────────────────────────────────────

type SlashCommandDef = { name: string; aliases?: string[]; description: string; availableDuringTask?: boolean }

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'help', description: 'list available commands', availableDuringTask: true },
  { name: 'resume', description: 'resume a saved session' },
  { name: 'new', description: 'start a new session' },
  { name: 'clear', description: 'clear the feed', availableDuringTask: true },
  { name: 'diff', description: 'show git diff', availableDuringTask: true },
  { name: 'compact', description: 'compact context' },
  { name: 'status', description: 'show session info', availableDuringTask: true },
  { name: 'copy', description: 'copy last response to clipboard', availableDuringTask: true },
  { name: 'logout', description: 'log out and quit' },
  { name: 'quit', description: 'exit', aliases: ['exit'], availableDuringTask: true },
]

function parseSlashCommand(input: string): { command: string; args: string } | null {
  const t = input.trim()
  if (!t.startsWith('/')) return null
  const sp = t.indexOf(' ')
  const cmd = (sp === -1 ? t.slice(1) : t.slice(1, sp)).toLowerCase()
  if (!cmd) return null
  return { command: cmd, args: sp === -1 ? '' : t.slice(sp + 1).trim() }
}

function findSlashCommand(name: string): SlashCommandDef | null {
  for (const c of SLASH_COMMANDS) {
    if (c.name === name || c.aliases?.includes(name)) return c
  }
  return null
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const t = setInterval(() => setFrame(f => (f + 1) % SPINNER_FRAMES.length), SPINNER_INTERVAL_MS)
    return () => clearInterval(t)
  }, [active])
  return active ? (SPINNER_FRAMES[frame] ?? '⠋') : ''
}

function useElapsed(startTime: number | null): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (startTime === null) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [startTime])
  if (startTime === null) return ''
  const total = Math.floor((now - startTime) / 1000)
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`
}

// ─── Static Entry Component (rendered once, never re-rendered) ───────────────

function StaticEntry({ entry }: { entry: FeedEntry }) {
  if (entry.kind === 'user') {
    return (
      <Box flexDirection="column" marginTop={1}>
        <Text>
          <Text color="gray" dimColor>{'  ▍ '}</Text>
          <Text color="white" bold>{entry.intent}</Text>
        </Text>
      </Box>
    )
  }

  if (entry.kind === 'response') {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        <MarkdownText text={entry.fullText || entry.intent} />
      </Box>
    )
  }

  if (entry.kind === 'session') {
    if (entry.isError) {
      return (
        <Text>
          <Text color="yellow">{'  ⚠ '}</Text>
          <Text color="yellow">{entry.intent}</Text>
        </Text>
      )
    }
    return <Text color="gray" dimColor>{'  '}{entry.intent}</Text>
  }

  if (entry.kind === 'plan') {
    return (
      <Box flexDirection="column">
        <Text><Text color="gray" dimColor>{'  ◇ '}</Text><Text>{entry.intent}</Text></Text>
        {entry.action && <Text color="gray" dimColor>{'    '}{entry.action}</Text>}
      </Box>
    )
  }

  if (entry.kind === 'reasoning') {
    return <Text><Text color="gray" dimColor>{'  ◇ '}</Text><Text color="gray">{entry.intent}</Text></Text>
  }

  // Action entries
  const hasAction = !!entry.action
  const hasResult = !!entry.result
  return (
    <Box flexDirection="column">
      <Text color={entry.isWarning ? 'yellow' : 'white'}>
        {entry.isWarning ? '  ⚠ ' : '  '}{entry.intent}
      </Text>
      {hasAction && <Text color="gray" dimColor>{'  '}{hasResult ? '│' : '└'} {entry.action}</Text>}
      {hasResult && <Text color={entry.isError ? 'yellow' : 'gray'} dimColor={!entry.isError}>{'  └ '}{entry.result}</Text>}
    </Box>
  )
}

// ─── Live Panel (only this re-renders) ───────────────────────────────────────

function LivePanel({
  activeItem, streamingText, threadStatus, gitBranch, model, errorText,
  composer, activeTurnId,
}: {
  activeItem: ActiveItem | null; streamingText: string; threadStatus: string
  gitBranch: string; model?: string; errorText: string | null
  composer: string; activeTurnId: string | null
}) {
  const isActive = !!activeItem || threadStatus === 'active'
  const spinner = useSpinner(isActive)
  const elapsed = useElapsed(activeItem?.startTime ?? null)
  const w = process.stdout.columns || 80
  const hr = '─'.repeat(Math.max(20, Math.min(w - 4, 88)))

  const errorLine = errorText
    ? <Text><Text color="yellow">{'  ⚠ '}</Text><Text color="yellow">{truncate(errorText, w - 8)}</Text></Text>
    : null

  let statusSection: React.ReactNode

  if (!activeItem && (threadStatus === 'idle' || threadStatus === 'unknown')) {
    const parts = ['Ready']
    if (gitBranch) parts.push(gitBranch)
    if (model) parts.push(model)
    statusSection = (
      <>
        {errorLine}
        <Text><Text color="green">{'  ● '}</Text><Text color="gray">{parts.join(' · ')}</Text></Text>
      </>
    )
  } else if (!activeItem && threadStatus === 'starting') {
    statusSection = (
      <>
        {errorLine}
        <Text color="gray">{'  '}Starting session...</Text>
      </>
    )
  } else {
    const intentText = activeItem?.entry.intent || 'Working...'
    const timerStr = elapsed ? `  ${elapsed}` : ''
    const maxW = w - 10 - timerStr.length
    const display = intentText.length > maxW ? intentText.slice(0, maxW - 1) + '…' : intentText
    const pad = Math.max(1, w - 6 - display.length - timerStr.length)

    let previewLines: string[] = []
    if (activeItem?.outputLines.length) previewLines = activeItem.outputLines.slice(-3)
    else if (streamingText) previewLines = streamingText.split('\n').filter(l => l.trim()).slice(-3)

    statusSection = (
      <>
        {errorLine}
        <Text>
          <Text color="cyan">{'  '}{spinner} </Text>
          <Text color="white">{display}</Text>
          <Text color="gray" dimColor>{' '.repeat(pad)}{timerStr}</Text>
        </Text>
        {activeItem?.entry.action && activeItem.entry.action !== activeItem.entry.intent && (
          <Text color="gray" dimColor>{'    '}{truncate(activeItem.entry.action, w - 8)}</Text>
        )}
        {previewLines.map((l, i) => (
          <Text key={i} color="gray" dimColor>{'    '}{l.length > w - 8 ? l.slice(0, w - 9) + '…' : l}</Text>
        ))}
      </>
    )
  }

  return (
    <Box flexDirection="column">
      <Text color="gray" dimColor>{hr}</Text>
      {statusSection}
      <Text color="gray" dimColor>{hr}</Text>
      <Box>
        {activeTurnId ? <Text color="cyan">{'⚡ › '}</Text> : <Text color="white">{'› '}</Text>}
        <Text>
          {composer || <Text color="gray" dimColor>{activeTurnId ? 'type to steer' : 'type a prompt to begin'}</Text>}
        </Text>
        <Text color="white">{'█'}</Text>
      </Box>
      <Text color="gray" dimColor>{'  '}/help commands · Ctrl+C quit</Text>
    </Box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App({ resumeOverride }: { resumeOverride?: string } = {}) {
  const { exit } = useApp()
  const args = useMemo(() => parseArgs(process.argv.slice(2)), [])

  // Static entries (pushed to <Static>, never re-rendered)
  const [staticEntries, setStaticEntries] = useState<FeedEntry[]>([])

  // Active item (shown in live panel)
  const [activeItem, setActiveItem] = useState<ActiveItem | null>(null)
  const activeRef = useRef<ActiveItem | null>(null)

  const [streamingText, setStreamingText] = useState('')
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threadStatus, setThreadStatus] = useState('starting')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState('')

  const initialPromptSent = useRef(false)
  const clientRef = useRef<AppServerClient | null>(null)

  useEffect(() => { activeRef.current = activeItem }, [activeItem])

  const pushStatic = useCallback((entry: FeedEntry) => {
    setStaticEntries(prev => [...prev, entry])
  }, [])

  const flushActive = useCallback(() => {
    const c = activeRef.current
    if (c) {
      setStaticEntries(prev => [...prev, c.entry])
      activeRef.current = null
    }
    setActiveItem(null)
  }, [])

  // ── Backend ──
  useEffect(() => {
    const client = new AppServerClient(backendBinary())
    clientRef.current = client

    const unlisten = client.onNotification(msg => {
      try {
        if (msg.method === 'thread/started') {
          const tid = (msg.params as any)?.thread?.id
          if (tid) { setThreadId(tid); setThreadStatus('idle'); pushStatic({ id: `session-${tid}`, intent: 'Session started', kind: 'session', timestamp: Date.now() }) }
          return
        }
        if (msg.method === 'thread/status/changed') { setThreadStatus((msg.params as any)?.status?.type || 'unknown'); return }
        if (msg.method === 'turn/started') { setActiveTurnId((msg.params as any)?.turn?.id || null); setThreadStatus('active'); return }
        if (msg.method === 'turn/completed') { flushActive(); setActiveTurnId(null); setThreadStatus('idle'); setStreamingText(''); return }
        if (msg.method === 'item/agentMessage/delta' || msg.method === 'item/reasoning/summaryTextDelta' || msg.method === 'item/plan/delta') {
          setStreamingText(p => p + String((msg.params as any)?.delta || '')); return
        }
        if (msg.method === 'item/commandExecution/outputDelta') {
          const d = String((msg.params as any)?.delta || '')
          if (d && activeRef.current) {
            const nl = d.split('\n').filter(Boolean)
            const up = { ...activeRef.current, outputLines: [...activeRef.current.outputLines, ...nl].slice(-3) }
            activeRef.current = up; setActiveItem(up)
          }
          return
        }
        if (msg.method === 'item/started') {
          const entry = itemToFeedEntry((msg.params as any)?.item)
          if (entry) {
            flushActive()
            const a: ActiveItem = { entry, startTime: Date.now(), outputLines: [] }
            activeRef.current = a; setActiveItem(a); setStreamingText('')
          }
          return
        }
        if (msg.method === 'item/completed') {
          const entry = itemToFeedEntry((msg.params as any)?.item)
          if (entry) {
            pushStatic(entry)
            if (activeRef.current?.entry.id === entry.id) { activeRef.current = null; setActiveItem(null) }
            if ((msg.params as any)?.item?.type === 'agentMessage') setStreamingText('')
          }
          return
        }
        if (msg.method === 'error') {
          const e = (msg.params as any)?.error
          const m = [e?.message, e?.additionalDetails].filter(Boolean).join(' · ') || 'Unknown error'
          setErrorText(m)
          pushStatic({ id: `error-${Date.now()}`, intent: m, kind: 'session', timestamp: Date.now(), isError: true, isWarning: true })
        }
      } catch (e) { setErrorText(String(e)) }
    })

    const unExit = client.onExit(c => setErrorText(`Backend exited (${c ?? '?'})`))

    ;(async () => {
      try {
        await client.initialize()
        const tid = resumeOverride || args.resumeThreadId || (args.resumeLast ? await resolveResumeThreadId(client, args.cwd) : undefined)
        const res = tid
          ? await client.request('thread/resume', { threadId: tid, cwd: args.cwd, model: args.model ?? null, approvalPolicy: 'never', sandbox: 'danger-full-access', persistExtendedHistory: true }) as any
          : await client.request('thread/start', { cwd: args.cwd, model: args.model ?? null, approvalPolicy: 'never', sandbox: 'danger-full-access', experimentalRawEvents: false, persistExtendedHistory: true, serviceName: 'codex_fork_js_renderer' }) as any
        if (res?.thread?.id) setThreadId(res.thread.id)
        if (tid && res?.thread) pushStatic({ id: `resume-${tid}`, intent: `Resumed: ${res.thread.name || res.thread.preview || tid}`, kind: 'session', timestamp: Date.now() })
      } catch (e) { setErrorText(String(e)) }
    })()

    return () => { unlisten(); unExit(); client.close() }
  }, [args.cwd, args.model])

  useEffect(() => {
    if (initialPromptSent.current || !threadId || !args.initialPrompt) return
    initialPromptSent.current = true
    void submitPrompt(args.initialPrompt)
  }, [threadId, args.initialPrompt])

  useEffect(() => {
    try { setGitBranch(execFileSync('git', ['-C', args.cwd, 'branch', '--show-current'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) }
    catch { setGitBranch('') }
  }, [args.cwd])

  // ── Slash commands ──
  const handleSlashCommand = async (cmdName: string, cmdArgs: string) => {
    const client = clientRef.current
    const cmd = findSlashCommand(cmdName)
    if (!cmd) { pushStatic({ id: `cmd-${Date.now()}`, intent: `Unknown command: /${cmdName}. Type /help for a list.`, kind: 'session', timestamp: Date.now(), isWarning: true }); return }
    if (activeTurnId && !cmd.availableDuringTask) { pushStatic({ id: `cmd-${Date.now()}`, intent: `/${cmd.name} unavailable during active turn`, kind: 'session', timestamp: Date.now(), isWarning: true }); return }

    switch (cmd.name) {
      case 'help':
        pushStatic({ id: `help-${Date.now()}`, intent: `Available commands:\n${SLASH_COMMANDS.map(c => `  /${c.name.padEnd(10)} ${c.description}`).join('\n')}`, kind: 'response', timestamp: Date.now(), fullText: `Available commands:\n${SLASH_COMMANDS.map(c => `  /${c.name.padEnd(10)} ${c.description}`).join('\n')}` }); break
      case 'resume':
        if (!client) break
        try {
          if (cmdArgs) {
            const r = await client.request('thread/resume', { threadId: cmdArgs, cwd: args.cwd, model: args.model ?? null, approvalPolicy: 'never', sandbox: 'danger-full-access', persistExtendedHistory: true }) as any
            if (r?.thread?.id) { setThreadId(r.thread.id); setThreadStatus('idle'); pushStatic({ id: `resume-${Date.now()}`, intent: `Resumed: ${r.thread.name || r.thread.preview || cmdArgs}`, kind: 'session', timestamp: Date.now() }) }
          } else {
            const r = await client.request('thread/list', { limit: 10, sortKey: 'updated_at', archived: false }) as any
            const threads = r?.data || []
            if (!threads.length) { pushStatic({ id: `rn-${Date.now()}`, intent: 'No saved sessions.', kind: 'session', timestamp: Date.now() }) }
            else {
              const listing = threads.map((t: any, i: number) => `  ${i + 1}. ${truncate(t.name || t.preview || t.id, 60)}${t.id === threadId ? ' (current)' : ''}  ${t.updated_at ? new Date(t.updated_at).toLocaleDateString() : ''}\n     /resume ${t.id}`).join('\n')
              pushStatic({ id: `rl-${Date.now()}`, intent: 'Recent sessions:', kind: 'response', timestamp: Date.now(), fullText: `Recent sessions:\n${listing}` })
            }
          }
        } catch (e) { setErrorText(`Resume failed: ${e}`) }
        break
      case 'new':
        if (!client) break
        try {
          flushActive(); setStreamingText(''); setActiveTurnId(null)
          const r = await client.request('thread/start', { cwd: args.cwd, model: args.model ?? null, approvalPolicy: 'never', sandbox: 'danger-full-access', experimentalRawEvents: false, persistExtendedHistory: true, serviceName: 'codex_fork_js_renderer' }) as any
          if (r?.thread?.id) { setThreadId(r.thread.id); setThreadStatus('idle'); setStaticEntries([]); pushStatic({ id: `s-${r.thread.id}`, intent: 'New session started', kind: 'session', timestamp: Date.now() }) }
        } catch (e) { setErrorText(`New session failed: ${e}`) }
        break
      case 'clear': setStaticEntries([]); setErrorText(null); break
      case 'diff':
        try {
          const d = execFileSync('git', ['-C', args.cwd, 'diff', '--stat', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
          const u = execFileSync('git', ['-C', args.cwd, 'ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
          pushStatic({ id: `diff-${Date.now()}`, intent: 'Git diff:', kind: 'response', timestamp: Date.now(), fullText: `${d || 'No changes.'}${u ? `\n\nUntracked:\n${u}` : ''}` })
        } catch { pushStatic({ id: `diff-${Date.now()}`, intent: 'Not a git repo', kind: 'session', timestamp: Date.now(), isWarning: true }) }
        break
      case 'compact':
        if (client && threadId) { client.notify('thread/compact', { threadId }); pushStatic({ id: `cmp-${Date.now()}`, intent: 'Context compaction requested', kind: 'session', timestamp: Date.now() }) }
        break
      case 'status':
        pushStatic({ id: `st-${Date.now()}`, intent: 'Session status:', kind: 'response', timestamp: Date.now(), fullText: [`Thread: ${threadId || 'none'}`, `Status: ${threadStatus}`, `Branch: ${gitBranch || 'n/a'}`, `Model: ${args.model || 'default'}`, `CWD: ${args.cwd}`].join('\n') })
        break
      case 'copy': {
        const last = [...staticEntries].reverse().find(e => e.kind === 'response')
        if (!last) { pushStatic({ id: `cp-${Date.now()}`, intent: 'Nothing to copy.', kind: 'session', timestamp: Date.now() }); break }
        try { execFileSync('pbcopy', [], { input: last.fullText || last.intent, stdio: ['pipe', 'ignore', 'ignore'] }); pushStatic({ id: `cp-${Date.now()}`, intent: 'Copied to clipboard', kind: 'session', timestamp: Date.now() }) }
        catch { pushStatic({ id: `cp-${Date.now()}`, intent: 'Clipboard unavailable', kind: 'session', timestamp: Date.now(), isWarning: true }) }
        break
      }
      case 'logout':
        if (client) { try { await client.request('auth/logout', {}) } catch {} }
        pushStatic({ id: `lo-${Date.now()}`, intent: 'Logged out.', kind: 'session', timestamp: Date.now() })
        setTimeout(() => exit(), 500); break
      case 'quit': exit(); break
    }
  }

  const submitPrompt = async (promptText: string) => {
    const client = clientRef.current
    if (!client || !threadId) return
    const text = promptText.trim()
    if (!text) return

    const parsed = parseSlashCommand(text)
    if (parsed) {
      setComposer('')
      pushStatic({ id: `user-${Date.now()}`, intent: text, kind: 'user', timestamp: Date.now() })
      await handleSlashCommand(parsed.command, parsed.args)
      return
    }

    pushStatic({ id: `user-${Date.now()}`, intent: text, kind: 'user', timestamp: Date.now() })
    setComposer('')

    try {
      if (activeTurnId) {
        await client.request('turn/steer', { threadId, expectedTurnId: activeTurnId, input: [{ type: 'text', text, text_elements: [] }] })
      } else {
        const r = await client.request('turn/start', { threadId, input: [{ type: 'text', text, text_elements: [] }], sandboxPolicy: { type: 'dangerFullAccess' }, approvalPolicy: 'never', model: args.model ?? null, effort: 'medium' }) as any
        setActiveTurnId(r?.turn?.id || null)
      }
      setThreadStatus('active')
    } catch (e) { setErrorText(String(e)) }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return }
    if (key.return) { void submitPrompt(composer); return }
    if (key.backspace || key.delete) { setComposer(p => p.slice(0, -1)); return }
    if (key.escape) { setComposer(''); return }
    if (!key.ctrl && !key.meta && input) setComposer(p => p + input)
  })

  return (
    <Box flexDirection="column">
      {/* Header — rendered once at top */}
      <Box marginBottom={0}>
        <Text color="gray" dimColor>
          {'  codex-fork'}{gitBranch ? ` · ${gitBranch}` : ''}{args.model ? ` · ${args.model}` : ''}
        </Text>
      </Box>

      {/* Static feed — each entry rendered once, never re-rendered */}
      <Static items={staticEntries}>
        {(entry) => <StaticEntry key={entry.id} entry={entry} />}
      </Static>

      {/* Live panel — only this re-renders (spinner, streaming, composer) */}
      <LivePanel
        activeItem={activeItem}
        streamingText={streamingText}
        threadStatus={threadStatus}
        gitBranch={gitBranch}
        model={args.model}
        errorText={errorText}
        composer={composer}
        activeTurnId={activeTurnId}
      />
    </Box>
  )
}

// ─── Resume Picker ───────────────────────────────────────────────────────────

function ResumePicker({ onSelect }: { onSelect: (id: string) => void }) {
  const { exit } = useApp()
  const [threads, setThreads] = useState<{ id: string; name: string; date: string; cwd: string }[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<AppServerClient | null>(null)

  useEffect(() => {
    const client = new AppServerClient(backendBinary())
    clientRef.current = client
    ;(async () => {
      try {
        await client.initialize()
        const r = await client.request('thread/list', { limit: 15, sortKey: 'updated_at', archived: false }) as any
        setThreads((r?.data || []).map((t: any) => ({ id: t.id, name: t.name || t.preview || '(untitled)', date: t.updated_at ? new Date(t.updated_at).toLocaleString() : '', cwd: t.cwd || '' })))
      } catch (e) { setError(String(e)) }
      finally { setLoading(false) }
    })()
    return () => client.close()
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c' || key.escape) { clientRef.current?.close(); exit(); return }
    if (key.upArrow) { setSelected(p => Math.max(0, p - 1)); return }
    if (key.downArrow) { setSelected(p => Math.min(threads.length - 1, p + 1)); return }
    if (key.return && threads[selected]) { clientRef.current?.close(); onSelect(threads[selected].id); return }
    const n = parseInt(input, 10)
    if (n >= 1 && n <= threads.length && threads[n - 1]) { clientRef.current?.close(); onSelect(threads[n - 1].id) }
  })

  if (loading) return <Text color="gray">{'  '}Loading sessions...</Text>
  if (error) return <Text color="yellow">{'  '}Failed: {error}</Text>
  if (!threads.length) return <Text color="gray">{'  '}No saved sessions. Press Esc.</Text>

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color="white" bold>Resume a session</Text>
      <Text color="gray" dimColor>↑↓ navigate · Enter select · 1-9 quick pick · Esc cancel</Text>
      <Text>{''}</Text>
      {threads.map((t, i) => (
        <Box key={t.id} flexDirection="column">
          <Text>
            <Text color={i === selected ? 'cyan' : 'gray'}>{i === selected ? '  ❯ ' : '    '}</Text>
            <Text color={i === selected ? 'white' : 'gray'} bold={i === selected}>{i + 1}. {truncate(t.name, 60)}</Text>
          </Text>
          <Text color="gray" dimColor>{'      '}{t.date}{t.cwd ? `  ${t.cwd}` : ''}</Text>
        </Box>
      ))}
    </Box>
  )
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

function Root() {
  const cliArgs = useMemo(() => parseArgs(process.argv.slice(2)), [])
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(cliArgs.interactiveResume)

  if (showPicker && !pickedId) return <ResumePicker onSelect={id => { setPickedId(id); setShowPicker(false) }} />
  return <App resumeOverride={pickedId || undefined} />
}

const cliArgs = parseArgs(process.argv.slice(2))
if (cliArgs.listSessions) {
  ;(async () => {
    const client = new AppServerClient(backendBinary())
    try {
      await client.initialize()
      const r = await client.request('thread/list', { limit: 15, sortKey: 'updated_at', archived: false }) as any
      const threads = r?.data || []
      if (!threads.length) { console.log('No saved sessions.') }
      else {
        console.log('Recent sessions:\n')
        for (let i = 0; i < threads.length; i++) {
          const t = threads[i]
          console.log(`  ${String(i + 1).padStart(2)}. ${t.name || t.preview || '(untitled)'}`)
          console.log(`      ${t.updated_at ? new Date(t.updated_at).toLocaleString() : ''}${t.cwd ? `  ${t.cwd}` : ''}`)
          console.log(`      codex-fork-ui --resume ${t.id}\n`)
        }
      }
    } catch (e) { console.error(`Failed: ${e}`) }
    finally { client.close(); process.exit(0) }
  })()
} else {
  render(<Root />)
}
