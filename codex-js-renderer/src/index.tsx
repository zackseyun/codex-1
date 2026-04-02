import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'

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
const SPINNER_INTERVAL_MS = 80
const VIEWPORT_SIZE = 24
const SCROLL_STEP = 6

// ─── AppServerClient ─────────────────────────────────────────────────────────

class AppServerClient {
  private child

  private nextId = 1
  private pending = new Map<
    number,
    {
      resolve: (value: JsonValue) => void
      reject: (reason: Error) => void
    }
  >()
  private notificationListeners = new Set<
    (message: JsonRpcMessage) => void
  >()
  private stderrListeners = new Set<(line: string) => void>()
  private exitListeners = new Set<(code: number | null) => void>()

  constructor(private readonly binary: string) {
    this.child = spawn(
      this.binary,
      ['app-server', '--listen', 'stdio://'],
      { stdio: ['pipe', 'pipe', 'pipe'], env: process.env },
    )

    const stdoutLines = readline.createInterface({
      input: this.child.stdout,
    })
    stdoutLines.on('line', line => {
      if (!line.trim()) return
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line)
      } catch {
        return
      }
      this.handleMessage(message)
    })

    const stderrLines = readline.createInterface({
      input: this.child.stderr,
    })
    stderrLines.on('line', line => {
      this.stderrListeners.forEach(fn => fn(line))
    })

    this.child.on('exit', code => {
      const err = new Error(
        `Codex app-server exited (${code ?? 'unknown'})`,
      )
      for (const p of this.pending.values()) p.reject(err)
      this.pending.clear()
      this.exitListeners.forEach(fn => fn(code))
    })
  }

  onNotification(fn: (msg: JsonRpcMessage) => void) {
    this.notificationListeners.add(fn)
    return () => this.notificationListeners.delete(fn)
  }

  onStderr(fn: (line: string) => void) {
    this.stderrListeners.add(fn)
    return () => this.stderrListeners.delete(fn)
  }

  onExit(fn: (code: number | null) => void) {
    this.exitListeners.add(fn)
    return () => this.exitListeners.delete(fn)
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'codex_fork_js_renderer',
        title: 'Codex Fork JS Renderer',
        version: '0.2.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    })
    this.notify('initialized')
  }

  request<T extends JsonValue = JsonValue>(
    method: string,
    params: JsonValue,
  ): Promise<T> {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: JsonValue) => void,
        reject,
      })
    })
  }

  notify(method: string, params?: JsonValue) {
    const payload =
      params === undefined
        ? JSON.stringify({ method })
        : JSON.stringify({ method, params })
    this.child.stdin.write(`${payload}\n`)
  }

  close() {
    this.child.kill('SIGTERM')
  }

  private handleMessage(msg: JsonRpcMessage) {
    if (
      typeof msg.id !== 'undefined' &&
      ('result' in msg || 'error' in msg)
    ) {
      const p = this.pending.get(Number(msg.id))
      if (!p) return
      this.pending.delete(Number(msg.id))
      if (msg.error) {
        p.reject(new Error(msg.error.message ?? 'Unknown JSON-RPC error'))
      } else {
        p.resolve(msg.result ?? null)
      }
      return
    }
    if (msg.method) {
      this.notificationListeners.forEach(fn => fn(msg))
    }
  }
}

// ─── CLI Utilities ───────────────────────────────────────────────────────────

function launchCwd() {
  return process.env.CODEX_FORK_UI_LAUNCH_CWD || process.cwd()
}

function backendBinary() {
  const configured = process.env.CODEX_FORK_BACKEND_BIN
  if (configured && existsSync(configured)) return configured
  return path.resolve(
    process.cwd(),
    '..',
    'codex-rs',
    'target',
    'debug',
    'codex',
  )
}

function parseArgs(argv: string[]) {
  let cwd = launchCwd()
  let model: string | undefined
  let resumeThreadId: string | undefined
  let resumeLast = false
  let listSessions = false
  let interactiveResume = false
  const prompt: string[] = []

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg) continue
    if (arg === '--cwd' || arg === '-C') {
      cwd = argv[i + 1] || cwd
      i++
    } else if (arg === '--model' || arg === '-m') {
      model = argv[i + 1] || model
      i++
    } else if (arg === '--resume') {
      resumeThreadId = argv[i + 1] || resumeThreadId
      i++
    } else if (arg === '--last') {
      resumeLast = true
    } else if (arg === '--list') {
      listSessions = true
    } else if (arg === 'resume' && i === 0) {
      // "codex-fork-ui resume" as a subcommand
      interactiveResume = true
    } else {
      prompt.push(arg)
    }
  }

  return {
    cwd,
    model,
    resumeThreadId,
    resumeLast,
    listSessions,
    interactiveResume,
    initialPrompt: prompt.join(' ').trim(),
  }
}

async function resolveResumeThreadId(
  client: AppServerClient,
  cwd: string,
) {
  const local = (await client.request('thread/list', {
    limit: 1,
    sortKey: 'updated_at',
    archived: false,
    cwd,
  })) as any
  const localId = local?.data?.[0]?.id
  if (localId) return localId as string

  const global = (await client.request('thread/list', {
    limit: 1,
    sortKey: 'updated_at',
    archived: false,
  })) as any
  return (global?.data?.[0]?.id as string | undefined) || undefined
}

// ─── Text Utilities ──────────────────────────────────────────────────────────

function firstSentence(text: string, maxLen = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const match = clean.match(/^[^.!?\n]+[.!?]?/)
  const sentence = match ? match[0].trim() : clean
  return sentence.length > maxLen
    ? sentence.slice(0, maxLen - 1) + '…'
    : sentence
}

function truncate(text: string, maxLen = 120): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > maxLen
    ? clean.slice(0, maxLen - 1) + '…'
    : clean
}

function summarizeShellBrief(command: string): string {
  const steps = command
    .split(/[;&|]+/)
    .map(s => s.trim())
    .filter(Boolean)
  if (!steps.length) return command
  const first = steps[0].split(/\s+/).slice(0, 6).join(' ')
  return steps.length === 1 ? first : `${first} (+${steps.length - 1} more)`
}

// ─── Intent Synthesis ────────────────────────────────────────────────────────

function synthesizeCommandIntent(item: any): {
  intent: string
  action: string
  kind: EntryKind
} {
  const actions: any[] = Array.isArray(item.commandActions)
    ? item.commandActions
    : []
  const raw = String(item.command || '')
  const lower = raw.toLowerCase()

  // Read files
  if (actions.length && actions.every((a: any) => a.type === 'read')) {
    const files = actions
      .map((a: any) => path.basename(a.path || a.name || 'file'))
      .slice(0, 4)
    const filesStr = files.join(', ')
    return {
      intent: `Examining ${filesStr}`,
      action: `read ${filesStr}`,
      kind: 'research',
    }
  }

  // Search
  if (actions.length && actions.every((a: any) => a.type === 'search')) {
    const query = actions.find((a: any) => a.query)?.query || 'pattern'
    const searchPath = actions.find((a: any) => a.path)?.path
    const loc = searchPath ? ` in ${searchPath}` : ''
    return {
      intent: `Looking for "${query}"${loc}`,
      action: `search "${query}"${loc}`,
      kind: 'research',
    }
  }

  // List files
  if (
    actions.length &&
    actions.every((a: any) => a.type === 'listFiles')
  ) {
    const dir = actions[0]?.path || '.'
    return {
      intent: `Exploring ${dir} structure`,
      action: `list ${dir}`,
      kind: 'research',
    }
  }

  // Mixed read/search/list
  if (
    actions.length &&
    actions.every((a: any) =>
      ['read', 'search', 'listFiles'].includes(a.type),
    )
  ) {
    return {
      intent: 'Investigating project structure',
      action: summarizeShellBrief(raw),
      kind: 'research',
    }
  }

  // Git commands
  if (/^git\s+(status|diff|log|branch|rev-parse|show)/.test(lower)) {
    const intents: Record<string, string> = {
      status: 'Checking for uncommitted changes',
      diff: 'Reviewing current changes',
      log: 'Looking at recent commit history',
      branch: 'Checking current branch',
      show: 'Inspecting a commit',
    }
    const sub = lower.split(/\s+/)[1] || ''
    return {
      intent: intents[sub] || 'Checking repository state',
      action: summarizeShellBrief(raw),
      kind: 'repository',
    }
  }

  // Git write operations
  if (/^git\s+(add|commit|push|merge|rebase|checkout|stash)/.test(lower)) {
    return {
      intent: `Running git ${lower.split(/\s+/)[1]}`,
      action: summarizeShellBrief(raw),
      kind: 'repository',
    }
  }

  // Tests
  if (
    /\b(pytest|jest|vitest|npm test|pnpm test|yarn test|cargo test|go test|xcodebuild test)\b/.test(
      lower,
    )
  ) {
    return {
      intent: 'Running tests to verify changes',
      action: summarizeShellBrief(raw),
      kind: 'validation',
    }
  }

  // Build / compile
  if (
    /\b(cargo build|npm run build|pnpm build|yarn build|tsc|gradle|make|cmake)\b/.test(
      lower,
    )
  ) {
    return {
      intent: 'Building to check for errors',
      action: summarizeShellBrief(raw),
      kind: 'validation',
    }
  }

  // Lint / format
  if (/\b(eslint|prettier|rustfmt|gofmt|black|ruff)\b/.test(lower)) {
    return {
      intent: 'Checking code style',
      action: summarizeShellBrief(raw),
      kind: 'validation',
    }
  }

  // Install
  if (
    /\b(npm install|pnpm install|yarn add|pip install|cargo add)\b/.test(
      lower,
    )
  ) {
    return {
      intent: 'Installing dependencies',
      action: summarizeShellBrief(raw),
      kind: 'execution',
    }
  }

  // Default shell
  return {
    intent: summarizeShellBrief(raw),
    action: summarizeShellBrief(raw),
    kind: 'execution',
  }
}

function itemToFeedEntry(item: any): FeedEntry | null {
  if (!item || !item.type) return null
  if (item.type === 'userMessage' || item.type === 'hookPrompt') return null

  if (item.type === 'plan') {
    const text = String(item.text || '').trim()
    if (!text) return null
    return {
      id: item.id,
      intent: firstSentence(text),
      action:
        text.split('\n').length > 1
          ? `${text.split('\n').filter(Boolean).length} steps`
          : undefined,
      kind: 'plan',
      timestamp: Date.now(),
      fullText: text,
    }
  }

  if (item.type === 'reasoning') {
    const text = Array.isArray(item.summary)
      ? item.summary.join('\n')
      : String(item.content || '')
    const summary = firstSentence(text)
    if (!summary) return null
    return {
      id: item.id,
      intent: summary,
      kind: 'reasoning',
      timestamp: Date.now(),
      fullText: text,
    }
  }

  if (item.type === 'agentMessage') {
    const text = String(item.text || '').trim()
    if (!text) return null
    return {
      id: item.id,
      intent: text,
      kind: 'response',
      timestamp: Date.now(),
      fullText: text,
    }
  }

  if (item.type === 'commandExecution') {
    const { intent, action, kind } = synthesizeCommandIntent(item)
    const failed =
      item.status === 'failed' || item.status === 'declined'
    const errorOutput =
      failed && item.aggregatedOutput
        ? truncate(String(item.aggregatedOutput).trim(), 200)
        : undefined
    return {
      id: item.id,
      intent,
      action,
      result: errorOutput,
      kind,
      timestamp: Date.now(),
      isError: failed,
      isWarning: failed,
    }
  }

  if (item.type === 'fileChange') {
    const changes: any[] = Array.isArray(item.changes)
      ? item.changes
      : []
    const files = changes
      .map((c: any) =>
        path.basename(c.path || c.filePath || c.file_name || ''),
      )
      .filter(Boolean)
    const added = changes.reduce(
      (s: number, c: any) => s + (c.linesAdded || 0),
      0,
    )
    const removed = changes.reduce(
      (s: number, c: any) => s + (c.linesRemoved || 0),
      0,
    )
    const fileList = files.length
      ? files.slice(0, 3).join(', ') +
        (files.length > 3 ? ` +${files.length - 3} more` : '')
      : `${changes.length} files`
    const diffNote =
      added || removed ? ` (+${added} −${removed})` : ''
    return {
      id: item.id,
      intent: `Updating ${fileList}`,
      action: `modified ${fileList}${diffNote}`,
      kind: 'edit',
      timestamp: Date.now(),
    }
  }

  if (item.type === 'mcpToolCall') {
    const server = item.server || 'tool'
    const tool = item.tool || 'call'
    return {
      id: item.id,
      intent: `Using ${server}.${tool}`,
      action: `${server}.${tool}`,
      kind: 'external',
      timestamp: Date.now(),
      isError: item.status === 'failed',
    }
  }

  if (item.type === 'webSearch') {
    return {
      id: item.id,
      intent: `Researching: ${item.query || 'web search'}`,
      action: `search "${item.query || ''}"`,
      kind: 'external',
      timestamp: Date.now(),
    }
  }

  if (
    item.type === 'enteredReviewMode' ||
    item.type === 'exitedReviewMode'
  ) {
    return {
      id: item.id,
      intent:
        item.type === 'enteredReviewMode'
          ? 'Entering code review'
          : 'Finished code review',
      kind: 'review',
      timestamp: Date.now(),
    }
  }

  if (item.type === 'contextCompaction') {
    return {
      id: item.id,
      intent: 'Compacting context to stay within limits',
      kind: 'session',
      timestamp: Date.now(),
    }
  }

  return null
}

// ─── Slash Commands ──────────────────────────────────────────────────────────

type SlashCommandDef = {
  name: string
  aliases?: string[]
  description: string
  needsClient?: boolean
  availableDuringTask?: boolean
}

const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: 'help', description: 'list available commands', availableDuringTask: true },
  { name: 'resume', description: 'resume a saved session', needsClient: true },
  { name: 'new', description: 'start a new session', needsClient: true },
  { name: 'clear', description: 'clear the feed', availableDuringTask: true },
  { name: 'diff', description: 'show git diff', availableDuringTask: true },
  { name: 'compact', description: 'compact context to save token space', needsClient: true },
  { name: 'status', description: 'show session info', availableDuringTask: true },
  { name: 'copy', description: 'copy last response to clipboard', availableDuringTask: true },
  { name: 'logout', description: 'log out and quit', needsClient: true },
  { name: 'quit', description: 'exit', aliases: ['exit'], availableDuringTask: true },
]

function parseSlashCommand(input: string): { command: string; args: string } | null {
  const trimmed = input.trim()
  if (!trimmed.startsWith('/')) return null
  const spaceIdx = trimmed.indexOf(' ')
  const command = spaceIdx === -1
    ? trimmed.slice(1).toLowerCase()
    : trimmed.slice(1, spaceIdx).toLowerCase()
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim()
  if (!command) return null
  return { command, args }
}

function findSlashCommand(name: string): SlashCommandDef | null {
  for (const cmd of SLASH_COMMANDS) {
    if (cmd.name === name) return cmd
    if (cmd.aliases?.includes(name)) return cmd
  }
  return null
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

function useSpinner(active: boolean): string {
  const [frame, setFrame] = useState(0)
  useEffect(() => {
    if (!active) return
    const timer = setInterval(
      () => setFrame(f => (f + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    )
    return () => clearInterval(timer)
  }, [active])
  return active ? (SPINNER_FRAMES[frame] ?? '⠋') : ''
}

function useElapsed(startTime: number | null): string {
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    if (startTime === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startTime])
  if (startTime === null) return ''
  const total = Math.floor((now - startTime) / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

// ─── Components ──────────────────────────────────────────────────────────────

function Divider({ dim = false }: { dim?: boolean }) {
  const w = process.stdout.columns || 80
  return (
    <Text color={dim ? 'gray' : 'gray'} dimColor={dim}>
      {'─'.repeat(Math.max(20, Math.min(w - 4, 88)))}
    </Text>
  )
}

function EntryView({ entry }: { entry: FeedEntry }) {
  // ── User message ──
  if (entry.kind === 'user') {
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={0}>
        <Text>
          <Text color="gray" dimColor>
            {'  ▍ '}
          </Text>
          <Text color="white" bold>
            {entry.intent}
          </Text>
        </Text>
      </Box>
    )
  }

  // ── Agent response ──
  if (entry.kind === 'response') {
    const text = entry.fullText || entry.intent
    const lines = text.split('\n')
    return (
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {lines.map((line, i) => (
          <Text key={i}>{'  '}{line}</Text>
        ))}
      </Box>
    )
  }

  // ── Session info ──
  if (entry.kind === 'session') {
    return (
      <Box marginTop={0}>
        <Text color="gray" dimColor>
          {'  '}{entry.intent}
        </Text>
      </Box>
    )
  }

  // ── Error entries ──
  if (entry.isError) {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text>
          <Text color="yellow">{'  ⚠ '}</Text>
          <Text color="yellow">{entry.intent}</Text>
        </Text>
        {entry.result && (
          <Text color="gray" dimColor>
            {'    '}{truncate(entry.result, 180)}
          </Text>
        )}
      </Box>
    )
  }

  // ── Plan ──
  if (entry.kind === 'plan') {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text>
          <Text color="gray" dimColor>{'  ◇ '}</Text>
          <Text>{entry.intent}</Text>
        </Text>
        {entry.action && (
          <Text color="gray" dimColor>
            {'    '}{entry.action}
          </Text>
        )}
      </Box>
    )
  }

  // ── Reasoning ──
  if (entry.kind === 'reasoning') {
    return (
      <Box flexDirection="column" marginTop={0}>
        <Text>
          <Text color="gray" dimColor>{'  ◇ '}</Text>
          <Text color="gray">{entry.intent}</Text>
        </Text>
      </Box>
    )
  }

  // ── Action entries (research, edit, validation, execution, etc.) ──
  const hasAction = !!entry.action
  const hasResult = !!entry.result

  return (
    <Box flexDirection="column" marginTop={0}>
      <Text>
        {'  '}
        <Text>{entry.intent}</Text>
      </Text>
      {hasAction && (
        <Text color="gray" dimColor>
          {'  '}
          {hasResult ? '│' : '└'} {entry.action}
        </Text>
      )}
      {hasResult && (
        <Text color={entry.isWarning ? 'yellow' : 'gray'} dimColor={!entry.isWarning}>
          {'  └ '}{entry.result}
        </Text>
      )}
    </Box>
  )
}

function NowPanel({
  activeItem,
  streamingText,
  threadStatus,
  gitBranch,
  model,
  errorText,
}: {
  activeItem: ActiveItem | null
  streamingText: string
  threadStatus: string
  gitBranch: string
  model?: string
  errorText: string | null
}) {
  const isActive = !!activeItem || threadStatus === 'active'
  const spinner = useSpinner(isActive)
  const elapsed = useElapsed(activeItem?.startTime ?? null)
  const w = process.stdout.columns || 80

  // ── Error display ──
  const errorLine = errorText ? (
    <Text>
      <Text color="yellow">{'  ⚠ '}</Text>
      <Text color="yellow">{truncate(errorText, w - 8)}</Text>
    </Text>
  ) : null

  // ── Idle state ──
  if (!activeItem && (threadStatus === 'idle' || threadStatus === 'unknown')) {
    const parts = ['Ready']
    if (gitBranch) parts.push(gitBranch)
    if (model) parts.push(model)
    return (
      <Box flexDirection="column">
        <Divider dim />
        {errorLine}
        <Text>
          <Text color="green">{'  ● '}</Text>
          <Text color="gray">{parts.join(' · ')}</Text>
        </Text>
      </Box>
    )
  }

  // ── Starting state ──
  if (!activeItem && threadStatus === 'starting') {
    return (
      <Box flexDirection="column">
        <Divider dim />
        {errorLine}
        <Text color="gray">{'  '}Starting session...</Text>
      </Box>
    )
  }

  // ── Active state with spinner + timer + live output ──
  const intentText = activeItem?.entry.intent || 'Working...'

  // Build the live output preview (last 3 lines from command output or streaming)
  let previewLines: string[] = []
  if (activeItem?.outputLines.length) {
    previewLines = activeItem.outputLines.slice(-3)
  } else if (streamingText) {
    previewLines = streamingText
      .split('\n')
      .filter(l => l.trim())
      .slice(-3)
  }

  // Label based on active entry kind
  let stateLabel = ''
  if (activeItem?.entry.kind === 'reasoning') stateLabel = 'Thinking'
  else if (activeItem?.entry.kind === 'plan') stateLabel = 'Planning'
  else if (activeItem?.entry.kind === 'response') stateLabel = 'Responding'
  else if (activeItem?.entry.kind === 'research') stateLabel = 'Researching'
  else if (activeItem?.entry.kind === 'validation') stateLabel = 'Validating'
  else if (activeItem?.entry.kind === 'edit') stateLabel = 'Editing'
  else if (activeItem?.entry.kind === 'execution') stateLabel = 'Executing'
  else if (activeItem?.entry.kind === 'repository') stateLabel = 'Git'
  else stateLabel = 'Working'

  const timerStr = elapsed ? `  ${elapsed}` : ''
  const maxWidth = w - 10 - timerStr.length
  const displayIntent =
    intentText.length > maxWidth
      ? intentText.slice(0, maxWidth - 1) + '…'
      : intentText
  const pad = Math.max(
    1,
    w - 6 - displayIntent.length - timerStr.length,
  )

  return (
    <Box flexDirection="column">
      <Divider dim />
      {errorLine}
      <Text>
        <Text color="cyan">{'  '}{spinner} </Text>
        <Text color="white">{displayIntent}</Text>
        <Text color="gray" dimColor>
          {' '.repeat(pad)}{timerStr}
        </Text>
      </Text>
      {activeItem?.entry.action &&
        activeItem.entry.action !== activeItem.entry.intent && (
          <Text color="gray" dimColor>
            {'    '}
            {truncate(activeItem.entry.action, w - 8)}
          </Text>
        )}
      {previewLines.map((line, i) => (
        <Text key={i} color="gray" dimColor>
          {'    '}
          {line.length > w - 8 ? line.slice(0, w - 9) + '…' : line}
        </Text>
      ))}
    </Box>
  )
}

function Composer({
  value,
  isActive,
}: {
  value: string
  isActive: boolean
}) {
  return (
    <Box flexDirection="column" marginTop={0}>
      <Divider dim />
      <Box>
        {isActive ? (
          <Text color="cyan">{'⚡ › '}</Text>
        ) : (
          <Text color="white">{'› '}</Text>
        )}
        <Text>
          {value || (
            <Text color="gray" dimColor>
              {isActive
                ? 'type to steer the current turn'
                : 'type a prompt to begin'}
            </Text>
          )}
        </Text>
        <Text color="white">{'█'}</Text>
      </Box>
    </Box>
  )
}

function ScrollHint({
  scrollOffset,
  totalEntries,
  viewportSize,
}: {
  scrollOffset: number
  totalEntries: number
  viewportSize: number
}) {
  if (totalEntries <= viewportSize) return null
  const atBottom = scrollOffset + viewportSize >= totalEntries
  const atTop = scrollOffset === 0
  return (
    <Box justifyContent="space-between">
      <Text color="gray" dimColor>
        {!atTop
          ? `  ↑ ${scrollOffset} more above`
          : ''}
      </Text>
      <Text color="gray" dimColor>
        {!atBottom
          ? `${totalEntries - scrollOffset - viewportSize} more below ↓  `
          : ''}
      </Text>
    </Box>
  )
}

// ─── App ─────────────────────────────────────────────────────────────────────

function App() {
  const { exit } = useApp()
  const args = useMemo(() => parseArgs(process.argv.slice(2)), [])

  // All entries (full history)
  const [entries, setEntries] = useState<FeedEntry[]>([])

  // Active item (shown in Now panel)
  const [activeItem, setActiveItem] = useState<ActiveItem | null>(null)
  const activeItemRef = useRef<ActiveItem | null>(null)

  // Streaming text (agent message / reasoning deltas)
  const [streamingText, setStreamingText] = useState('')

  // Session state
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threadStatus, setThreadStatus] = useState('starting')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)

  // UI state
  const [composer, setComposer] = useState('')
  const [errorText, setErrorText] = useState<string | null>(null)
  const [gitBranch, setGitBranch] = useState('')

  // Scroll state
  const [scrollOffset, setScrollOffset] = useState(0)
  const [autoScroll, setAutoScroll] = useState(true)

  const initialPromptSent = useRef(false)
  const clientRef = useRef<AppServerClient | null>(null)

  // Keep ref in sync with state
  useEffect(() => {
    activeItemRef.current = activeItem
  }, [activeItem])

  // Push an entry to history
  const pushEntry = useCallback((entry: FeedEntry) => {
    setEntries(prev => [...prev, entry])
  }, [])

  // Flush current active item to history
  const flushActive = useCallback(() => {
    const current = activeItemRef.current
    if (current) {
      setEntries(prev => [...prev, current.entry])
      activeItemRef.current = null
    }
    setActiveItem(null)
  }, [])

  // Auto-scroll: when entries change, scroll to bottom if autoScroll is on
  useEffect(() => {
    if (autoScroll) {
      const maxOffset = Math.max(0, entries.length - VIEWPORT_SIZE)
      setScrollOffset(maxOffset)
    }
  }, [entries.length, autoScroll])

  // ── Backend connection ──
  useEffect(() => {
    const binary = backendBinary()
    const client = new AppServerClient(binary)
    clientRef.current = client

    const unlisten = client.onNotification(message => {
      try {
        // ── Thread lifecycle ──
        if (message.method === 'thread/started') {
          const tid = (message.params as any)?.thread?.id
          if (tid) {
            setThreadId(tid)
            setThreadStatus('idle')
            pushEntry({
              id: `session-${tid}`,
              intent: `Session started`,
              kind: 'session',
              timestamp: Date.now(),
            })
          }
          return
        }

        if (message.method === 'thread/status/changed') {
          setThreadStatus(
            (message.params as any)?.status?.type || 'unknown',
          )
          return
        }

        // ── Turn lifecycle ──
        if (message.method === 'turn/started') {
          const turn = (message.params as any)?.turn
          setActiveTurnId(turn?.id || null)
          setThreadStatus('active')
          return
        }

        if (message.method === 'turn/completed') {
          flushActive()
          setActiveTurnId(null)
          setThreadStatus('idle')
          setStreamingText('')
          return
        }

        // ── Delta streams ──
        if (message.method === 'item/agentMessage/delta') {
          const delta = String(
            (message.params as any)?.delta || '',
          )
          setStreamingText(prev => prev + delta)
          return
        }

        if (
          message.method === 'item/reasoning/summaryTextDelta' ||
          message.method === 'item/plan/delta'
        ) {
          const delta = String(
            (message.params as any)?.delta || '',
          )
          setStreamingText(prev => prev + delta)
          return
        }

        if (
          message.method === 'item/commandExecution/outputDelta'
        ) {
          const delta = String(
            (message.params as any)?.delta || '',
          )
          if (delta && activeItemRef.current) {
            const newLines = delta.split('\n').filter(Boolean)
            const combined = [
              ...activeItemRef.current.outputLines,
              ...newLines,
            ].slice(-3)
            const updated = {
              ...activeItemRef.current,
              outputLines: combined,
            }
            activeItemRef.current = updated
            setActiveItem(updated)
          }
          return
        }

        // ── Item lifecycle ──
        if (message.method === 'item/started') {
          const item = (message.params as any)?.item
          const entry = itemToFeedEntry(item)
          if (entry) {
            // Flush previous active item to history
            flushActive()
            const newActive: ActiveItem = {
              entry,
              startTime: Date.now(),
              outputLines: [],
            }
            activeItemRef.current = newActive
            setActiveItem(newActive)
            setStreamingText('')
          }
          return
        }

        if (message.method === 'item/completed') {
          const item = (message.params as any)?.item
          const entry = itemToFeedEntry(item)
          if (entry) {
            pushEntry(entry)
            // Clear active if it matches
            if (activeItemRef.current?.entry.id === entry.id) {
              activeItemRef.current = null
              setActiveItem(null)
            }
            if (item?.type === 'agentMessage') {
              setStreamingText('')
            }
          }
          return
        }

        // ── Errors ──
        if (message.method === 'error') {
          const error = (message.params as any)?.error
          const msg = [error?.message, error?.additionalDetails]
            .filter(Boolean)
            .join(' · ')
          setErrorText(msg || 'Unknown error')
          pushEntry({
            id: `error-${Date.now()}`,
            intent: msg || 'Unknown error',
            kind: 'session',
            timestamp: Date.now(),
            isError: true,
            isWarning: true,
          })
        }
      } catch (err) {
        setErrorText(String(err))
      }
    })

    const unlistenExit = client.onExit(code => {
      setErrorText(`Backend exited (${code ?? 'unknown'})`)
    })

    // Initialize session
    ;(async () => {
      try {
        await client.initialize()
        const threadIdToResume =
          args.resumeThreadId ||
          (args.resumeLast
            ? await resolveResumeThreadId(client, args.cwd)
            : undefined)

        const response = threadIdToResume
          ? ((await client.request('thread/resume', {
              threadId: threadIdToResume,
              cwd: args.cwd,
              model: args.model ?? null,
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              persistExtendedHistory: true,
            })) as any)
          : ((await client.request('thread/start', {
              cwd: args.cwd,
              model: args.model ?? null,
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              experimentalRawEvents: false,
              persistExtendedHistory: true,
              serviceName: 'codex_fork_js_renderer',
            })) as any)

        if (response?.thread?.id) setThreadId(response.thread.id)
        if (threadIdToResume && response?.thread) {
          const summary =
            response.thread.name ||
            response.thread.preview ||
            threadIdToResume
          pushEntry({
            id: `resume-${threadIdToResume}`,
            intent: `Resumed: ${summary}`,
            kind: 'session',
            timestamp: Date.now(),
          })
        }
        if (
          (args.resumeLast || args.resumeThreadId) &&
          !threadIdToResume
        ) {
          setErrorText('No previous session found to resume')
        }
      } catch (err) {
        setErrorText(String(err))
      }
    })()

    return () => {
      unlisten()
      unlistenExit()
      client.close()
    }
  }, [args.cwd, args.model])

  // Auto-submit initial prompt
  useEffect(() => {
    if (
      initialPromptSent.current ||
      !threadId ||
      !args.initialPrompt
    )
      return
    initialPromptSent.current = true
    void submitPrompt(args.initialPrompt)
  }, [threadId, args.initialPrompt])

  // Git branch detection
  useEffect(() => {
    try {
      const branch = execFileSync(
        'git',
        ['-C', args.cwd, 'branch', '--show-current'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim()
      setGitBranch(branch)
    } catch {
      setGitBranch('')
    }
  }, [args.cwd])

  // ── Slash command handlers ──
  const handleSlashCommand = async (cmdName: string, cmdArgs: string) => {
    const client = clientRef.current
    const cmd = findSlashCommand(cmdName)

    if (!cmd) {
      pushEntry({
        id: `cmd-err-${Date.now()}`,
        intent: `Unknown command: /${cmdName}. Type /help for a list.`,
        kind: 'session',
        timestamp: Date.now(),
        isWarning: true,
      })
      return
    }

    // Check if command is available during active turn
    if (activeTurnId && !cmd.availableDuringTask) {
      pushEntry({
        id: `cmd-err-${Date.now()}`,
        intent: `/${cmd.name} is not available while a turn is active`,
        kind: 'session',
        timestamp: Date.now(),
        isWarning: true,
      })
      return
    }

    switch (cmd.name) {
      case 'help': {
        const lines = SLASH_COMMANDS
          .map(c => `  /${c.name.padEnd(10)} ${c.description}`)
          .join('\n')
        pushEntry({
          id: `help-${Date.now()}`,
          intent: 'Available commands:',
          kind: 'response',
          timestamp: Date.now(),
          fullText: `Available commands:\n${lines}`,
        })
        break
      }

      case 'resume': {
        if (!client) break
        try {
          // If an arg is provided, resume that specific thread
          if (cmdArgs) {
            const response = (await client.request('thread/resume', {
              threadId: cmdArgs,
              cwd: args.cwd,
              model: args.model ?? null,
              approvalPolicy: 'never',
              sandbox: 'danger-full-access',
              persistExtendedHistory: true,
            })) as any
            if (response?.thread?.id) {
              setThreadId(response.thread.id)
              setThreadStatus('idle')
              pushEntry({
                id: `resume-${Date.now()}`,
                intent: `Resumed: ${response.thread.name || response.thread.preview || cmdArgs}`,
                kind: 'session',
                timestamp: Date.now(),
              })
            }
          } else {
            // List recent threads
            const result = (await client.request('thread/list', {
              limit: 10,
              sortKey: 'updated_at',
              archived: false,
            })) as any
            const threads = result?.data || []
            if (!threads.length) {
              pushEntry({
                id: `resume-none-${Date.now()}`,
                intent: 'No saved sessions found.',
                kind: 'session',
                timestamp: Date.now(),
              })
            } else {
              const listing = threads
                .map((t: any, i: number) => {
                  const name = t.name || t.preview || t.id
                  const date = t.updated_at
                    ? new Date(t.updated_at).toLocaleDateString()
                    : ''
                  const current = t.id === threadId ? ' (current)' : ''
                  return `  ${i + 1}. ${truncate(name, 60)}${current}  ${date}\n     /resume ${t.id}`
                })
                .join('\n')
              pushEntry({
                id: `resume-list-${Date.now()}`,
                intent: 'Recent sessions — use /resume <id> to switch:',
                kind: 'response',
                timestamp: Date.now(),
                fullText: `Recent sessions:\n${listing}`,
              })
            }
          }
        } catch (err) {
          setErrorText(`Resume failed: ${String(err)}`)
        }
        break
      }

      case 'new': {
        if (!client) break
        try {
          flushActive()
          setStreamingText('')
          setActiveTurnId(null)
          const response = (await client.request('thread/start', {
            cwd: args.cwd,
            model: args.model ?? null,
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            experimentalRawEvents: false,
            persistExtendedHistory: true,
            serviceName: 'codex_fork_js_renderer',
          })) as any
          if (response?.thread?.id) {
            setThreadId(response.thread.id)
            setThreadStatus('idle')
            setEntries([])
            pushEntry({
              id: `session-${response.thread.id}`,
              intent: 'New session started',
              kind: 'session',
              timestamp: Date.now(),
            })
          }
        } catch (err) {
          setErrorText(`New session failed: ${String(err)}`)
        }
        break
      }

      case 'clear': {
        setEntries([])
        setErrorText(null)
        setScrollOffset(0)
        setAutoScroll(true)
        break
      }

      case 'diff': {
        try {
          const diff = execFileSync(
            'git',
            ['-C', args.cwd, 'diff', '--stat', 'HEAD'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim()
          const untrackedRaw = execFileSync(
            'git',
            ['-C', args.cwd, 'ls-files', '--others', '--exclude-standard'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
          ).trim()
          const untracked = untrackedRaw
            ? `\nUntracked:\n${untrackedRaw}`
            : ''
          const output = diff || 'No changes.'
          pushEntry({
            id: `diff-${Date.now()}`,
            intent: 'Git diff:',
            kind: 'response',
            timestamp: Date.now(),
            fullText: `${output}${untracked}`,
          })
        } catch {
          pushEntry({
            id: `diff-err-${Date.now()}`,
            intent: 'Not a git repository or git not available',
            kind: 'session',
            timestamp: Date.now(),
            isWarning: true,
          })
        }
        break
      }

      case 'compact': {
        if (!client || !threadId) break
        try {
          await client.notify('thread/compact', { threadId })
          pushEntry({
            id: `compact-${Date.now()}`,
            intent: 'Context compaction requested',
            kind: 'session',
            timestamp: Date.now(),
          })
        } catch (err) {
          setErrorText(`Compact failed: ${String(err)}`)
        }
        break
      }

      case 'status': {
        const parts = [
          `Thread: ${threadId || 'none'}`,
          `Status: ${threadStatus}`,
          `Branch: ${gitBranch || 'n/a'}`,
          `Model: ${args.model || 'default'}`,
          `CWD: ${args.cwd}`,
          `Entries: ${entries.length}`,
        ]
        pushEntry({
          id: `status-${Date.now()}`,
          intent: 'Session status:',
          kind: 'response',
          timestamp: Date.now(),
          fullText: parts.join('\n'),
        })
        break
      }

      case 'copy': {
        const lastResponse = [...entries]
          .reverse()
          .find(e => e.kind === 'response')
        if (!lastResponse) {
          pushEntry({
            id: `copy-err-${Date.now()}`,
            intent: 'Nothing to copy — no responses yet.',
            kind: 'session',
            timestamp: Date.now(),
          })
          break
        }
        try {
          const text = lastResponse.fullText || lastResponse.intent
          execFileSync('pbcopy', [], {
            input: text,
            stdio: ['pipe', 'ignore', 'ignore'],
          })
          pushEntry({
            id: `copy-${Date.now()}`,
            intent: 'Copied last response to clipboard',
            kind: 'session',
            timestamp: Date.now(),
          })
        } catch {
          pushEntry({
            id: `copy-err-${Date.now()}`,
            intent: 'Failed to copy — clipboard not available',
            kind: 'session',
            timestamp: Date.now(),
            isWarning: true,
          })
        }
        break
      }

      case 'logout': {
        if (!client) break
        try {
          await client.request('auth/logout', {})
        } catch {
          // May not be supported — that's ok
        }
        pushEntry({
          id: `logout-${Date.now()}`,
          intent: 'Logged out.',
          kind: 'session',
          timestamp: Date.now(),
        })
        setTimeout(() => exit(), 500)
        break
      }

      case 'quit': {
        exit()
        break
      }
    }
  }

  const submitPrompt = async (promptText: string) => {
    const client = clientRef.current
    if (!client || !threadId) return
    const text = promptText.trim()
    if (!text) return

    // Check for slash commands
    const parsed = parseSlashCommand(text)
    if (parsed) {
      setComposer('')
      pushEntry({
        id: `user-${Date.now()}`,
        intent: text,
        kind: 'user',
        timestamp: Date.now(),
      })
      setAutoScroll(true)
      await handleSlashCommand(parsed.command, parsed.args)
      return
    }

    // Add user message to feed
    pushEntry({
      id: `user-${Date.now()}`,
      intent: text,
      kind: 'user',
      timestamp: Date.now(),
    })
    setComposer('')
    setAutoScroll(true)

    try {
      if (activeTurnId) {
        await client.request('turn/steer', {
          threadId,
          expectedTurnId: activeTurnId,
          input: [{ type: 'text', text, text_elements: [] }],
        })
      } else {
        const response = (await client.request('turn/start', {
          threadId,
          input: [{ type: 'text', text, text_elements: [] }],
          sandboxPolicy: { type: 'dangerFullAccess' },
          approvalPolicy: 'never',
          model: args.model ?? null,
          effort: 'medium',
        })) as any
        setActiveTurnId(response?.turn?.id || null)
      }
      setThreadStatus('active')
    } catch (err) {
      setErrorText(String(err))
    }
  }

  // ── Input handling ──
  useInput((input, key) => {
    // Quit
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    // Scroll up
    if (key.ctrl && input === 'u') {
      setAutoScroll(false)
      setScrollOffset(prev => Math.max(0, prev - SCROLL_STEP))
      return
    }

    // Scroll down
    if (key.ctrl && input === 'd') {
      setAutoScroll(false)
      setScrollOffset(prev => {
        const max = Math.max(0, entries.length - VIEWPORT_SIZE)
        const next = Math.min(max, prev + SCROLL_STEP)
        if (next >= max) setAutoScroll(true)
        return next
      })
      return
    }

    // Page up
    if (key.pageUp || (key.upArrow && key.shift)) {
      setAutoScroll(false)
      setScrollOffset(prev => Math.max(0, prev - SCROLL_STEP))
      return
    }

    // Page down
    if (key.pageDown || (key.downArrow && key.shift)) {
      setAutoScroll(false)
      setScrollOffset(prev => {
        const max = Math.max(0, entries.length - VIEWPORT_SIZE)
        const next = Math.min(max, prev + SCROLL_STEP)
        if (next >= max) setAutoScroll(true)
        return next
      })
      return
    }

    // Jump to bottom
    if (key.ctrl && input === 'g') {
      setAutoScroll(true)
      setScrollOffset(Math.max(0, entries.length - VIEWPORT_SIZE))
      return
    }

    // Submit prompt
    if (key.return) {
      void submitPrompt(composer)
      return
    }

    // Delete character
    if (key.backspace || key.delete) {
      setComposer(prev => prev.slice(0, -1))
      return
    }

    // Clear input
    if (key.escape) {
      setComposer('')
      return
    }

    // Type character
    if (!key.ctrl && !key.meta && input) {
      setComposer(prev => prev + input)
    }
  })

  // ── Visible entries (viewport window) ──
  const visibleEntries = useMemo(() => {
    const start = Math.max(0, scrollOffset)
    return entries.slice(start, start + VIEWPORT_SIZE)
  }, [entries, scrollOffset])

  // ── Shortcut help ──
  const helpText =
    entries.length > VIEWPORT_SIZE
      ? '/help commands · Ctrl+U/D scroll · Ctrl+G bottom · Ctrl+C quit'
      : '/help commands · Ctrl+C quit'

  return (
    <Box flexDirection="column">
      {/* ── Header ── */}
      <Box marginBottom={0}>
        <Text color="gray" dimColor>
          {'  codex-fork'}
          {gitBranch ? ` · ${gitBranch}` : ''}
          {args.model ? ` · ${args.model}` : ''}
        </Text>
      </Box>
      <Divider dim />

      {/* ── Scroll hint (top) ── */}
      <ScrollHint
        scrollOffset={scrollOffset}
        totalEntries={entries.length}
        viewportSize={VIEWPORT_SIZE}
      />

      {/* ── Feed ── */}
      {visibleEntries.length > 0 ? (
        visibleEntries.map(entry => (
          <EntryView key={entry.id} entry={entry} />
        ))
      ) : (
        <Text color="gray" dimColor>
          {'  '}No activity yet.
        </Text>
      )}

      {/* ── Now panel ── */}
      <NowPanel
        activeItem={activeItem}
        streamingText={streamingText}
        threadStatus={threadStatus}
        gitBranch={gitBranch}
        model={args.model}
        errorText={errorText}
      />

      {/* ── Composer ── */}
      <Composer value={composer} isActive={!!activeTurnId} />

      {/* ── Help ── */}
      <Text color="gray" dimColor>
        {'  '}{helpText}
      </Text>
    </Box>
  )
}

// ─── Resume Picker ───────────────────────────────────────────────────────────

type ThreadInfo = {
  id: string
  name: string
  date: string
  cwd: string
}

function ResumePicker({ onSelect }: { onSelect: (threadId: string) => void }) {
  const { exit } = useApp()
  const args = useMemo(() => parseArgs(process.argv.slice(2)), [])
  const [threads, setThreads] = useState<ThreadInfo[]>([])
  const [selected, setSelected] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const clientRef = useRef<AppServerClient | null>(null)

  useEffect(() => {
    const binary = backendBinary()
    const client = new AppServerClient(binary)
    clientRef.current = client

    ;(async () => {
      try {
        await client.initialize()
        const result = (await client.request('thread/list', {
          limit: 15,
          sortKey: 'updated_at',
          archived: false,
        })) as any
        const data = result?.data || []
        setThreads(
          data.map((t: any) => ({
            id: t.id,
            name: t.name || t.preview || '(untitled)',
            date: t.updated_at
              ? new Date(t.updated_at).toLocaleString()
              : '',
            cwd: t.cwd || '',
          })),
        )
      } catch (err) {
        setError(String(err))
      } finally {
        setLoading(false)
      }
    })()

    return () => client.close()
  }, [])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      clientRef.current?.close()
      exit()
      return
    }
    if (key.escape) {
      clientRef.current?.close()
      exit()
      return
    }
    if (key.upArrow) {
      setSelected(prev => Math.max(0, prev - 1))
      return
    }
    if (key.downArrow) {
      setSelected(prev => Math.min(threads.length - 1, prev + 1))
      return
    }
    if (key.return && threads.length > 0) {
      const thread = threads[selected]
      if (thread) {
        clientRef.current?.close()
        onSelect(thread.id)
      }
      return
    }
    // Number keys for quick selection
    const num = parseInt(input, 10)
    if (num >= 1 && num <= threads.length) {
      const thread = threads[num - 1]
      if (thread) {
        clientRef.current?.close()
        onSelect(thread.id)
      }
    }
  })

  if (loading) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">Loading sessions...</Text>
      </Box>
    )
  }

  if (error) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="yellow">Failed to load sessions: {error}</Text>
      </Box>
    )
  }

  if (!threads.length) {
    return (
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text color="gray">No saved sessions found.</Text>
        <Text color="gray" dimColor>Press Esc to start a new session.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={2} paddingY={1}>
      <Text color="white" bold>Resume a session</Text>
      <Text color="gray" dimColor>
        Arrow keys to navigate · Enter to select · Number for quick pick · Esc to cancel
      </Text>
      <Text>{''}</Text>
      {threads.map((t, i) => {
        const isSelected = i === selected
        return (
          <Box key={t.id} flexDirection="column" marginBottom={0}>
            <Text>
              <Text color={isSelected ? 'cyan' : 'gray'}>
                {isSelected ? '  ❯ ' : '    '}
              </Text>
              <Text color={isSelected ? 'white' : 'gray'} bold={isSelected}>
                {i + 1}. {truncate(t.name, 60)}
              </Text>
            </Text>
            <Text color="gray" dimColor>
              {'      '}{t.date}{t.cwd ? `  ${t.cwd}` : ''}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

// ─── Entry Point ─────────────────────────────────────────────────────────────

function Root() {
  const cliArgs = useMemo(() => parseArgs(process.argv.slice(2)), [])
  const [resumeThreadId, setResumeThreadId] = useState<string | null>(null)
  const [showPicker, setShowPicker] = useState(cliArgs.interactiveResume)

  if (showPicker && !resumeThreadId) {
    return (
      <ResumePicker
        onSelect={(id) => {
          setResumeThreadId(id)
          setShowPicker(false)
        }}
      />
    )
  }

  // If we got a thread ID from the picker, override the args
  if (resumeThreadId) {
    // Patch process.argv to inject --resume
    const patchedArgv = [...process.argv.slice(2).filter(a => a !== 'resume'), '--resume', resumeThreadId]
    // Re-render App — it will read the resume thread ID
    return <AppWithOverride resumeOverride={resumeThreadId} />
  }

  return <App />
}

function AppWithOverride({ resumeOverride }: { resumeOverride: string }) {
  // This is the App component but with the resume thread ID injected.
  // We re-use App by setting an env var that parseArgs will read.
  // Simpler: just render App and override via a ref.
  // Actually, the cleanest way is to make App accept an optional override prop.
  // But to minimize changes, let's just re-exec with the right args.

  // Re-launch the process with --resume <id>
  useEffect(() => {
    const currentArgs = process.argv.slice(2).filter(a => a !== 'resume')
    const binary = process.argv[0]
    const script = process.argv[1]
    const child = spawn(binary!, [script!, ...currentArgs, '--resume', resumeOverride], {
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => process.exit(code ?? 0))
  }, [resumeOverride])

  return (
    <Box paddingX={2} paddingY={1}>
      <Text color="gray">Resuming session...</Text>
    </Box>
  )
}

const cliArgs = parseArgs(process.argv.slice(2))

if (cliArgs.listSessions) {
  ;(async () => {
    const binary = backendBinary()
    const client = new AppServerClient(binary)
    try {
      await client.initialize()
      const result = (await client.request('thread/list', {
        limit: 15,
        sortKey: 'updated_at',
        archived: false,
      })) as any
      const threads = result?.data || []
      if (!threads.length) {
        console.log('No saved sessions found.')
      } else {
        console.log('Recent sessions:\n')
        for (let i = 0; i < threads.length; i++) {
          const t = threads[i]
          const name = t.name || t.preview || '(untitled)'
          const date = t.updated_at
            ? new Date(t.updated_at).toLocaleString()
            : ''
          const cwdNote = t.cwd ? `  ${t.cwd}` : ''
          console.log(
            `  ${String(i + 1).padStart(2)}. ${name}`,
          )
          console.log(
            `      ${date}${cwdNote}`,
          )
          console.log(
            `      codex-fork-ui --resume ${t.id}`,
          )
          console.log()
        }
      }
    } catch (err) {
      console.error(`Failed to list sessions: ${err}`)
    } finally {
      client.close()
      process.exit(0)
    }
  })()
} else {
  render(<Root />)
}
