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
const TOUCH_LAYOUT_QUERY = '(hover: none) and (pointer: coarse)'
const SWIPE_TRIGGER_PX = 72
const SWIPE_DIRECTION_RATIO = 1.25
const SWIPE_MOVE_START_PX = 14
const LONG_PRESS_DRAG_MS = 360
const TOUCH_DRAG_MOVE_THRESHOLD_PX = 10
const TOUCH_DRAG_ACTIVATE_MOVE_PX = 8
const INSERT_GAP_PX = 72
const ALLOWED_USER_EMAILS = new Set([
  'gorizo.5170@gmail.com',
  'n.nanami73@gmail.com',
  'berkana.work@gmail.com',
])
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
  const message = typeof error?.message === 'string' ? error.message : '予期しないエラーが発生しました。'

  if (message.includes('Missing or insufficient permissions')) {
    return 'Firestoreの権限エラーです。Firebaseコンソールのルール設定を確認してください。'
  }

  if (message.includes('The query requires an index')) {
    return 'Firestoreのインデックス作成が必要です。Firebaseコンソールのエラーリンクから作成してください。'
  }

  return message
}

function renderLinkedText(text) {
  const parts = text.split(URL_SPLIT_PATTERN)

  return parts.map((part, index) => {
    if (STRICT_URL_PATTERN.test(part)) {
      return (
        <span className="note-url-item" key={`url-${index}`}>
          <span className="note-url-text">{part}</span>
          <a
            className="note-link-icon"
            href={part}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`リンクを開く: ${part}`}
            title="リンクを開く"
          >
            🔗
          </a>
        </span>
      )
    }

    if (!part) {
      return null
    }

    const prevPart = parts[index - 1] ?? ''
    const nextPart = parts[index + 1] ?? ''
    const isUrlSeparator =
      STRICT_URL_PATTERN.test(prevPart) &&
      STRICT_URL_PATTERN.test(nextPart) &&
      part.trim() === ''

    if (isUrlSeparator) {
      return <Fragment key={`sep-${index}`}>{'\n'}</Fragment>
    }

    return <span key={`txt-${index}`}>{part}</span>
  })
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

function normalizeEmail(value) {
  if (typeof value !== 'string') {
    return ''
  }

  return value.trim().toLowerCase()
}

function isAllowedUser(user) {
  return ALLOWED_USER_EMAILS.has(normalizeEmail(user?.email))
}

function App() {
  const [theme, setTheme] = useState(getInitialTheme)
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
  const [swipePreview, setSwipePreview] = useState({ noteId: '', direction: '', progress: 0 })
  const [errorMessage, setErrorMessage] = useState('')
  const draftInputRef = useRef(null)
  const dragIdRef = useRef('')
  const longPressTimerRef = useRef(null)
  const transparentDragImageRef = useRef(null)
  const dragFollowerRafRef = useRef(0)
  const pendingDragFollowerRef = useRef({ noteId: '', clientX: 0, clientY: 0 })
  const lastDragFollowerRef = useRef({ noteId: '', clientX: NaN, clientY: NaN })
  const lastDragProbeRef = useRef({ noteId: '', clientY: NaN })
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

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    window.localStorage.setItem(THEME_STORAGE_KEY, theme)
  }, [theme])

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
      if (dragFollowerRafRef.current) {
        window.cancelAnimationFrame(dragFollowerRafRef.current)
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
      if (nextUser && !isAllowedUser(nextUser)) {
        setUser(null)
        setNotes([])
        setAuthLoading(false)
        setErrorMessage('このアカウントは利用できません。許可済みアカウントでログインしてください。')
        void signOut(auth).catch(() => { })
        return
      }

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
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'))
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
    pendingDragFollowerRef.current = { noteId: '', clientX: 0, clientY: 0 }
    lastDragFollowerRef.current = { noteId: '', clientX: NaN, clientY: NaN }
    lastDragProbeRef.current = { noteId: '', clientY: NaN }
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
      current.noteId ? { noteId: '', direction: '', progress: 0 } : current,
    )
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
    if (editId || isInteractiveDragTarget(event.target)) {
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
    setInsertGapPx(Math.max(INSERT_GAP_PX, Math.round(targetRect.height)))
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
    lastDragProbeRef.current = {
      noteId: note.id,
      clientY: startY,
    }
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
    if (!isTouchLayout || editId || isInteractiveDragTarget(event.target)) {
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
      if (swipeRef.current.noteId !== note.id || editId) {
        return
      }
      const dragStart = swipeRef.current
      lockTouchScroll()
      dragIdRef.current = note.id
      setDragId(note.id)
      setTouchDragId(note.id)
      setDragMovedId('')
      setInsertGapPx(Math.max(INSERT_GAP_PX, Math.round(dragStart.itemHeight)))
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
      lastDragProbeRef.current = {
        noteId: note.id,
        clientY: dragStart.startY,
      }
      setSwipePreview({ noteId: '', direction: '', progress: 0 })
    }, LONG_PRESS_DRAG_MS)
  }

  const getDraggingVerticalBounds = (activeDragId) => {
    if (!activeDragId) {
      return null
    }

    const followerState = dragFollower && dragFollower.noteId === activeDragId ? dragFollower : null
    if (followerState) {
      const pending = pendingDragFollowerRef.current
      const latestY =
        pending.noteId === activeDragId && Number.isFinite(pending.clientY)
          ? pending.clientY
          : followerState.currentY
      const deltaY = latestY - followerState.startY
      const height = Math.max(1, Math.round(followerState.itemHeight || INSERT_GAP_PX))
      const top = followerState.itemTop + deltaY

      return { top, bottom: top + height, deltaY }
    }

    if (typeof document === 'undefined') {
      return null
    }

    const draggingElement = document.querySelector(`li.note-item[data-note-id="${activeDragId}"]`)
    if (!draggingElement) {
      return null
    }

    const rect = draggingElement.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom, deltaY: 0 }
  }

  const setInsertIndicatorByDragBounds = (activeDragId, probeClientY = NaN) => {
    if (!activeDragId || typeof document === 'undefined') {
      return false
    }

    const draggingNote = orderedNotesById.get(activeDragId)
    if (!draggingNote) {
      return false
    }

    const draggingBounds = getDraggingVerticalBounds(activeDragId)
    if (!draggingBounds) {
      return false
    }

    const previousProbe =
      lastDragProbeRef.current.noteId === activeDragId ? lastDragProbeRef.current.clientY : NaN
    if (Number.isFinite(probeClientY)) {
      lastDragProbeRef.current = { noteId: activeDragId, clientY: probeClientY }
    }

    const probeDeltaY =
      Number.isFinite(probeClientY) && Number.isFinite(previousProbe)
        ? probeClientY - previousProbe
        : 0

    const movingUp = probeDeltaY < -0.5 || draggingBounds.deltaY < -0.5
    const movingDown = probeDeltaY > 0.5 || draggingBounds.deltaY > 0.5
    if (!movingUp && !movingDown) {
      return false
    }

    const groupPinned = Boolean(draggingNote.pinned)
    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === groupPinned)
    const fromIndex = currentGroup.findIndex((item) => item.id === activeDragId)
    if (fromIndex < 0) {
      return false
    }

    const toTargetIndex = (insertIndex) => {
      const safeInsert = Math.max(0, Math.min(insertIndex, currentGroup.length))
      return safeInsert > fromIndex ? safeInsert - 1 : safeInsert
    }

    const toInsertIndex = (targetIndex) => {
      const maxTargetIndex = Math.max(currentGroup.length - 1, 0)
      const safeTarget = Math.max(0, Math.min(targetIndex, maxTargetIndex))
      return safeTarget > fromIndex ? safeTarget + 1 : safeTarget
    }

    const currentIndicator = dropIndicatorRef.current
    const currentInsertIndex =
      currentIndicator && currentIndicator.pinned === groupPinned ? currentIndicator.index : fromIndex
    const currentTargetIndex = toTargetIndex(currentInsertIndex)
    const others = currentGroup.filter((item) => item.id !== activeDragId)
    const clampedTargetIndex = Math.max(0, Math.min(currentTargetIndex, others.length))

    let nextTargetIndex = null

    if (movingUp && clampedTargetIndex > 0) {
      const aboveNote = others[clampedTargetIndex - 1]
      const aboveElement = document.querySelector(`li.note-item[data-note-id="${aboveNote.id}"]`)
      if (aboveElement) {
        const aboveRect = aboveElement.getBoundingClientRect()
        const aboveMiddle = aboveRect.top + aboveRect.height / 2
        if (draggingBounds.top <= aboveMiddle) {
          nextTargetIndex = clampedTargetIndex - 1
        }
      }
    } else if (movingDown && clampedTargetIndex < others.length) {
      const belowNote = others[clampedTargetIndex]
      const belowElement = document.querySelector(`li.note-item[data-note-id="${belowNote.id}"]`)
      if (belowElement) {
        const belowRect = belowElement.getBoundingClientRect()
        const belowMiddle = belowRect.top + belowRect.height / 2
        if (draggingBounds.bottom >= belowMiddle) {
          nextTargetIndex = clampedTargetIndex + 1
        }
      }
    }

    if (nextTargetIndex === null) {
      return false
    }

    const nextInsertIndex = toInsertIndex(nextTargetIndex)
    setDropIndicator((current) => {
      if (current && current.pinned === groupPinned && current.index === nextInsertIndex) {
        dropIndicatorRef.current = current
        return current
      }
      const nextIndicator = { pinned: groupPinned, index: nextInsertIndex }
      dropIndicatorRef.current = nextIndicator
      return nextIndicator
    })

    return true
  }

  const handleTouchMove = (note, event) => {
    if (!isTouchLayout || editId) {
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
      updateDragFollowerPosition(activeTouchDragId, touch.clientX, touch.clientY)

      const moveDistance = Math.hypot(deltaX, deltaY)
      const hasActivatedDragMove =
        dragMovedId === activeTouchDragId || moveDistance >= TOUCH_DRAG_ACTIVATE_MOVE_PX

      if (!hasActivatedDragMove) {
        dropIndicatorRef.current = null
        setDropIndicator(null)
        return
      }

      const didSetIndicator = setInsertIndicatorByDragBounds(activeTouchDragId, touch.clientY)
      if (!didSetIndicator) {
        return
      }
      if (dragMovedId !== activeTouchDragId) {
        setDragMovedId(activeTouchDragId)
      }
      return
    }

    if (absDeltaX > TOUCH_DRAG_MOVE_THRESHOLD_PX || absDeltaY > TOUCH_DRAG_MOVE_THRESHOLD_PX) {
      clearLongPressTimer()
    }

    if (
      absDeltaX < SWIPE_MOVE_START_PX ||
      absDeltaX < absDeltaY * SWIPE_DIRECTION_RATIO
    ) {
      setSwipePreview((current) =>
        current.noteId === note.id ? { noteId: '', direction: '', progress: 0 } : current,
      )
      return
    }

    const direction = deltaX > 0 ? 'edit' : 'delete'
    const progress = Math.min(absDeltaX / (SWIPE_TRIGGER_PX * 1.2), 1)

    setSwipePreview((current) => {
      if (
        current.noteId === note.id &&
        current.direction === direction &&
        Math.abs(current.progress - progress) < 0.02
      ) {
        return current
      }
      return { noteId: note.id, direction, progress }
    })
  }

  const handleTouchEnd = (note, event) => {
    clearLongPressTimer()

    if (!isTouchLayout || editId) {
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
    clearSwipeState()

    if (!touch) {
      return
    }

    const deltaX = touch.clientX - swipeState.startX
    const deltaY = touch.clientY - swipeState.startY
    const absDeltaX = Math.abs(deltaX)
    const absDeltaY = Math.abs(deltaY)

    if (absDeltaX < SWIPE_TRIGGER_PX || absDeltaX < absDeltaY * SWIPE_DIRECTION_RATIO) {
      return
    }

    if (deltaX > 0) {
      startEdit(note)
      return
    }

    void handleDelete(note.id)
  }

  const reorderWithinGroup = async (activeDragId, targetPinned, insertIndex) => {
    if (!db || !user || !activeDragId) {
      return
    }

    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === targetPinned)
    const fromIndex = currentGroup.findIndex((item) => item.id === activeDragId)
    if (fromIndex < 0) {
      return
    }

    const safeInsertIndex = Math.max(0, Math.min(insertIndex, currentGroup.length))
    const toIndex = safeInsertIndex > fromIndex ? safeInsertIndex - 1 : safeInsertIndex
    if (fromIndex === toIndex) {
      return
    }

    const reordered = [...currentGroup]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)

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

  const handleDragOver = (note, event) => {
    const dataTransfer = event.dataTransfer ?? null
    const activeDragId = dragIdRef.current || dragId || dataTransfer?.getData('text/plain') || ''
    updateDragFollowerPosition(activeDragId, event.clientX, event.clientY)
    if (!activeDragId || activeDragId === note.id) {
      return
    }

    event.preventDefault()
    if (dataTransfer) {
      dataTransfer.dropEffect = 'move'
    }
    const didSetIndicator = setInsertIndicatorByDragBounds(activeDragId, event.clientY)
    if (!didSetIndicator) {
      return
    }
    if (dragMovedId !== activeDragId) {
      setDragMovedId(activeDragId)
    }
  }

  const handleDropSpacerOver = (event) => {
    const dataTransfer = event.dataTransfer ?? null
    const activeDragId = dragIdRef.current || dragId || dataTransfer?.getData('text/plain') || ''
    updateDragFollowerPosition(activeDragId, event.clientX, event.clientY)
    if (!activeDragId || !dropIndicator) {
      return
    }

    event.preventDefault()
    if (dataTransfer) {
      dataTransfer.dropEffect = 'move'
    }
    if (dragMovedId !== activeDragId) {
      setDragMovedId(activeDragId)
    }
  }

  const handleDropByIndicator = async (event) => {
    event.preventDefault()
    event.stopPropagation()

    const dataTransfer = event.dataTransfer ?? null
    const activeDragId = dragIdRef.current || dragId || dataTransfer?.getData('text/plain') || ''
    const indicatorSnapshot = dropIndicator
    clearDragState()
    if (!activeDragId) {
      return
    }

    if (!indicatorSnapshot) {
      return
    }

    const draggingNote = orderedNotesById.get(activeDragId)
    if (!draggingNote) {
      return
    }

    if (indicatorSnapshot.pinned !== Boolean(draggingNote.pinned)) {
      return
    }

    await reorderWithinGroup(activeDragId, Boolean(draggingNote.pinned), indicatorSnapshot.index)
  }

  const handleDrop = async (targetNote, event) => {
    event.preventDefault()
    event.stopPropagation()

    const dataTransfer = event.dataTransfer ?? null
    const activeDragId = dragIdRef.current || dragId || dataTransfer?.getData('text/plain') || ''
    const indicatorSnapshot = dropIndicator
    clearDragState()

    if (!db || !user || !activeDragId) {
      return
    }

    if (indicatorSnapshot) {
      const draggingNote = orderedNotesById.get(activeDragId)
      if (draggingNote && indicatorSnapshot.pinned === Boolean(draggingNote.pinned)) {
        await reorderWithinGroup(
          activeDragId,
          Boolean(draggingNote.pinned),
          indicatorSnapshot.index,
        )
        return
      }
    }

    if (activeDragId === targetNote.id) {
      return
    }

    const draggingNote = orderedNotesById.get(activeDragId)
    if (!draggingNote) {
      clearDragState()
      return
    }

    const targetPinned = Boolean(targetNote.pinned)
    if (Boolean(draggingNote.pinned) !== targetPinned) {
      setErrorMessage('ピン留め中のメモと通常メモは別グループで並び替えてください。')
      return
    }

    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === targetPinned)
    let insertIndex = currentGroup.findIndex((item) => item.id === targetNote.id)
    if (dropIndicator && dropIndicator.pinned === targetPinned) {
      insertIndex = dropIndicator.index
    }
    if (insertIndex < 0) {
      return
    }

    await reorderWithinGroup(activeDragId, targetPinned, insertIndex)
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

  const renderNotes = () => {
    const displayName = user.displayName || 'Googleユーザー'
    const avatarFallback = displayName.trim().slice(0, 1) || 'G'

    return (
      <>
        <header className="app-header">
          <div className="header-user-row">
            <button
              type="button"
              className="theme-toggle"
              onClick={handleToggleTheme}
              aria-label={theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
              title={theme === 'dark' ? 'ライトモードに切り替え' : 'ダークモードに切り替え'}
            >
              <span aria-hidden="true">💡</span>
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
              className="btn-logout"
              onClick={handleSignOut}
              disabled={authPending}
            >
              ログアウト
            </button>
          </div>
        </header>

        <form className="composer" onSubmit={handleCreate}>
          <div className="composer-row">
            <textarea
              id="new-note"
              ref={draftInputRef}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={handleDraftKeyDown}
              placeholder="メモを入力してください"
              maxLength={200}
              rows={2}
            />
            <button type="submit" className="btn-add" disabled={!canSubmitDraft}>
              追加
            </button>
          </div>
        </form>

        <section className="notes-section">
          <div className="notes-title">
            <h2>保存したメモ</h2>
            {notesLoading ? <span>同期中...</span> : <span>{notes.length} 件</span>}
          </div>

          {notes.length === 0 && !notesLoading ? (
            <p className="empty-state">メモがありません</p>
          ) : (
            <ul className="notes-list" style={{ '--insert-gap': `${insertGapPx}px` }}>
              {orderedNotes.map((note) => {
                const isEditing = editId === note.id
                const isDragging = dragId === note.id
                const isTouchDragging = touchDragId === note.id
                const dragFollowState =
                  dragFollower && dragFollower.noteId === note.id ? dragFollower : null
                const isDragFollowing = Boolean(dragFollowState && dragMovedId === note.id)
                const noteGroupMeta = noteGroupMetaById.get(note.id)
                const isInsertBefore = Boolean(
                  dropIndicator &&
                  noteGroupMeta &&
                  dropIndicator.pinned === noteGroupMeta.pinned &&
                  dropIndicator.index === noteGroupMeta.index &&
                  (dragId !== note.id || noteGroupMeta.index === 0),
                )
                const isInsertAfter = Boolean(
                  dropIndicator &&
                  noteGroupMeta &&
                  noteGroupMeta.index === noteGroupMeta.size - 1 &&
                  dropIndicator.pinned === noteGroupMeta.pinned &&
                  dropIndicator.index === noteGroupMeta.size &&
                  dragId !== note.id,
                )
                const swipeHint =
                  swipePreview.noteId === note.id && !isTouchDragging ? swipePreview : null
                const showActions = isEditing || !isTouchLayout
                const itemStyle = {}
                if (swipeHint) {
                  itemStyle['--swipe-progress'] = swipeHint.progress
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
                  {isInsertBefore ? (
                    <li
                      className="note-drop-spacer"
                      aria-hidden="true"
                      onDragOver={handleDropSpacerOver}
                      onDrop={(event) => void handleDropByIndicator(event)}
                    />
                  ) : null}
                  <li
                    className={[
                      'note-item',
                      note.pinned ? 'note-item--pinned' : '',
                      isDragging ? 'note-item--dragging' : '',
                      isTouchDragging ? 'note-item--touch-dragging' : '',
                      isDragFollowing ? 'note-item--drag-follow' : '',
                      swipeHint && swipeHint.direction === 'edit' ? 'note-item--swipe-edit' : '',
                      swipeHint && swipeHint.direction === 'delete'
                        ? 'note-item--swipe-delete'
                        : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    data-note-id={note.id}
                    style={Object.keys(itemStyle).length > 0 ? itemStyle : undefined}
                    draggable={!isEditing && !isTouchLayout}
                    onDragStart={(event) => handleDragStart(note, event)}
                    onDrag={(event) => handleDrag(note, event)}
                    onDragOver={(event) => handleDragOver(note, event)}
                    onDrop={(event) => void handleDrop(note, event)}
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
                          swipeHint.direction === 'edit'
                            ? 'note-swipe-hint--edit'
                            : 'note-swipe-hint--delete',
                        ].join(' ')}
                      >
                        {swipeHint.direction === 'edit' ? '→ 編集' : '← 削除'}
                      </div>
                    ) : null}
                    {isEditing ? (
                      <textarea
                        className="note-edit-input"
                        value={editBody}
                        onChange={(event) => setEditBody(event.target.value)}
                        onKeyDown={(event) => handleEditKeyDown(event, note.id)}
                        autoFocus
                        maxLength={200}
                        rows={2}
                      />
                    ) : (
                      <div className="note-row">
                        <p>{renderLinkedText(note.body)}</p>
                        <button
                          type="button"
                          className={`pin-icon-btn ${note.pinned ? 'is-active' : ''}`}
                          onClick={() => handleTogglePin(note)}
                          aria-label={note.pinned ? 'ピン留め解除' : 'ピン留め'}
                          title={note.pinned ? 'ピン留め解除' : 'ピン留め'}
                        >
                          📌
                        </button>
                      </div>
                    )}

                    <div className="note-footer">
                      {showActions ? (
                        <div className="actions">
                          {isEditing ? (
                            <>
                              <button type="button" onClick={() => void handleUpdate(note.id, editBody)} disabled={!canSaveEdit}>
                                保存
                              </button>
                              <button type="button" className="btn-logout" onClick={cancelEdit}>
                                キャンセル
                              </button>
                            </>
                          ) : (
                            <button type="button" className="btn-edit" onClick={() => startEdit(note)}>
                              編集
                            </button>
                          )}
                          {!isTouchLayout ? (
                            <button
                              type="button"
                              className="danger"
                              onClick={() => handleDelete(note.id)}
                            >
                              削除
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  </li>
                  {isInsertAfter ? (
                    <li
                      className="note-drop-spacer"
                      aria-hidden="true"
                      onDragOver={handleDropSpacerOver}
                      onDrop={(event) => void handleDropByIndicator(event)}
                    />
                  ) : null}
                </Fragment>
              )
              })}
            </ul>
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
    </main>
  )
}

export default App
