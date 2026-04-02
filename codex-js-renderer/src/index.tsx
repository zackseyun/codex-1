import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Box, Text, render, useApp, useInput } from 'ink'

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

type JsonRpcMessage = {
  id?: number | string
  method?: string
  params?: JsonValue
  result?: JsonValue
  error?: { message?: string }
}

type FeedPhase =
  | 'Session'
  | 'Planning'
  | 'Research'
  | 'Repository'
  | 'Editing'
  | 'Validation'
  | 'External'
  | 'Responding'
  | 'Review'
  | 'Execution'

type FeedStatus = 'active' | 'done' | 'error' | 'info'

type FeedEntry = {
  id: string
  phase: FeedPhase
  workstream: string
  icon: string
  title: string
  summary?: string
  detail?: string
  raw?: string
  status: FeedStatus
  timestamp: number
  kind: string
}

type CollapsedEntry = FeedEntry & {
  repeatCount: number
}

const MAX_VISIBLE_ENTRIES = 18
const SHELL_PREVIEW_WORD_LIMIT = 6
const SHELL_PREVIEW_GROUP_LIMIT = 3

const PHASE_STYLES: Record<
  FeedPhase,
  { color: string; accent: string; icon: string }
> = {
  Session: { color: 'cyanBright', accent: 'cyan', icon: '🚀' },
  Planning: { color: 'magentaBright', accent: 'magenta', icon: '🧠' },
  Research: { color: 'blueBright', accent: 'blue', icon: '🔎' },
  Repository: { color: 'greenBright', accent: 'green', icon: '🌿' },
  Editing: { color: 'yellowBright', accent: 'yellow', icon: '✍️' },
  Validation: { color: 'redBright', accent: 'red', icon: '🧪' },
  External: { color: 'cyanBright', accent: 'cyan', icon: '🌐' },
  Responding: { color: 'white', accent: 'gray', icon: '💬' },
  Review: { color: 'magentaBright', accent: 'magenta', icon: '🛡️' },
  Execution: { color: 'yellowBright', accent: 'yellow', icon: '⚙️' },
}

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
  private notificationListeners = new Set<(message: JsonRpcMessage) => void>()
  private stderrListeners = new Set<(line: string) => void>()
  private exitListeners = new Set<(code: number | null) => void>()

  constructor(private readonly binary: string) {
    this.child = spawn(this.binary, ['app-server', '--listen', 'stdio://'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    })

    const stdoutLines = readline.createInterface({ input: this.child.stdout })
    stdoutLines.on('line', line => {
      if (!line.trim()) return
      let message: JsonRpcMessage
      try {
        message = JSON.parse(line)
      } catch (error) {
        this.stderrListeners.forEach(listener =>
          listener(`Failed to parse app-server output: ${String(error)}`),
        )
        return
      }
      this.handleMessage(message)
    })

    const stderrLines = readline.createInterface({ input: this.child.stderr })
    stderrLines.on('line', line => {
      this.stderrListeners.forEach(listener => listener(line))
    })

    this.child.on('exit', code => {
      const error = new Error(`Codex app-server exited (${code ?? 'unknown'})`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this.exitListeners.forEach(listener => listener(code))
    })
  }

  onNotification(listener: (message: JsonRpcMessage) => void): () => void {
    this.notificationListeners.add(listener)
    return () => this.notificationListeners.delete(listener)
  }

  onStderr(listener: (line: string) => void): () => void {
    this.stderrListeners.add(listener)
    return () => this.stderrListeners.delete(listener)
  }

  onExit(listener: (code: number | null) => void): () => void {
    this.exitListeners.add(listener)
    return () => this.exitListeners.delete(listener)
  }

  async initialize() {
    await this.request('initialize', {
      clientInfo: {
        name: 'codex_fork_js_renderer',
        title: 'Codex Fork JS Renderer',
        version: '0.1.0',
      },
      capabilities: {
        experimentalApi: true,
        optOutNotificationMethods: [],
      },
    })
    this.notify('initialized')
  }

  request<T extends JsonValue = JsonValue>(method: string, params: JsonValue): Promise<T> {
    const id = this.nextId++
    const payload = JSON.stringify({ id, method, params })
    this.child.stdin.write(`${payload}\n`)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: JsonValue) => void, reject })
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

  private handleMessage(message: JsonRpcMessage) {
    if (typeof message.id !== 'undefined' && ('result' in message || 'error' in message)) {
      const requestId = Number(message.id)
      const pending = this.pending.get(requestId)
      if (!pending) return
      this.pending.delete(requestId)
      if (message.error) {
        pending.reject(new Error(message.error.message ?? 'Unknown JSON-RPC error'))
      } else {
        pending.resolve(message.result ?? null)
      }
      return
    }

    if (message.method) {
      this.notificationListeners.forEach(listener => listener(message))
    }
  }
}

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
  const prompt: string[] = []

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    if (arg === '--cwd' || arg === '-C') {
      cwd = argv[index + 1] || cwd
      index += 1
      continue
    }

    if (arg === '--model' || arg === '-m') {
      model = argv[index + 1] || model
      index += 1
      continue
    }

    prompt.push(arg)
  }

  return {
    cwd,
    model,
    initialPrompt: prompt.join(' ').trim(),
  }
}

function compactPreviewWords(text: string, limit = SHELL_PREVIEW_WORD_LIMIT) {
  const tokens = text.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return ''
  const preview = tokens.slice(0, limit).join(' ')
  return tokens.length > limit ? `${preview} …` : preview
}

function shellSteps(command: string) {
  return command
    .split(/\n+/)
    .flatMap(line => line.split('&&'))
    .flatMap(segment => segment.split('||'))
    .flatMap(segment => segment.split(';'))
    .map(step => step.trim())
    .filter(Boolean)
}

function summarizeShellCommand(command: string) {
  const previews = shellSteps(command)
    .map(step => compactPreviewWords(step))
    .filter(Boolean)

  if (!previews.length) return ''

  const grouped: Array<{ preview: string; count: number }> = []
  for (const preview of previews) {
    const last = grouped[grouped.length - 1]
    if (last && last.preview === preview) {
      last.count += 1
    } else {
      grouped.push({ preview, count: 1 })
    }
  }

  const totalSteps = grouped.reduce((sum, group) => sum + group.count, 0)
  const parts = grouped.slice(0, SHELL_PREVIEW_GROUP_LIMIT).map(group =>
    group.count > 1 ? `${group.preview} ×${group.count}` : group.preview,
  )
  if (grouped.length > SHELL_PREVIEW_GROUP_LIMIT) {
    parts.push(`+${grouped.length - SHELL_PREVIEW_GROUP_LIMIT} more`)
  }
  if (totalSteps > 1) {
    parts.push(`(${totalSteps} steps)`)
  }
  return parts.join(' • ')
}

function classifyCommandItem(item: any): Omit<FeedEntry, 'id' | 'timestamp' | 'status'> {
  const actions = Array.isArray(item.commandActions) ? item.commandActions : []
  const rawCommand = String(item.command || '')
  const summaryFromActions = summarizeCommandActions(actions, rawCommand)
  const lower = rawCommand.toLowerCase()

  if (actions.length && actions.every((action: any) => action.type === 'search')) {
    return {
      phase: 'Research',
      workstream: 'Code search',
      icon: '🔍',
      title: 'Code search',
      summary: summaryFromActions,
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (actions.length && actions.every((action: any) => action.type === 'read')) {
    return {
      phase: 'Research',
      workstream: 'File inspection',
      icon: '📄',
      title: 'File read',
      summary: summaryFromActions,
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (actions.length && actions.every((action: any) => action.type === 'listFiles')) {
    return {
      phase: 'Research',
      workstream: 'Directory inspection',
      icon: '📁',
      title: 'Directory scan',
      summary: summaryFromActions,
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (
    lower.startsWith('git status') ||
    lower.startsWith('git branch') ||
    lower.startsWith('git rev-parse') ||
    lower.startsWith('git log') ||
    lower.startsWith('git diff')
  ) {
    return {
      phase: 'Repository',
      workstream: 'Repo check',
      icon: '🌿',
      title: 'Repo check',
      summary: summarizeShellCommand(rawCommand),
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (
    /\b(pytest|jest|vitest|maestro|npm test|pnpm test|cargo test|go test|xcodebuild)\b/.test(
      lower,
    )
  ) {
    return {
      phase: 'Validation',
      workstream: 'Validation',
      icon: '🧪',
      title: 'Validation run',
      summary: summarizeShellCommand(rawCommand),
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (/\b(cargo build|npm run build|pnpm build|tsc|gradle|make)\b/.test(lower)) {
    return {
      phase: 'Validation',
      workstream: 'Build',
      icon: '🏗️',
      title: 'Build step',
      summary: summarizeShellCommand(rawCommand),
      raw: rawCommand,
      kind: 'command',
    }
  }

  if (
    actions.length &&
    actions.every((action: any) =>
      ['read', 'listFiles', 'search'].includes(action.type),
    )
  ) {
    return {
      phase: 'Research',
      workstream: 'Repo discovery',
      icon: '🧭',
      title: 'Repo discovery',
      summary: summaryFromActions,
      raw: rawCommand,
      kind: 'command',
    }
  }

  return {
    phase: 'Execution',
    workstream: 'Shell task',
    icon: '⚙️',
    title:
      item.source === 'userShell' ? 'User shell command' : 'Shell task',
    summary: summarizeShellCommand(rawCommand),
    raw: rawCommand,
    kind: 'command',
  }
}

function summarizeCommandActions(actions: any[], fallbackCommand: string) {
  const previews = actions
    .map(action => {
      if (action.type === 'read') {
        return `read ${path.basename(action.path || action.name || 'file')}`
      }
      if (action.type === 'listFiles') {
        return `list ${action.path || 'current directory'}`
      }
      if (action.type === 'search') {
        const query = action.query ? `"${action.query}"` : 'workspace'
        const target = action.path ? ` in ${action.path}` : ''
        return `search ${query}${target}`
      }
      return compactPreviewWords(action.command || fallbackCommand)
    })
    .filter(Boolean)

  if (!previews.length) {
    return summarizeShellCommand(fallbackCommand)
  }

  const grouped: Array<{ preview: string; count: number }> = []
  for (const preview of previews) {
    const last = grouped[grouped.length - 1]
    if (last && last.preview === preview) {
      last.count += 1
    } else {
      grouped.push({ preview, count: 1 })
    }
  }

  const parts = grouped.slice(0, SHELL_PREVIEW_GROUP_LIMIT).map(group =>
    group.count > 1 ? `${group.preview} ×${group.count}` : group.preview,
  )
  if (grouped.length > SHELL_PREVIEW_GROUP_LIMIT) {
    parts.push(`+${grouped.length - SHELL_PREVIEW_GROUP_LIMIT} more`)
  }
  return parts.join(' • ')
}

function summarizeFileChanges(item: any) {
  const changes = Array.isArray(item.changes) ? item.changes : []
  const names = changes
    .map((change: any) => change.path || change.filePath || change.file_name)
    .filter(Boolean)
    .map((name: string) => path.basename(name))
  if (!names.length) return `${changes.length || 0} file updates`
  const preview = names.slice(0, 3).join(', ')
  return names.length > 3 ? `${preview} +${names.length - 3} more` : preview
}

function summarizeMcpTool(item: any) {
  const server = item.server || 'tool'
  const tool = item.tool || 'call'
  return `${server}.${tool}`
}

function normalizeWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').trim()
}

function truncateText(text: string, maxChars = 120) {
  const normalized = normalizeWhitespace(text)
  if (normalized.length <= maxChars) return normalized
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`
}

function extractTakeaways(text: string, maxItems = 3) {
  const normalized = String(text || '').replace(/\r/g, '')
  if (!normalized.trim()) return []

  const cleanedLines = normalized
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line =>
      line
        .replace(/^[-*•]\s+/, '')
        .replace(/^\d+[.)]\s+/, '')
        .replace(/^#+\s+/, '')
        .trim(),
    )
    .filter(line => line && !(line.endsWith(':') && line.length < 48))
    .map(line => truncateText(line, 160))

  if (cleanedLines.length > 1) {
    return cleanedLines.slice(0, maxItems)
  }

  return normalized
    .split(/(?<=[.!?])\s+/)
    .map(sentence => truncateText(sentence, 160))
    .filter(Boolean)
    .slice(0, maxItems)
}

function primaryTakeaway(text: string) {
  return extractTakeaways(text, 1)[0] || ''
}

function secondaryTakeawayText(text: string) {
  const rest = extractTakeaways(text, 3).slice(1)
  return rest.length ? rest.join(' • ') : undefined
}

function compactErrorText(text: string | null | undefined) {
  if (!text) return undefined
  return truncateText(text, 180)
}

function toFeedEntryFromItem(item: any, statusOverride?: FeedStatus): FeedEntry | null {
  if (!item || !item.type) return null
  const timestamp = Date.now()

  if (item.type === 'userMessage' || item.type === 'hookPrompt') {
    return null
  }

  if (item.type === 'plan') {
    const summary = primaryTakeaway(String(item.text || ''))
    if (!summary) return null
    return {
      id: item.id,
      phase: 'Planning',
      workstream: 'Plan',
      icon: '🧠',
      title: 'Plan update',
      summary,
      detail: secondaryTakeawayText(String(item.text || '')),
      raw: String(item.text || '').trim() || undefined,
      status: statusOverride ?? 'info',
      timestamp,
      kind: 'plan',
    }
  }

  if (item.type === 'reasoning') {
    const rawReasoning = Array.isArray(item.summary)
      ? item.summary.join('\n')
      : String(item.content || '')
    const summary = primaryTakeaway(rawReasoning)
    if (!summary) return null
    return {
      id: item.id,
      phase: 'Planning',
      workstream: 'Reasoning',
      icon: '🧠',
      title: 'Reasoning',
      summary,
      detail: secondaryTakeawayText(rawReasoning),
      raw: rawReasoning || undefined,
      status: statusOverride ?? 'info',
      timestamp,
      kind: 'reasoning',
    }
  }

  if (item.type === 'agentMessage') {
    const text = String(item.text || '')
    const summary = primaryTakeaway(text)
    if (!summary) return null
    return {
      id: item.id,
      phase: 'Responding',
      workstream:
        item.phase === 'final_answer' ? 'Final answer' : 'Commentary',
      icon: item.phase === 'final_answer' ? '✅' : '💬',
      title:
        item.phase === 'final_answer' ? 'Final answer' : 'Takeaway',
      summary,
      detail: secondaryTakeawayText(text),
      raw: text || undefined,
      status: statusOverride ?? 'done',
      timestamp,
      kind: 'message',
    }
  }

  if (item.type === 'commandExecution') {
    const base = classifyCommandItem(item)
    return {
      id: item.id,
      ...base,
      status:
        statusOverride ??
        (item.status === 'failed' || item.status === 'declined'
          ? 'error'
          : item.status === 'inProgress'
            ? 'active'
            : 'done'),
      detail: compactErrorText(
        item.status === 'failed' && item.aggregatedOutput
          ? String(item.aggregatedOutput).trim()
          : undefined,
      ),
      timestamp,
    }
  }

  if (item.type === 'fileChange') {
    return {
      id: item.id,
      phase: 'Editing',
      workstream: 'Code changes',
      icon: '✍️',
      title: 'File changes',
      summary: summarizeFileChanges(item),
      status: statusOverride ?? 'done',
      timestamp,
      kind: 'fileChange',
    }
  }

  if (item.type === 'mcpToolCall') {
    return {
      id: item.id,
      phase: 'External',
      workstream: 'Tool call',
      icon: '🧩',
      title: item.status === 'failed' ? 'Tool call failed' : 'External tool',
      summary: summarizeMcpTool(item),
      status:
        statusOverride ??
        (item.status === 'failed'
          ? 'error'
          : item.status === 'inProgress'
            ? 'active'
            : 'done'),
      timestamp,
      kind: 'mcp',
    }
  }

  if (item.type === 'webSearch') {
    return {
      id: item.id,
      phase: 'External',
      workstream: 'Web research',
      icon: '🌐',
      title: 'Web research',
      summary: String(item.query || 'searching the web'),
      status: statusOverride ?? 'done',
      timestamp,
      kind: 'webSearch',
    }
  }

  if (item.type === 'enteredReviewMode' || item.type === 'exitedReviewMode') {
    const summary = primaryTakeaway(String(item.review || ''))
    if (!summary) return null
    return {
      id: item.id,
      phase: 'Review',
      workstream: 'Review',
      icon: '🛡️',
      title: item.type === 'enteredReviewMode' ? 'Entered review' : 'Exited review',
      summary,
      detail: secondaryTakeawayText(String(item.review || '')),
      raw: String(item.review || '') || undefined,
      status: statusOverride ?? 'info',
      timestamp,
      kind: 'review',
    }
  }

  return null
}

function collapseEntries(entries: FeedEntry[]) {
  const collapsed: CollapsedEntry[] = []

  for (const entry of entries) {
    const last = collapsed[collapsed.length - 1]
    const canCollapse =
      last &&
      last.phase === entry.phase &&
      last.workstream === entry.workstream &&
      last.title === entry.title &&
      (last.summary || '') === (entry.summary || '') &&
      (last.detail || '') === (entry.detail || '') &&
      (last.raw || '') === (entry.raw || '') &&
      last.status === entry.status

    if (canCollapse) {
      last.repeatCount += 1
      last.timestamp = entry.timestamp
    } else {
      collapsed.push({ ...entry, repeatCount: 1 })
    }
  }

  return collapsed
}

function upsertEntry(entries: FeedEntry[], nextEntry: FeedEntry) {
  const existingIndex = entries.findIndex(entry => entry.id === nextEntry.id)
  if (existingIndex === -1) return [...entries, nextEntry]

  const updated = [...entries]
  updated[existingIndex] = { ...updated[existingIndex], ...nextEntry }
  return updated
}

function statusColor(status: FeedStatus) {
  if (status === 'active') return 'yellowBright'
  if (status === 'error') return 'redBright'
  if (status === 'done') return 'greenBright'
  return 'gray'
}

function mutedColorForEntry(entry: CollapsedEntry) {
  if (entry.status === 'error') return 'redBright'
  if (entry.status === 'active') return PHASE_STYLES[entry.phase].color
  return 'white'
}

function Divider() {
  const width = process.stdout.columns || 80
  return <Text color="gray">{'─'.repeat(Math.max(20, Math.min(width - 2, 88)))}</Text>
}

function SectionTitle({ title, hint }: { title: string; hint?: string }) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color="gray">
        {title}
        {hint ? ` · ${hint}` : ''}
      </Text>
    </Box>
  )
}

function MetricRow({
  label,
  value,
  color = 'white',
}: {
  label: string
  value: string
  color?: string
}) {
  if (!value) return null
  return (
    <Text>
      <Text color="gray">{label.padEnd(10)}</Text>
      <Text color={color}>{value}</Text>
    </Text>
  )
}

function SummaryPanel({
  title,
  accentColor,
  children,
}: {
  title: string
  accentColor: string
  children: React.ReactNode
}) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accentColor} paddingX={1} marginTop={1}>
      <Text color={accentColor}>{title}</Text>
      <Box flexDirection="column">{children}</Box>
    </Box>
  )
}

function ActivityRow({
  entry,
  showDetails,
}: {
  entry: CollapsedEntry
  showDetails: boolean
}) {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>
        <Text color={PHASE_STYLES[entry.phase].accent}>{entry.icon} {entry.workstream}</Text>
        <Text color="gray"> · </Text>
        <Text color={mutedColorForEntry(entry)}>
          {truncateText(entry.summary || entry.title, 150)}
        </Text>
        {entry.repeatCount > 1 ? <Text color="gray">{` ×${entry.repeatCount}`}</Text> : null}
      </Text>
      {showDetails && entry.detail ? <Text color="gray">  {entry.detail}</Text> : null}
      {showDetails && entry.raw ? (
        <Text color="gray">  {truncateText(entry.raw, 220)}</Text>
      ) : null}
    </Box>
  )
}

function App() {
  const { exit } = useApp()
  const args = useMemo(() => parseArgs(process.argv.slice(2)), [])
  const [entries, setEntries] = useState<FeedEntry[]>([])
  const [threadId, setThreadId] = useState<string | null>(null)
  const [threadStatus, setThreadStatus] = useState('starting')
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null)
  const [composer, setComposer] = useState('')
  const [showDetails, setShowDetails] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [streamingMessage, setStreamingMessage] = useState('')
  const [backendLog, setBackendLog] = useState<string[]>([])
  const [gitBranch, setGitBranch] = useState<string>('')
  const initialPromptSent = useRef(false)
  const clientRef = useRef<AppServerClient | null>(null)

  useEffect(() => {
    const binary = backendBinary()
    const client = new AppServerClient(binary)
    clientRef.current = client

    const unlistenNotification = client.onNotification(async message => {
      try {
        if (message.method === 'thread/started') {
          const nextThreadId = (message.params as any)?.thread?.id
          if (nextThreadId) {
            setThreadId(nextThreadId)
            setThreadStatus('idle')
            setEntries(current =>
              upsertEntry(current, {
                id: `thread-${nextThreadId}`,
                phase: 'Session',
                workstream: 'Thread',
                icon: '🚀',
                title: 'Thread started',
                summary: (message.params as any)?.thread?.cwd || args.cwd,
                status: 'info',
                timestamp: Date.now(),
                kind: 'thread',
              }),
            )
          }
          return
        }

        if (message.method === 'thread/status/changed') {
          const status = (message.params as any)?.status?.type || 'unknown'
          setThreadStatus(status)
          return
        }

        if (message.method === 'turn/started') {
          const turn = (message.params as any)?.turn
          setActiveTurnId(turn?.id || null)
          setThreadStatus('active')
          return
        }

        if (message.method === 'turn/completed') {
          setActiveTurnId(null)
          setThreadStatus('idle')
          setStreamingMessage('')
          return
        }

        if (message.method === 'item/agentMessage/delta') {
          setStreamingMessage(current => current + String((message.params as any)?.delta || ''))
          return
        }

        if (message.method === 'item/started' || message.method === 'item/completed') {
          const item = (message.params as any)?.item
          const entry = toFeedEntryFromItem(
            item,
            message.method === 'item/started' ? 'active' : undefined,
          )
          if (entry) {
            setEntries(current => upsertEntry(current, entry))
            if (item?.type === 'agentMessage') {
              setStreamingMessage('')
            }
          }
          return
        }

        if (message.method === 'error') {
          const error = (message.params as any)?.error
          const detail = [error?.message, error?.additionalDetails]
            .filter(Boolean)
            .join(' · ')
          setErrorText(detail || 'Unknown server error')
        }
      } catch (error) {
        setErrorText(String(error))
      }
    })

    const unlistenStderr = client.onStderr(line => {
      setBackendLog(current => [...current.slice(-4), line])
    })

    const unlistenExit = client.onExit(code => {
      setErrorText(`Backend exited with code ${code ?? 'unknown'}`)
    })

    ;(async () => {
      try {
        await client.initialize()
        const response = (await client.request('thread/start', {
          cwd: args.cwd,
          model: args.model ?? null,
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          experimentalRawEvents: false,
          persistExtendedHistory: true,
          serviceName: 'codex_fork_js_renderer',
        })) as any
        const startedThreadId = response?.thread?.id
        if (startedThreadId) setThreadId(startedThreadId)
      } catch (error) {
        setErrorText(String(error))
      }
    })()

    return () => {
      unlistenNotification()
      unlistenStderr()
      unlistenExit()
      client.close()
    }
  }, [args.cwd, args.model])

  useEffect(() => {
    if (initialPromptSent.current || !threadId || !args.initialPrompt) return
    initialPromptSent.current = true
    void submitPrompt(args.initialPrompt)
  }, [threadId, args.initialPrompt])

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

  const submitPrompt = async (promptText: string) => {
    const client = clientRef.current
    if (!client || !threadId) return

    const text = promptText.trim()
    if (!text) return

    setEntries(current => [
      ...current,
      {
        id: `user-${Date.now()}`,
        phase: 'Session',
        workstream: 'User input',
        icon: '🙂',
        title: 'You',
        summary: text,
        status: 'info',
        timestamp: Date.now(),
        kind: 'user',
      },
    ])
    setComposer('')

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
    } catch (error) {
      setErrorText(String(error))
    }
  }

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      exit()
      return
    }

    if (key.ctrl && input === 'y') {
      setShowDetails(current => !current)
      return
    }

    if (key.return) {
      void submitPrompt(composer)
      return
    }

    if (key.backspace || key.delete) {
      setComposer(current => current.slice(0, -1))
      return
    }

    if (key.escape) {
      setComposer('')
      return
    }

    if (!key.ctrl && !key.meta && input) {
      setComposer(current => current + input)
    }
  })

  const collapsedEntries = useMemo(() => collapseEntries(entries), [entries])
  const objective = [...collapsedEntries]
    .reverse()
    .find(entry => entry.kind === 'user')
    ?.summary
  const activityEntries = collapsedEntries.filter(
    entry => !['user', 'message', 'reasoning', 'plan', 'thread'].includes(entry.kind),
  )
  const recentActivity = activityEntries.slice(-6)
  const hiddenCount = Math.max(0, activityEntries.length - recentActivity.length)
  const focusEntry = [...collapsedEntries]
    .reverse()
    .find(entry =>
      ['command', 'fileChange', 'mcp', 'webSearch', 'review'].includes(entry.kind) ||
      entry.status === 'active',
    ) || [...collapsedEntries].reverse().find(entry => !['user', 'thread'].includes(entry.kind))
  const currentPhase = focusEntry?.phase || 'Session'
  const currentWorkstream = focusEntry?.workstream || 'Thread'
  const currentAction = focusEntry?.summary || focusEntry?.title || 'Waiting for work'
  const phaseStyle = PHASE_STYLES[currentPhase]
  const latestSignals = Array.from(
    new Set(
      [
        ...extractTakeaways(streamingMessage, 2),
        ...collapsedEntries
          .filter(entry => entry.kind === 'message')
          .map(entry => entry.summary || '')
          .filter(Boolean)
          .reverse(),
      ].filter(Boolean),
    ),
  ).slice(0, 3)

  return (
    <Box flexDirection="column">
      <SummaryPanel title="Overview" accentColor={phaseStyle.accent}>
        <MetricRow
          label="Focus"
          value={`${phaseStyle.icon} ${currentPhase} · ${currentWorkstream}`}
          color={phaseStyle.color}
        />
        <MetricRow
          label="Current"
          value={truncateText(currentAction, 140)}
          color="white"
        />
        <MetricRow
          label="Objective"
          value={truncateText(objective || 'No prompt yet', 140)}
          color="white"
        />
        <MetricRow
          label="Status"
          value={`thread ${threadStatus}${gitBranch ? ` · git ${gitBranch}` : ''} · details ${showDetails ? 'on' : 'off'}`}
          color="gray"
        />
      </SummaryPanel>

      {latestSignals.length > 0 ? (
        <SummaryPanel title="Signal" accentColor="green">
          {latestSignals.map(signal => (
            <Text key={signal}>
              <Text color="green">• </Text>
              <Text color="white">{truncateText(signal, 150)}</Text>
            </Text>
          ))}
        </SummaryPanel>
      ) : null}

      <SectionTitle title="Recent activity" hint={hiddenCount > 0 ? `${hiddenCount} older hidden` : undefined} />
      <Divider />
      {recentActivity.length > 0 ? (
        recentActivity.map(entry => (
          <ActivityRow key={`${entry.id}-${entry.timestamp}`} entry={entry} showDetails={showDetails} />
        ))
      ) : (
        <Text color="gray">No high-signal activity yet.</Text>
      )}

      {errorText ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="redBright">⚠️ Error</Text>
          <Text color="gray">{truncateText(errorText, 220)}</Text>
        </Box>
      ) : null}

      {showDetails && backendLog.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Backend log</Text>
          {backendLog.slice(-2).map((lineText, index) => (
            <Text key={`${lineText}-${index}`} color="gray">
              {truncateText(lineText, 220)}
            </Text>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        <Divider />
        <Text color="gray">Ctrl+Y raw details · Enter send · Esc clear · Ctrl+C quit</Text>
        <Text color="greenBright">
          › {composer || 'Type a prompt to start or steer the current turn'}
        </Text>
      </Box>
    </Box>
  )
}

render(<App />)
