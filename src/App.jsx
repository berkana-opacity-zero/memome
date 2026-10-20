import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import {
  GoogleAuthProvider,
  onAuthStateChanged,
  signInWithPopup,
  signOut,
} from 'firebase/auth'
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  serverTimestamp,
  updateDoc,
  where,
  writeBatch,
} from 'firebase/firestore'
import './App.css'
import { auth, db, firebaseConfigError } from './lib/firebase'

const provider = new GoogleAuthProvider()
const URL_SPLIT_PATTERN = /(https?:\/\/[^\s]+)/gi
const STRICT_URL_PATTERN = /^https?:\/\/[^\s]+$/i
const THEME_STORAGE_KEY = 'memome-theme'
const URL_EXPANDED_STORAGE_KEY = 'memome-url-expanded'
const TOUCH_LAYOUT_QUERY = '(hover: none) and (pointer: coarse)'
const SWIPE_TRIGGER_PX = 72
const SWIPE_DIRECTION_RATIO = 1.25
const SWIPE_MOVE_START_PX = 14
const SWIPE_RUBBER_BAND_START_PX = 112
const SWIPE_RUBBER_BAND_RATIO = 0.35
const SWIPE_SETTLE_MS = 280
const LONG_PRESS_DRAG_MS = 360
const TOUCH_DRAG_MOVE_THRESHOLD_PX = 10
const TOUCH_DRAG_ACTIVATE_MOVE_PX = 8
const INSERT_GAP_PX = 72
const AUTO_SCROLL_EDGE_PX = 88
const AUTO_SCROLL_MAX_STEP_PX = 22
const COPY_TOAST_DURATION_MS = 2200
const TRANSPARENT_DRAG_PIXEL =
  'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=='

function getInitialTheme() {
  if (typeof window === 'undefined') {
    return 'light'
  }

  const savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY)
  if (savedTheme === 'light' || savedTheme === 'dark') {
    return savedTheme
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getInitialUrlExpanded() {
  if (typeof window === 'undefined') {
    return false
  }

  try {
    return window.localStorage.getItem(URL_EXPANDED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function getInitialTouchLayout() {
  if (typeof window === 'undefined') {
    return false
  }

  return window.matchMedia(TOUCH_LAYOUT_QUERY).matches
}

function toMillis(value) {
  if (!value) {
    return 0
  }

  if (typeof value.toMillis === 'function') {
    return value.toMillis()
  }

  if (value instanceof Date) {
    return value.getTime()
  }

  return 0
}

function normalizeBody(value) {
  return value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .trim()
}

function fallbackCopyText(text) {
  if (typeof document === 'undefined' || !document.body) {
    return false
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.top = '-9999px'
  textarea.style.left = '-9999px'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.focus()
  textarea.select()
  textarea.setSelectionRange(0, textarea.value.length)

  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }

  document.body.removeChild(textarea)
  return copied
}

async function copyTextToClipboard(text) {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text)
    return
  }

  if (!fallbackCopyText(text)) {
    throw new Error('clipboard-unavailable')
  }
}

function getSortIndex(note) {
  const value = Number(note.sortIndex)
  return Number.isFinite(value) ? value : null
}

function sortNotes(items) {
  return [...items].sort((a, b) => {
    const aPinned = Boolean(a.pinned)
    const bPinned = Boolean(b.pinned)

    if (aPinned !== bPinned) {
      return aPinned ? -1 : 1
    }

    const aIndex = getSortIndex(a)
    const bIndex = getSortIndex(b)

    if (aIndex !== null && bIndex !== null && aIndex !== bIndex) {
      return aIndex - bIndex
    }
    if (aIndex !== null && bIndex === null) {
      return -1
    }
    if (aIndex === null && bIndex !== null) {
      return 1
    }

    const updatedDiff = toMillis(b.updatedAt) - toMillis(a.updatedAt)
    if (updatedDiff !== 0) {
      return updatedDiff
    }

    return a.id.localeCompare(b.id)
  })
}

function findNextSortIndex(items, pinned) {
  const sameGroup = items.filter((note) => Boolean(note.pinned) === Boolean(pinned))
  const maxIndex = sameGroup.reduce((maxValue, note) => {
    const noteIndex = getSortIndex(note)
    if (noteIndex === null) {
      return maxValue
    }
    return Math.max(maxValue, noteIndex)
  }, -1)

  return maxIndex + 1
}

function findGroupTopIndex(items, pinned) {
  const sameGroup = items.filter((note) => Boolean(note.pinned) === Boolean(pinned))
  if (sameGroup.length === 0) {
    return 0
  }

  const minIndex = sameGroup.reduce((minValue, note) => {
    const noteIndex = getSortIndex(note)
    if (noteIndex === null) {
      return minValue
    }
    return Math.min(minValue, noteIndex)
  }, 0)

  return minIndex - 1
}

function findPinnedTopIndex(items) {
  return findGroupTopIndex(items, true)
}

function getErrorMessage(error) {
  const errorCode = typeof error?.code === 'string' ? error.code : ''
  const message = typeof error?.message === 'string' ? error.message : '予期しないエラーが発生しました。'

  if (errorCode === 'permission-denied' || errorCode === 'firestore/permission-denied') {
    return 'このアカウントは利用できません。許可済みアカウントでログインしてください。'
  }

  if (message.includes('Missing or insufficient permissions')) {
    return 'Firestoreの権限エラーです。Firebaseコンソールのルール設定を確認してください。'
  }

  if (message.includes('The query requires an index')) {
    return 'Firestoreのインデックス作成が必要です。Firebaseコンソールのエラーリンクから作成してください。'
  }

  return message
}

function Icon({ children, size = 16, filled = false }) {
  return (
    <svg
      className="ui-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  )
}

function PaperclipIcon() {
  return (
    <Icon>
      <path d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551" />
    </Icon>
  )
}

function ExternalLinkIcon() {
  return (
    <Icon>
      <path d="M7 17 17 7" />
      <path d="M7 7h10v10" />
    </Icon>
  )
}

function PinIcon({ filled = false, size = 16 }) {
  return (
    <Icon filled={filled} size={size}>
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </Icon>
  )
}

function PinOffIcon({ size = 16 }) {
  return (
    <Icon size={size}>
      <path d="M12 17v5" />
      <path d="M15 9.34V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H7.89" />
      <path d="m2 2 20 20" />
      <path d="M9 9v1.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h11" />
    </Icon>
  )
}

function TrashIcon({ size = 16 }) {
  return (
    <Icon size={size}>
      <path d="M3 6h18" />
      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6" />
      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2" />
    </Icon>
  )
}

function GlobeIcon() {
  return (
    <Icon>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </Icon>
  )
}

function GripIcon() {
  return (
    <svg className="ui-icon" viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="9" cy="6" r="1.6" />
      <circle cx="15" cy="6" r="1.6" />
      <circle cx="9" cy="12" r="1.6" />
      <circle cx="15" cy="12" r="1.6" />
      <circle cx="9" cy="18" r="1.6" />
      <circle cx="15" cy="18" r="1.6" />
    </svg>
  )
}

function MoonIcon() {
  return (
    <Icon size={18}>
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z" />
    </Icon>
  )
}

function SunIcon() {
  return (
    <Icon size={18}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </Icon>
  )
}

// URL を折り返して全部見せる状態にする（上下に広がる矢印）
function ExpandIcon() {
  return (
    <Icon size={18}>
      <path d="m7 15 5 5 5-5" />
      <path d="m7 9 5-5 5 5" />
    </Icon>
  )
}

// URL を1行に省略する状態に戻す（上下から閉じる矢印）
function CollapseIcon() {
  return (
    <Icon size={18}>
      <path d="m7 20 5-5 5 5" />
      <path d="m7 4 5 5 5-5" />
    </Icon>
  )
}

function LogoutIcon() {
  return (
    <Icon size={18}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5" />
      <path d="M21 12H9" />
    </Icon>
  )
}

function SearchIcon() {
  return (
    <Icon size={17}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </Icon>
  )
}

function PlusIcon() {
  return (
    <Icon size={18}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Icon>
  )
}

function ArrowUpIcon() {
  return (
    <Icon size={20}>
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </Icon>
  )
}

function LogoIcon({ size = 18 }) {
  return (
    <Icon size={size}>
      <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" />
      <path d="M14 3v6h6" />
      <path d="M8 13h8" />
      <path d="M8 17h5" />
    </Icon>
  )
}

// 指の移動量からカードの表示位置を求める（一定以上はゴムのように抵抗をつける）
function getSwipeOffset(deltaX) {
  const distance = Math.max(0, Math.abs(deltaX) - SWIPE_MOVE_START_PX)
  const eased =
    distance <= SWIPE_RUBBER_BAND_START_PX
      ? distance
      : SWIPE_RUBBER_BAND_START_PX +
        (distance - SWIPE_RUBBER_BAND_START_PX) * SWIPE_RUBBER_BAND_RATIO
  return Math.round(Math.sign(deltaX) * eased)
}

// ホーム画面に追加したアプリ（スタンドアロン表示）として起動しているか
function isStandaloneApp() {
  if (typeof window === 'undefined') {
    return false
  }

  return (
    window.matchMedia?.('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  )
}

function isIosDevice() {
  const { userAgent, maxTouchPoints } = window.navigator
  // iPadOS はデスクトップ版 Safari と同じ UA を名乗るので、タッチ対応かどうかで見分ける
  return /iPhone|iPad|iPod/.test(userAgent) || (/Macintosh/.test(userAgent) && maxTouchPoints > 1)
}

function getIosMajorVersion() {
  const match = window.navigator.userAgent.match(/OS (\d+)_\d+(?:_\d+)? like Mac OS X/)
  return match ? Number(match[1]) : null
}

// Android 用: 外部ブラウザに渡すための intent:// 形式の URL を作る
function toAndroidIntentUrl(url) {
  try {
    const parsed = new URL(url)
    // intent:// 形式では # 以降を表現できないので、その場合は通常どおり開く
    if (parsed.hash) {
      return null
    }
    const scheme = parsed.protocol.replace(':', '')
    return (
      `intent://${parsed.host}${parsed.pathname}${parsed.search}` +
      `#Intent;scheme=${scheme};action=android.intent.action.VIEW;` +
      'category=android.intent.category.BROWSABLE;' +
      `S.browser_fallback_url=${encodeURIComponent(url)};end`
    )
  } catch {
    return null
  }
}

// アプリとして起動しているときは、アプリ内ブラウザではなく外部ブラウザでリンクを開く
function getExternalBrowserUrl(url) {
  if (!isStandaloneApp()) {
    return null
  }

  if (/Android/i.test(window.navigator.userAgent)) {
    return toAndroidIntentUrl(url)
  }

  if (isIosDevice()) {
    const iosVersion = getIosMajorVersion()
    // x-safari-https:// は iOS 17 以降のみ対応
    if (iosVersion !== null && iosVersion < 17) {
      return null
    }
    // x-safari-http:// は存在しない（「アドレスが無効です」になる）ので、http:// のURLは通常どおり開く
    return /^https:\/\//i.test(url) ? `x-safari-${url}` : null
  }

  return null
}

function handleExternalLinkClick(event, url) {
  const externalUrl = getExternalBrowserUrl(url)
  if (!externalUrl) {
    return
  }

  event.preventDefault()
  window.location.href = externalUrl
}

// URL をチップ表示用に「ドメイン」と「それ以降」に分ける（プロトコルは表示しない）
function splitUrlForDisplay(url) {
  const match = url.match(/^https?:\/\/([^/?#]+)(.*)$/i)
  if (!match) {
    return { host: url, rest: '' }
  }
  return { host: match[1], rest: match[2] }
}

function renderLineSegments(line, onCopyText, keyPrefix) {
  const parts = line.split(URL_SPLIT_PATTERN)
  const items = parts.map((part, index) => {
    if (STRICT_URL_PATTERN.test(part)) {
      const { host, rest } = splitUrlForDisplay(part)
      return (
        <span className="note-seg note-seg--url" key={`${keyPrefix}-url-${index}`}>
          <span className="note-url-chip" title={part}>
            <GlobeIcon />
            <span className="note-url-label">
              <span className="note-url-host">{host}</span>
              {rest ? <span className="note-url-rest">{rest}</span> : null}
            </span>
          </span>
          <span className="note-seg-actions">
            <button
              type="button"
              className="note-link-icon note-link-icon--copy"
              onClick={() => void onCopyText(part)}
              aria-label={`URLをコピー: ${part}`}
              title="URLをコピー"
            >
              <PaperclipIcon />
            </button>
            <a
              className="note-link-icon note-link-icon--open"
              href={part}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(event) => handleExternalLinkClick(event, part)}
              aria-label={`リンクを開く: ${part}`}
              title="リンクを開く"
            >
              <ExternalLinkIcon />
            </a>
          </span>
        </span>
      )
    }

    const visibleText = part.trim()
    if (!visibleText) {
      return null
    }

    return (
      <span className="note-seg note-seg--text" key={`${keyPrefix}-txt-${index}`}>
        <span className="note-seg-text">{part.trimEnd()}</span>
        <span className="note-seg-actions">
          <button
            type="button"
            className="note-link-icon note-link-icon--copy"
            onClick={() => void onCopyText(visibleText)}
            aria-label="テキストをコピー"
            title="テキストをコピー"
          >
            <PaperclipIcon />
          </button>
        </span>
      </span>
    )
  })

  return items.some(Boolean) ? items : (
    <span className="note-line-placeholder" aria-hidden="true">
      {'\u00a0'}
    </span>
  )
}

function renderNoteBody(text, onCopyText) {
  const lines = text.split('\n')

  return lines.map((line, index) => {
    const keyPrefix = `line-${index}`
    const isEmptyLine = line.length === 0

    return (
      <span className={`note-line${isEmptyLine ? ' note-line--empty' : ''}`} key={keyPrefix}>
        <span className="note-line-content">
          {isEmptyLine ? (
            <span className="note-line-placeholder" aria-hidden="true">
              {'\u00a0'}
            </span>
          ) : (
            renderLineSegments(line, onCopyText, keyPrefix)
          )}
        </span>
      </span>
    )
  })
}

// 更新日時を「〇分前」「〇日前」のような短い表記にする
function formatRelativeTime(millis, now) {
  if (!millis) {
    return 'たった今'
  }

  const diffMinutes = Math.floor(Math.max(0, now - millis) / 60000)
  if (diffMinutes < 1) {
    return 'たった今'
  }
  if (diffMinutes < 60) {
    return `${diffMinutes}分前`
  }

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) {
    return `${diffHours}時間前`
  }

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) {
    return '昨日'
  }
  if (diffDays < 7) {
    return `${diffDays}日前`
  }

  const date = new Date(millis)
  const monthDay = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === new Date(now).getFullYear()
    ? monthDay
    : `${date.getFullYear()}年${monthDay}`
}

function matchesSearch(note, normalizedQuery) {
  if (!normalizedQuery) {
    return true
  }
  return String(note.body ?? '').toLowerCase().includes(normalizedQuery)
}

function isInteractiveDragTarget(target) {
  if (!(target instanceof Element)) {
    return false
  }

  return Boolean(target.closest('button,a,input,textarea'))
}

function isSubmitShortcut(event) {
  return event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme)
  const [isUrlExpanded, setIsUrlExpanded] = useState(getInitialUrlExpanded)
  const [isTouchLayout, setIsTouchLayout] = useState(getInitialTouchLayout)
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(!firebaseConfigError)
  const [notesLoading, setNotesLoading] = useState(false)
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [authPending, setAuthPending] = useState(false)
  const [editId, setEditId] = useState('')
  const [editBody, setEditBody] = useState('')
  const [dragId, setDragId] = useState('')
  const [touchDragId, setTouchDragId] = useState('')
  const [dragMovedId, setDragMovedId] = useState('')
  const [dragFollower, setDragFollower] = useState(null)
  const [insertGapPx, setInsertGapPx] = useState(INSERT_GAP_PX)
  const [dropIndicator, setDropIndicator] = useState(null)
  const [swipePreview, setSwipePreview] = useState({
    noteId: '',
    direction: '',
    progress: 0,
    offset: 0,
  })
  const [swipeSettleId, setSwipeSettleId] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [copyToastVisible, setCopyToastVisible] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const draftInputRef = useRef(null)
  const notesListRef = useRef(null)
  const swipeSettleTimerRef = useRef(null)
  const dragIdRef = useRef('')
  const longPressTimerRef = useRef(null)
  const copyToastTimerRef = useRef(null)
  const transparentDragImageRef = useRef(null)
  const dragFollowerRafRef = useRef(0)
  const dragAutoScrollRafRef = useRef(0)
  const dragAutoScrollRef = useRef({ noteId: '', clientY: NaN })
  const pendingDragFollowerRef = useRef({ noteId: '', clientX: 0, clientY: 0 })
  const lastDragFollowerRef = useRef({ noteId: '', clientX: NaN, clientY: NaN })
  const dropIndicatorRef = useRef(null)
  const touchScrollLockRef = useRef(false)
  const preventTouchScrollRef = useRef(null)
  const swipeRef = useRef({
    noteId: '',
    startX: 0,
    startY: 0,
    itemLeft: 0,
    itemTop: 0,
    itemWidth: 0,
    itemHeight: 0,
  })
  const orderedNotes = useMemo(() => sortNotes(notes), [notes])
  const orderedNotesById = useMemo(() => {
    const byId = new Map()
    orderedNotes.forEach((note) => {
      byId.set(note.id, note)
    })
    return byId
  }, [orderedNotes])
  const noteGroupMetaById = useMemo(() => {
    const byId = new Map()
    const pinnedNotes = orderedNotes.filter((note) => Boolean(note.pinned))
    const regularNotes = orderedNotes.filter((note) => !note.pinned)

    pinnedNotes.forEach((note, index) => {
      byId.set(note.id, { pinned: true, index, size: pinnedNotes.length })
    })

    regularNotes.forEach((note, index) => {
      byId.set(note.id, { pinned: false, index, size: regularNotes.length })
    })

    return byId
  }, [orderedNotes])
  const canSubmitDraft = normalizeBody(draft).length > 0
  const canSaveEdit = normalizeBody(editBody).length > 0
  const normalizedSearchQuery = searchQuery.trim().toLowerCase()
  // 検索中は一部のメモしか表示されないため、ドラッグでの並べ替えは止める
  const isSearching = normalizedSearchQuery.length > 0

  // 「〇分前」の表示を古くしないよう、1分ごとに現在時刻を更新する
  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timerId)
  }, [])

  // 入力欄の高さを内容に合わせて伸び縮みさせる
  useEffect(() => {
    const textarea = draftInputRef.current
    if (!textarea) {
      return
    }
    textarea.style.height = 'auto'
    const borderHeight = textarea.offsetHeight - textarea.clientHeight
    textarea.style.height = `${textarea.scrollHeight + borderHeight}px`
  }, [draft, user])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

  useEffect(() => {
    try {
      window.localStorage.setItem(URL_EXPANDED_STORAGE_KEY, String(isUrlExpanded))
    } catch {
      // 保存できない環境（プライベートブラウズなど）では、その場の切り替えだけ効かせる
    }
  }, [isUrlExpanded])

  useEffect(() => {
    dropIndicatorRef.current = dropIndicator
  }, [dropIndicator])

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined
    }

    const mediaQuery = window.matchMedia(TOUCH_LAYOUT_QUERY)
    const syncTouchLayout = (event) => {
      setIsTouchLayout(event.matches)
    }

    setIsTouchLayout(mediaQuery.matches)

    if (typeof mediaQuery.addEventListener === 'function') {
      mediaQuery.addEventListener('change', syncTouchLayout)
      return () => mediaQuery.removeEventListener('change', syncTouchLayout)
    }

    mediaQuery.addListener(syncTouchLayout)
    return () => mediaQuery.removeListener(syncTouchLayout)
  }, [])

  useEffect(() => {
    return () => {
      if (longPressTimerRef.current) {
        window.clearTimeout(longPressTimerRef.current)
      }
      if (copyToastTimerRef.current) {
        window.clearTimeout(copyToastTimerRef.current)
      }
      if (swipeSettleTimerRef.current) {
        window.clearTimeout(swipeSettleTimerRef.current)
      }
      if (dragFollowerRafRef.current) {
        window.cancelAnimationFrame(dragFollowerRafRef.current)
      }
      if (dragAutoScrollRafRef.current) {
        window.cancelAnimationFrame(dragAutoScrollRafRef.current)
      }
      if (typeof window !== 'undefined' && preventTouchScrollRef.current) {
        window.removeEventListener('touchmove', preventTouchScrollRef.current, { capture: true })
        preventTouchScrollRef.current = null
      }
      if (typeof document !== 'undefined') {
        document.documentElement.classList.remove('is-note-dragging')
        document.body.classList.remove('is-note-dragging')
      }
      touchScrollLockRef.current = false
    }
  }, [])

  useEffect(() => {
    if (typeof Image === 'undefined') {
      return
    }

    const image = new Image()
    image.src = TRANSPARENT_DRAG_PIXEL
    transparentDragImageRef.current = image
  }, [])

  useEffect(() => {
    if (!auth) {
      return undefined
    }

    const unsubscribe = onAuthStateChanged(auth, (nextUser) => {
      setUser(nextUser)
      setAuthLoading(false)
    })

    return unsubscribe
  }, [])

  useEffect(() => {
    if (!db || !user) {
      setNotes([])
      setNotesLoading(false)
      return undefined
    }

    setNotesLoading(true)
    const notesQuery = query(collection(db, 'notes'), where('uid', '==', user.uid))

    const unsubscribe = onSnapshot(
      notesQuery,
      (snapshot) => {
        const nextNotes = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }))
        setNotes(nextNotes)
        setNotesLoading(false)
      },
      (error) => {
        if (
          error?.code === 'permission-denied' ||
          error?.code === 'firestore/permission-denied'
        ) {
          setNotes([])
          setNotesLoading(false)
          setErrorMessage('このアカウントは利用できません。許可済みアカウントでログインしてください。')
          if (auth) {
            void signOut(auth).catch(() => { })
          }
          return
        }
        setErrorMessage(getErrorMessage(error))
        setNotesLoading(false)
      },
    )

    return unsubscribe
  }, [user])

  const handleSignIn = async () => {
    if (!auth) {
      return
    }

    if (authPending) {
      return
    }

    setErrorMessage('')
    setAuthPending(true)

    try {
      await signInWithPopup(auth, provider)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setAuthPending(false)
    }
  }

  const handleSignOut = async () => {
    if (!auth) {
      return
    }

    if (authPending) {
      return
    }

    setErrorMessage('')
    setAuthPending(true)

    try {
      await signOut(auth)
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    } finally {
      setAuthPending(false)
    }
  }

  const handleToggleTheme = () => {
    const toggleTheme = () => {
      setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
    }

    const shouldReduceMotion =
      typeof window !== 'undefined' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const canUseViewTransition =
      !shouldReduceMotion &&
      typeof document !== 'undefined' &&
      typeof document.startViewTransition === 'function'

    if (!canUseViewTransition) {
      toggleTheme()
      return
    }

    const rootElement = document.documentElement
    rootElement.classList.add('is-theme-switching')
    try {
      const transition = document.startViewTransition(() => {
        toggleTheme()
      })

      void transition.finished
        .catch(() => { })
        .finally(() => {
          rootElement.classList.remove('is-theme-switching')
        })
    } catch {
      toggleTheme()
      rootElement.classList.remove('is-theme-switching')
    }
  }

  const submitCreate = () => {
    if (!db || !user) {
      return
    }

    const body = normalizeBody(draft)
    if (!body) {
      return
    }

    const nextSortIndex = findGroupTopIndex(orderedNotes, false)

    setErrorMessage('')
    setDraft('')
    draftInputRef.current?.focus()

    void addDoc(collection(db, 'notes'), {
      uid: user.uid,
      body,
      pinned: false,
      sortIndex: nextSortIndex,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    }).catch((error) => {
      setErrorMessage(getErrorMessage(error))
      setDraft((current) => (current ? current : body))
    })
  }

  const handleCreate = (event) => {
    event.preventDefault()
    void submitCreate()
  }

  const handleDraftKeyDown = (event) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (isSubmitShortcut(event)) {
      event.preventDefault()
      void submitCreate()
    }
  }

  const startEdit = (note) => {
    setEditId(note.id)
    setEditBody(note.body)
  }

  const cancelEdit = () => {
    setEditId('')
    setEditBody('')
  }

  const handleUpdate = async (noteId = editId, rawBody = editBody) => {
    if (!db || !user || !noteId) {
      return
    }

    const body = normalizeBody(rawBody)
    if (!body) {
      return
    }

    const previousEditId = editId
    const previousEditBody = editBody

    cancelEdit()
    setErrorMessage('')

    try {
      await updateDoc(doc(db, 'notes', noteId), {
        uid: user.uid,
        body,
        updatedAt: serverTimestamp(),
      })
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
      if (previousEditId === noteId) {
        setEditId(noteId)
        setEditBody(previousEditBody || body)
      }
    }
  }

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
  }

  const lockTouchScroll = () => {
    if (touchScrollLockRef.current) {
      return
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    const preventTouchScroll = (event) => {
      if (event.cancelable) {
        event.preventDefault()
      }
    }

    touchScrollLockRef.current = true
    preventTouchScrollRef.current = preventTouchScroll
    document.documentElement.classList.add('is-note-dragging')
    document.body.classList.add('is-note-dragging')
    window.addEventListener('touchmove', preventTouchScroll, { passive: false, capture: true })
  }

  const unlockTouchScroll = () => {
    if (!touchScrollLockRef.current) {
      return
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    if (preventTouchScrollRef.current) {
      window.removeEventListener('touchmove', preventTouchScrollRef.current, { capture: true })
      preventTouchScrollRef.current = null
    }
    touchScrollLockRef.current = false
    document.documentElement.classList.remove('is-note-dragging')
    document.body.classList.remove('is-note-dragging')
  }

  const clearDragState = () => {
    clearLongPressTimer()
    unlockTouchScroll()
    if (dragFollowerRafRef.current) {
      window.cancelAnimationFrame(dragFollowerRafRef.current)
      dragFollowerRafRef.current = 0
    }
    if (dragAutoScrollRafRef.current) {
      window.cancelAnimationFrame(dragAutoScrollRafRef.current)
      dragAutoScrollRafRef.current = 0
    }
    dragAutoScrollRef.current = { noteId: '', clientY: NaN }
    pendingDragFollowerRef.current = { noteId: '', clientX: 0, clientY: 0 }
    lastDragFollowerRef.current = { noteId: '', clientX: NaN, clientY: NaN }
    dropIndicatorRef.current = null
    dragIdRef.current = ''
    setDragId('')
    setTouchDragId('')
    setDragMovedId('')
    setDragFollower(null)
    setInsertGapPx(INSERT_GAP_PX)
    setDropIndicator(null)
  }

  const clearSwipeState = () => {
    swipeRef.current = {
      noteId: '',
      startX: 0,
      startY: 0,
      itemLeft: 0,
      itemTop: 0,
      itemWidth: 0,
      itemHeight: 0,
    }
    setSwipePreview((current) =>
      current.noteId ? { noteId: '', direction: '', progress: 0, offset: 0 } : current,
    )
  }

  // 指を離したあと、カードが元の位置へなめらかに戻るアニメーションの間だけ印をつける
  const settleSwipe = (noteId) => {
    if (swipeSettleTimerRef.current) {
      window.clearTimeout(swipeSettleTimerRef.current)
    }
    setSwipeSettleId(noteId)
    swipeSettleTimerRef.current = window.setTimeout(() => {
      setSwipeSettleId('')
      swipeSettleTimerRef.current = null
    }, SWIPE_SETTLE_MS)
  }

  const handleCopyText = async (rawText) => {
    const text = typeof rawText === 'string' ? rawText : ''
    if (!text) {
      return
    }

    try {
      await copyTextToClipboard(text)
      if (copyToastTimerRef.current) {
        window.clearTimeout(copyToastTimerRef.current)
      }
      setCopyToastVisible(true)
      setErrorMessage((current) =>
        current === 'クリップボードへのコピーに失敗しました。' ? '' : current,
      )
      copyToastTimerRef.current = window.setTimeout(() => {
        setCopyToastVisible(false)
        copyToastTimerRef.current = null
      }, COPY_TOAST_DURATION_MS)
    } catch {
      setErrorMessage('クリップボードへのコピーに失敗しました。')
    }
  }

  const handleNoteRowClick = (note, event) => {
    if (editId || isInteractiveDragTarget(event.target)) {
      return
    }

    startEdit(note)
  }

  const updateDragFollowerPosition = (noteId, clientX, clientY) => {
    if (!noteId) {
      return
    }
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
      return
    }
    if (clientX <= 0 && clientY <= 0) {
      return
    }

    pendingDragFollowerRef.current = { noteId, clientX, clientY }
    if (dragFollowerRafRef.current) {
      return
    }

    dragFollowerRafRef.current = window.requestAnimationFrame(() => {
      dragFollowerRafRef.current = 0

      const pending = pendingDragFollowerRef.current
      const roundedX = Math.round(pending.clientX)
      const roundedY = Math.round(pending.clientY)
      const last = lastDragFollowerRef.current

      if (
        last.noteId === pending.noteId &&
        last.clientX === roundedX &&
        last.clientY === roundedY
      ) {
        return
      }

      setDragFollower((current) => {
        if (!current || current.noteId !== pending.noteId) {
          return current
        }

        lastDragFollowerRef.current = {
          noteId: pending.noteId,
          clientX: roundedX,
          clientY: roundedY,
        }

        return {
          ...current,
          currentX: roundedX,
          currentY: roundedY,
        }
      })
    })
  }

  const handleTogglePin = async (note) => {
    if (!db || !user) {
      return
    }

    const nextPinned = !note.pinned

    setErrorMessage('')

    try {
      await updateDoc(doc(db, 'notes', note.id), {
        uid: user.uid,
        pinned: nextPinned,
        sortIndex: nextPinned
          ? findPinnedTopIndex(orderedNotes)
          : findNextSortIndex(orderedNotes, false),
        updatedAt: serverTimestamp(),
      })
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const handleDragStart = (note, event) => {
    if (editId || note.pinned || isSearching || isInteractiveDragTarget(event.target)) {
      event.preventDefault()
      return
    }

    const targetRect = event.currentTarget.getBoundingClientRect()
    const startX =
      Number.isFinite(event.clientX) && event.clientX > 0
        ? event.clientX
        : targetRect.left + targetRect.width / 2
    const startY =
      Number.isFinite(event.clientY) && event.clientY > 0
        ? event.clientY
        : targetRect.top + targetRect.height / 2

    setErrorMessage('')
    dragIdRef.current = note.id
    setDragId(note.id)
    setDragMovedId('')
    setInsertGapPx(Math.round(targetRect.height) || INSERT_GAP_PX)
    setDragFollower({
      noteId: note.id,
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      itemLeft: targetRect.left,
      itemTop: targetRect.top,
      itemWidth: targetRect.width,
      itemHeight: targetRect.height,
    })
    lastDragFollowerRef.current = {
      noteId: note.id,
      clientX: Math.round(startX),
      clientY: Math.round(startY),
    }
    pendingDragFollowerRef.current = {
      noteId: note.id,
      clientX: startX,
      clientY: startY,
    }
    updateAutoScroll(note.id, startY)
    const dataTransfer = event.dataTransfer ?? null
    if (dataTransfer) {
      dataTransfer.effectAllowed = 'move'
      dataTransfer.setData('text/plain', note.id)
      if (transparentDragImageRef.current) {
        dataTransfer.setDragImage(transparentDragImageRef.current, 0, 0)
      }
    }
  }

  const handleDrag = (note, event) => {
    const activeDragId = dragIdRef.current || dragId
    if (activeDragId !== note.id) {
      return
    }

    updateDragFollowerPosition(note.id, event.clientX, event.clientY)
    updateAutoScroll(note.id, event.clientY)
  }

  const handleTouchContextMenu = (event) => {
    if (!isTouchLayout || editId || isInteractiveDragTarget(event.target)) {
      return
    }
    event.preventDefault()
  }

  const handleNoteSelectStart = (event) => {
    if (!isTouchLayout || editId || isInteractiveDragTarget(event.target)) {
      return
    }
    event.preventDefault()
  }

  const handleTouchStart = (note, event) => {
    if (editId || isInteractiveDragTarget(event.target)) {
      return
    }
    if (event.touches.length !== 1) {
      return
    }

    const touch = event.touches[0]
    const targetRect = event.currentTarget.getBoundingClientRect()
    swipeRef.current = {
      noteId: note.id,
      startX: touch.clientX,
      startY: touch.clientY,
      itemLeft: targetRect.left,
      itemTop: targetRect.top,
      itemWidth: targetRect.width,
      itemHeight: targetRect.height,
    }

    clearLongPressTimer()
    longPressTimerRef.current = window.setTimeout(() => {
      if (swipeRef.current.noteId !== note.id || editId || note.pinned || isSearching) {
        return
      }
      const dragStart = swipeRef.current
      lockTouchScroll()
      dragIdRef.current = note.id
      setDragId(note.id)
      setTouchDragId(note.id)
      setDragMovedId('')
      setInsertGapPx(Math.round(dragStart.itemHeight) || INSERT_GAP_PX)
      setDragFollower({
        noteId: note.id,
        startX: dragStart.startX,
        startY: dragStart.startY,
        currentX: dragStart.startX,
        currentY: dragStart.startY,
        itemLeft: dragStart.itemLeft,
        itemTop: dragStart.itemTop,
        itemWidth: dragStart.itemWidth,
        itemHeight: dragStart.itemHeight,
      })
      lastDragFollowerRef.current = {
        noteId: note.id,
        clientX: Math.round(dragStart.startX),
        clientY: Math.round(dragStart.startY),
      }
      pendingDragFollowerRef.current = {
        noteId: note.id,
        clientX: dragStart.startX,
        clientY: dragStart.startY,
      }
      setSwipePreview({ noteId: '', direction: '', progress: 0, offset: 0 })
    }, LONG_PRESS_DRAG_MS)
  }

  // ドロップ位置は「ドラッグ中のメモを除いたグループ内で何番目に入るか」（0..件数）で表す。
  // 他のメモの中心とポインタの位置を比べて決めるので、隙間が開いて周りのメモが動いても判定がぶれない。
  const updateDropIndicatorFromPoint = (activeDragId, clientY) => {
    if (!activeDragId || !Number.isFinite(clientY)) {
      return false
    }

    const draggingNote = orderedNotesById.get(activeDragId)
    const draggingMeta = noteGroupMetaById.get(activeDragId)
    if (!draggingNote || !draggingMeta) {
      return false
    }

    // ピン留め中のメモはドラッグ対象外
    if (draggingMeta.pinned) {
      return false
    }

    const listElement = notesListRef.current
    if (!listElement) {
      return false
    }

    const elementsById = new Map()
    listElement.querySelectorAll('li.note-item[data-note-id]').forEach((element) => {
      elementsById.set(element.dataset.noteId, element)
    })

    const otherNotes = orderedNotes.filter(
      (item) => Boolean(item.pinned) === draggingMeta.pinned && item.id !== activeDragId,
    )

    let nextIndex = 0
    for (const item of otherNotes) {
      const element = elementsById.get(item.id)
      if (!element) {
        continue
      }
      const rect = element.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        break
      }
      nextIndex += 1
    }

    const currentIndicator = dropIndicatorRef.current
    if (
      currentIndicator &&
      currentIndicator.pinned === draggingMeta.pinned &&
      currentIndicator.index === nextIndex
    ) {
      return false
    }

    const nextIndicator = { pinned: draggingMeta.pinned, index: nextIndex }
    dropIndicatorRef.current = nextIndicator
    setDropIndicator(nextIndicator)
    setDragMovedId((current) => (current === activeDragId ? current : activeDragId))

    return true
  }

  const stopAutoScroll = () => {
    if (dragAutoScrollRafRef.current) {
      window.cancelAnimationFrame(dragAutoScrollRafRef.current)
      dragAutoScrollRafRef.current = 0
    }
    dragAutoScrollRef.current = { noteId: '', clientY: NaN }
  }

  const runAutoScroll = () => {
    if (dragAutoScrollRafRef.current) {
      return
    }
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      return
    }

    dragAutoScrollRafRef.current = window.requestAnimationFrame(() => {
      dragAutoScrollRafRef.current = 0

      const { noteId, clientY } = dragAutoScrollRef.current
      if (!noteId || !Number.isFinite(clientY)) {
        return
      }

      const viewportHeight = window.innerHeight || 0
      if (viewportHeight <= 0) {
        return
      }

      let scrollDelta = 0
      if (clientY <= AUTO_SCROLL_EDGE_PX) {
        const ratio = Math.min(1, (AUTO_SCROLL_EDGE_PX - Math.max(0, clientY)) / AUTO_SCROLL_EDGE_PX)
        scrollDelta = -Math.max(1, Math.round(AUTO_SCROLL_MAX_STEP_PX * ratio * ratio))
      } else if (clientY >= viewportHeight - AUTO_SCROLL_EDGE_PX) {
        const distance = Math.max(0, viewportHeight - clientY)
        const ratio = Math.min(1, (AUTO_SCROLL_EDGE_PX - distance) / AUTO_SCROLL_EDGE_PX)
        scrollDelta = Math.max(1, Math.round(AUTO_SCROLL_MAX_STEP_PX * ratio * ratio))
      }

      if (scrollDelta !== 0) {
        const scrollingElement = document.scrollingElement || document.documentElement
        const currentTop = window.scrollY || scrollingElement.scrollTop || 0
        const maxTop = Math.max(0, scrollingElement.scrollHeight - viewportHeight)
        const nextTop = Math.max(0, Math.min(maxTop, currentTop + scrollDelta))

        if (nextTop !== currentTop) {
          window.scrollTo(0, nextTop)
        }
      }

      if (dragAutoScrollRef.current.noteId) {
        runAutoScroll()
      }
    })
  }

  const updateAutoScroll = (noteId, clientY) => {
    if (!noteId || !Number.isFinite(clientY)) {
      stopAutoScroll()
      return
    }

    const viewportHeight =
      typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 0
    const boundedY =
      viewportHeight > 0 ? Math.max(0, Math.min(viewportHeight, clientY)) : Math.max(0, clientY)
    dragAutoScrollRef.current = { noteId, clientY: boundedY }
    runAutoScroll()
  }

  const handleTouchMove = (note, event) => {
    if (editId) {
      return
    }

    const swipeState = swipeRef.current
    if (swipeState.noteId !== note.id || event.touches.length !== 1) {
      return
    }

    const touch = event.touches[0]
    const deltaX = touch.clientX - swipeState.startX
    const deltaY = touch.clientY - swipeState.startY
    const absDeltaX = Math.abs(deltaX)
    const absDeltaY = Math.abs(deltaY)

    const activeTouchDragId = touchDragId || dragIdRef.current
    if (activeTouchDragId && swipeState.noteId === activeTouchDragId) {
      if (event.cancelable) {
        event.preventDefault()
      }
      updateDragFollowerPosition(activeTouchDragId, touch.clientX, touch.clientY)
      updateAutoScroll(activeTouchDragId, touch.clientY)

      const moveDistance = Math.hypot(deltaX, deltaY)
      const hasActivatedDragMove =
        dragMovedId === activeTouchDragId || moveDistance >= TOUCH_DRAG_ACTIVATE_MOVE_PX

      if (!hasActivatedDragMove) {
        if (dropIndicatorRef.current) {
          dropIndicatorRef.current = null
          setDropIndicator(null)
        }
        return
      }

      void updateDropIndicatorFromPoint(activeTouchDragId, touch.clientY)
      return
    }

    if (absDeltaX > TOUCH_DRAG_MOVE_THRESHOLD_PX || absDeltaY > TOUCH_DRAG_MOVE_THRESHOLD_PX) {
      clearLongPressTimer()
    }

    if (absDeltaX < SWIPE_MOVE_START_PX || absDeltaX < absDeltaY * SWIPE_DIRECTION_RATIO) {
      setSwipePreview((current) =>
        current.noteId === note.id ? { noteId: '', direction: '', progress: 0, offset: 0 } : current,
      )
      return
    }

    if (event.cancelable) {
      event.preventDefault()
    }

    const progress = Math.min(absDeltaX / SWIPE_TRIGGER_PX, 1)
    const direction = deltaX > 0 ? (note.pinned ? 'unpin' : 'pin') : 'delete'
    const offset = getSwipeOffset(deltaX)

    setSwipePreview((current) => {
      if (
        current.noteId === note.id &&
        current.direction === direction &&
        current.offset === offset
      ) {
        return current
      }
      return { noteId: note.id, direction, progress, offset }
    })
  }

  const handleTouchEnd = (note, event) => {
    clearLongPressTimer()

    if (editId) {
      clearDragState()
      clearSwipeState()
      return
    }

    const activeTouchDragId = touchDragId || dragIdRef.current
    if (activeTouchDragId) {
      const draggingNote = orderedNotesById.get(activeTouchDragId)
      if (draggingNote) {
        let insertIndex = -1
        if (dropIndicator && dropIndicator.pinned === Boolean(draggingNote.pinned)) {
          insertIndex = dropIndicator.index
        } else {
          const currentGroup = orderedNotes.filter(
            (item) => Boolean(item.pinned) === Boolean(draggingNote.pinned),
          )
          insertIndex = currentGroup.findIndex((item) => item.id === activeTouchDragId)
        }

        if (insertIndex >= 0) {
          void reorderWithinGroup(activeTouchDragId, Boolean(draggingNote.pinned), insertIndex)
        }
      }

      clearDragState()
      clearSwipeState()
      return
    }

    const swipeState = swipeRef.current
    if (swipeState.noteId !== note.id) {
      clearSwipeState()
      return
    }

    const touch = event.changedTouches[0]
    if (swipePreview.noteId === note.id) {
      settleSwipe(note.id)
    }
    clearSwipeState()

    if (!touch) {
      return
    }

    const deltaX = touch.clientX - swipeState.startX
    const deltaY = touch.clientY - swipeState.startY
    const absDeltaX = Math.abs(deltaX)
    const absDeltaY = Math.abs(deltaY)

    if (
      absDeltaX < TOUCH_DRAG_MOVE_THRESHOLD_PX &&
      absDeltaY < TOUCH_DRAG_MOVE_THRESHOLD_PX
    ) {
      startEdit(note)
      return
    }

    if (
      absDeltaX < SWIPE_TRIGGER_PX ||
      absDeltaX < absDeltaY * SWIPE_DIRECTION_RATIO
    ) {
      return
    }

    if (deltaX > 0) {
      void handleTogglePin(note)
      return
    }

    void handleDelete(note.id)
  }

  // toIndex は移動後のグループ内での位置（ドラッグ中のメモを除いた並びに差し込む位置）
  const reorderWithinGroup = async (activeDragId, targetPinned, toIndex) => {
    if (!db || !user || !activeDragId) {
      return
    }

    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === targetPinned)
    const fromIndex = currentGroup.findIndex((item) => item.id === activeDragId)
    if (fromIndex < 0) {
      return
    }

    const safeToIndex = Math.max(0, Math.min(toIndex, currentGroup.length - 1))
    if (fromIndex === safeToIndex) {
      return
    }

    const reordered = [...currentGroup]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(safeToIndex, 0, moved)

    setErrorMessage('')

    try {
      const batch = writeBatch(db)
      let updateCount = 0

      reordered.forEach((item, index) => {
        const noteIndex = getSortIndex(item)
        if (noteIndex !== index) {
          batch.update(doc(db, 'notes', item.id), {
            uid: user.uid,
            sortIndex: index,
          })
          updateCount += 1
        }
      })

      if (updateCount > 0) {
        await batch.commit()
      }
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  // メモ同士の隙間やスペーサーの上でも反応するよう、ドラッグオーバー／ドロップはリスト全体で受ける
  const handleListDragOver = (event) => {
    const activeDragId = dragIdRef.current || dragId
    if (!activeDragId) {
      return
    }

    updateDragFollowerPosition(activeDragId, event.clientX, event.clientY)
    updateAutoScroll(activeDragId, event.clientY)
    event.preventDefault()
    if (event.dataTransfer) {
      event.dataTransfer.dropEffect = 'move'
    }
    void updateDropIndicatorFromPoint(activeDragId, event.clientY)
  }

  const handleListDrop = async (event) => {
    const activeDragId = dragIdRef.current || dragId
    if (!activeDragId) {
      return
    }

    event.preventDefault()
    const indicatorSnapshot = dropIndicatorRef.current
    clearDragState()

    if (!indicatorSnapshot) {
      return
    }

    const draggingNote = orderedNotesById.get(activeDragId)
    if (!draggingNote || indicatorSnapshot.pinned !== Boolean(draggingNote.pinned)) {
      // ピン留め中のメモと通常メモはドラッグ&ドロップで混在させない
      return
    }

    await reorderWithinGroup(activeDragId, Boolean(draggingNote.pinned), indicatorSnapshot.index)
  }

  const handleEditKeyDown = (event, noteId) => {
    if (event.nativeEvent.isComposing) {
      return
    }

    if (isSubmitShortcut(event)) {
      event.preventDefault()
      void handleUpdate(noteId, event.currentTarget.value)
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      cancelEdit()
    }
  }

  const handleDelete = async (id) => {
    if (!db) {
      return
    }

    const ok = window.confirm('削除します。よろしいですか？')
    if (!ok) {
      return
    }

    setErrorMessage('')

    try {
      await deleteDoc(doc(db, 'notes', id))
      if (editId === id) {
        cancelEdit()
      }
      if (dragId === id) {
        clearDragState()
      }
      clearSwipeState()
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const renderConfigError = () => (
    <section className="setup-card">
      <h1>Firebase設定が未完了です</h1>
      <p><code>.env.example</code> をもとに <code>.env.local</code> を作成し、値を設定してください。</p>
      <p className="hint">{firebaseConfigError}</p>
    </section>
  )

  const renderSignIn = () => (
    <section className="signin-card">
      <span className="app-logo app-logo--large" aria-hidden="true">
        <LogoIcon size={24} />
      </span>
      <h1>MemoMe</h1>
      <p>Googleでログインするとメモが保存されます。</p>
      <button
        type="button"
        className="btn-login"
        onClick={handleSignIn}
        disabled={authPending}
      >
        Googleでログイン
      </button>
    </section>
  )

  const renderAuthLoading = () => (
    <section className="loading-screen" aria-live="polite" aria-label="読み込み中">
      <div className="loading-spinner" />
    </section>
  )

  const renderNoteItem = (note, spacerBeforeId, spacerAfterId, dropSpacer) => {
    const isEditing = editId === note.id
    const isDragging = dragId === note.id
    const isTouchDragging = touchDragId === note.id
    const dragFollowState =
      dragFollower && dragFollower.noteId === note.id ? dragFollower : null
    const isDragFollowing = Boolean(dragFollowState && dragMovedId === note.id)
    const swipeHint =
      swipePreview.noteId === note.id && !isTouchDragging ? swipePreview : null
    const showDesktopActions = !isTouchLayout
    const canDrag = !isEditing && !isTouchLayout && !note.pinned && !isSearching
    const isSwipeArmed = Boolean(swipeHint && swipeHint.progress >= 1)
    const itemStyle = {}
    if (swipeHint) {
      itemStyle['--swipe-progress'] = swipeHint.progress
      itemStyle['--swipe-x'] = `${swipeHint.offset}px`
      itemStyle['--swipe-reveal'] = `${Math.abs(swipeHint.offset)}px`
    }
    if (dragFollowState) {
      itemStyle['--drag-dx'] = `${Math.round(dragFollowState.currentX - dragFollowState.startX)}px`
      itemStyle['--drag-dy'] = `${Math.round(dragFollowState.currentY - dragFollowState.startY)}px`
      itemStyle['--drag-left'] = `${Math.round(dragFollowState.itemLeft)}px`
      itemStyle['--drag-top'] = `${Math.round(dragFollowState.itemTop)}px`
      itemStyle['--drag-width'] = `${Math.round(dragFollowState.itemWidth)}px`
    }

    return (
      <Fragment key={note.id}>
        {spacerBeforeId === note.id ? dropSpacer : null}
        <li
          className={[
            'note-item',
            note.pinned ? 'note-item--pinned' : '',
            canDrag ? 'note-item--draggable' : '',
            isEditing ? 'note-item--editing' : '',
            isDragging ? 'note-item--dragging' : '',
            isTouchDragging ? 'note-item--touch-dragging' : '',
            isDragFollowing ? 'note-item--drag-follow' : '',
            swipeHint && swipeHint.direction === 'delete'
              ? 'note-item--swipe-delete'
              : swipeHint && swipeHint.direction === 'pin'
                ? 'note-item--swipe-pin'
                : swipeHint && swipeHint.direction === 'unpin'
                  ? 'note-item--swipe-unpin'
                  : '',
            swipeSettleId === note.id && !swipeHint ? 'note-item--swipe-settle' : '',
          ]
            .filter(Boolean)
            .join(' ')}
          data-note-id={note.id}
          style={Object.keys(itemStyle).length > 0 ? itemStyle : undefined}
          draggable={canDrag}
          onDragStart={(event) => handleDragStart(note, event)}
          onDrag={(event) => handleDrag(note, event)}
          onDragEnd={clearDragState}
          onTouchStart={(event) => handleTouchStart(note, event)}
          onTouchMove={(event) => handleTouchMove(note, event)}
          onTouchEnd={(event) => void handleTouchEnd(note, event)}
          onContextMenu={handleTouchContextMenu}
          onSelectStart={handleNoteSelectStart}
          onTouchCancel={() => {
            clearDragState()
            clearSwipeState()
          }}
        >
          {swipeHint ? (
            <div
              className={[
                'note-swipe-hint',
                swipeHint.direction === 'delete'
                  ? 'note-swipe-hint--delete'
                  : swipeHint.direction === 'pin'
                    ? 'note-swipe-hint--pin'
                    : 'note-swipe-hint--unpin',
                isSwipeArmed ? 'is-armed' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-hidden="true"
            >
              <span className="note-swipe-hint-icon">
                {swipeHint.direction === 'delete' ? (
                  <TrashIcon size={20} />
                ) : swipeHint.direction === 'pin' ? (
                  <PinIcon size={20} />
                ) : (
                  <PinOffIcon size={20} />
                )}
              </span>
              <span className="note-swipe-hint-label">
                {swipeHint.direction === 'delete'
                  ? '削除'
                  : swipeHint.direction === 'pin'
                    ? 'ピン留め'
                    : '解除'}
              </span>
            </div>
          ) : null}
          {canDrag ? (
            <span className="note-grip" aria-hidden="true">
              <GripIcon />
            </span>
          ) : null}
          {isEditing ? (
            <>
              <textarea
                className="note-edit-input"
                value={editBody}
                onChange={(event) => setEditBody(event.target.value)}
                onKeyDown={(event) => handleEditKeyDown(event, note.id)}
                aria-label="メモを編集"
                autoFocus
                rows={2}
              />
              <div className="actions">
                <button
                  type="button"
                  onClick={() => void handleUpdate(note.id, editBody)}
                  disabled={!canSaveEdit}
                >
                  保存
                </button>
                <button type="button" className="btn-logout" onClick={cancelEdit}>
                  キャンセル
                </button>
                {showDesktopActions ? (
                  <button
                    type="button"
                    className="danger"
                    onClick={() => handleDelete(note.id)}
                  >
                    削除
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <div className="note-row" onClick={(event) => handleNoteRowClick(note, event)}>
              <div className="note-main">
                <div className="note-body">{renderNoteBody(note.body, handleCopyText)}</div>
                <span className="note-meta">{formatRelativeTime(toMillis(note.updatedAt), now)}</span>
              </div>
              {showDesktopActions ? (
                <div className="note-actions">
                  <button
                    type="button"
                    className={`note-action-btn pin-icon-btn ${note.pinned ? 'is-active' : ''}`}
                    onClick={() => handleTogglePin(note)}
                    aria-label={note.pinned ? 'ピン留め解除' : 'ピン留め'}
                    title={note.pinned ? 'ピン留め解除' : 'ピン留め'}
                  >
                    <PinIcon filled={Boolean(note.pinned)} />
                  </button>
                  <button
                    type="button"
                    className="note-action-btn delete-icon-btn"
                    onClick={() => handleDelete(note.id)}
                    aria-label="削除"
                    title="削除"
                  >
                    <TrashIcon />
                  </button>
                </div>
              ) : isTouchLayout && note.pinned ? (
                <span className="note-pinned-badge" role="img" aria-label="ピン留め中">
                  <PinIcon filled />
                </span>
              ) : null}
            </div>
          )}
        </li>
        {spacerAfterId === note.id ? dropSpacer : null}
      </Fragment>
    )
  }

  const renderNotes = () => {
    const displayName = user.displayName || 'Googleユーザー'
    const avatarFallback = displayName.trim().slice(0, 1) || 'G'
    const themeLabel = theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'
    const urlToggleLabel = isUrlExpanded ? 'URLを1行に省略して表示' : 'URLを折り返して全部表示'

    const visibleNotes = orderedNotes.filter((note) => matchesSearch(note, normalizedSearchQuery))
    const pinnedNotes = visibleNotes.filter((note) => Boolean(note.pinned))
    const regularNotes = visibleNotes.filter((note) => !note.pinned)

    // ドロップ位置（ドラッグ中のメモを除いた並びでの位置）から、隙間を差し込むメモを決める
    let spacerBeforeId = ''
    let spacerAfterId = ''
    if (dropIndicator && dragId) {
      const otherNotes = orderedNotes.filter(
        (item) => Boolean(item.pinned) === dropIndicator.pinned && item.id !== dragId,
      )
      if (dropIndicator.index < otherNotes.length) {
        spacerBeforeId = otherNotes[dropIndicator.index].id
      } else {
        spacerAfterId = otherNotes.length > 0 ? otherNotes[otherNotes.length - 1].id : dragId
      }
    }
    const dropSpacer = <li className="note-drop-spacer" aria-hidden="true" />

    let countLabel = `${notes.length} 件`
    if (notesLoading) {
      countLabel = '同期中…'
    } else if (isSearching) {
      countLabel = `${visibleNotes.length} / ${notes.length} 件`
    }

    return (
      <>
        <header className="app-header">
          <div className="app-brand">
            <span className="app-logo" aria-hidden="true">
              <LogoIcon />
            </span>
            <span className="app-name">MemoMe</span>
          </div>
          <div className="header-tools">
            <button
              type="button"
              className="theme-toggle"
              onClick={() => setIsUrlExpanded((current) => !current)}
              aria-label={urlToggleLabel}
              aria-pressed={isUrlExpanded}
              title={urlToggleLabel}
            >
              {isUrlExpanded ? <CollapseIcon /> : <ExpandIcon />}
            </button>
            <button
              type="button"
              className="theme-toggle"
              onClick={handleToggleTheme}
              aria-label={themeLabel}
              title={themeLabel}
            >
              {theme === 'dark' ? <SunIcon /> : <MoonIcon />}
            </button>
            <div className="header-user">
              {user.photoURL ? (
                <img
                  className="header-avatar"
                  src={user.photoURL}
                  alt={`${displayName}のプロフィール画像`}
                  referrerPolicy="no-referrer"
                />
              ) : (
                <span className="header-avatar header-avatar-fallback" aria-hidden="true">
                  {avatarFallback}
                </span>
              )}
              <p>{displayName}</p>
            </div>
            <button
              type="button"
              className="btn-logout btn-logout--icon"
              onClick={handleSignOut}
              disabled={authPending}
              aria-label="ログアウト"
              title="ログアウト"
            >
              <LogoutIcon />
            </button>
          </div>
        </header>

        <form className="composer" onSubmit={handleCreate}>
          <label htmlFor="new-note" className="sr-only">新しいメモ</label>
          <textarea
            id="new-note"
            ref={draftInputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={handleDraftKeyDown}
            placeholder="メモを入力…"
            rows={1}
          />
          <div className="composer-footer">
            <span className="composer-hint">
              <kbd>Ctrl</kbd>
              <span>+</span>
              <kbd>Enter</kbd>
              <span>で追加</span>
            </span>
            <button
              type="submit"
              className="btn-add"
              disabled={!canSubmitDraft}
              aria-label="追加"
            >
              <span className="btn-add-icon btn-add-icon--plus">
                <PlusIcon />
              </span>
              <span className="btn-add-icon btn-add-icon--send">
                <ArrowUpIcon />
              </span>
              <span className="btn-add-label">追加</span>
            </button>
          </div>
        </form>

        <section className="notes-section">
          <h2 className="sr-only">保存したメモ</h2>
          <div className="notes-toolbar">
            <label htmlFor="note-search" className="sr-only">メモを検索</label>
            <div className="search-field">
              <SearchIcon />
              <input
                id="note-search"
                type="search"
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder="メモを検索"
                autoComplete="off"
              />
            </div>
            <span className="notes-count">{countLabel}</span>
          </div>

          {notes.length === 0 && !notesLoading ? (
            <p className="empty-state">メモがありません</p>
          ) : isSearching && visibleNotes.length === 0 ? (
            <p className="empty-state">「{searchQuery.trim()}」に一致するメモはありません</p>
          ) : (
            <div
              ref={notesListRef}
              className={`notes-groups${isUrlExpanded ? ' notes-groups--url-expanded' : ''}`}
              style={{ '--insert-gap': `${insertGapPx}px` }}
              onDragOver={handleListDragOver}
              onDrop={(event) => void handleListDrop(event)}
            >
              {pinnedNotes.length > 0 ? (
                <div className="notes-group">
                  <h3 className="notes-group-title">
                    <PinIcon filled size={13} />
                    ピン留め · {pinnedNotes.length}
                  </h3>
                  <ul className="notes-list">
                    {pinnedNotes.map((note) =>
                      renderNoteItem(note, spacerBeforeId, spacerAfterId, dropSpacer),
                    )}
                  </ul>
                </div>
              ) : null}
              {regularNotes.length > 0 ? (
                <div className="notes-group">
                  <h3 className="notes-group-title">メモ · {regularNotes.length}</h3>
                  <ul className="notes-list">
                    {regularNotes.map((note) =>
                      renderNoteItem(note, spacerBeforeId, spacerAfterId, dropSpacer),
                    )}
                  </ul>
                </div>
              ) : null}
            </div>
          )}
        </section>
      </>
    )
  }

  return (
    <main className="app-shell">
      {firebaseConfigError ? renderConfigError() : null}
      {!firebaseConfigError && authLoading ? renderAuthLoading() : null}
      {!firebaseConfigError && !authLoading && !user ? renderSignIn() : null}
      {!firebaseConfigError && !authLoading && user ? renderNotes() : null}
      {errorMessage ? <p className="error">{errorMessage}</p> : null}
      {copyToastVisible ? (
        <p className="copy-toast" role="status" aria-live="polite">
          コピーしました
        </p>
      ) : null}
    </main>
  )
}

export default App
