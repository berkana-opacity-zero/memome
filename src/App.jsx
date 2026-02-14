import { useEffect, useMemo, useRef, useState } from 'react'
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

function findPinnedTopIndex(items) {
  const pinnedNotes = items.filter((note) => Boolean(note.pinned))
  if (pinnedNotes.length === 0) {
    return 0
  }

  const minIndex = pinnedNotes.reduce((minValue, note) => {
    const noteIndex = getSortIndex(note)
    if (noteIndex === null) {
      return minValue
    }
    return Math.min(minValue, noteIndex)
  }, 0)

  return minIndex - 1
}

function formatTimestamp(value) {
  const ms = toMillis(value)

  if (!ms) {
    return ''
  }

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(ms)
}

function getErrorMessage(error) {
  const message = typeof error?.message === 'string' ? error.message : 'Unexpected error.'

  if (message.includes('Missing or insufficient permissions')) {
    return 'Firestoreの権限エラーです。Firebaseコンソールのルール設定を確認してください。'
  }

  if (message.includes('The query requires an index')) {
    return 'Firestoreのインデックス作成が必要です。Firebaseコンソールのエラーリンクから作成してください。'
  }

  return message
}

function renderLinkedText(text) {
  return text.split(URL_SPLIT_PATTERN).map((part, index) => {
    if (STRICT_URL_PATTERN.test(part)) {
      return (
        <a key={`url-${index}`} href={part} target="_blank" rel="noopener noreferrer">
          {part}
        </a>
      )
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

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(!firebaseConfigError)
  const [notesLoading, setNotesLoading] = useState(false)
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [authPending, setAuthPending] = useState(false)
  const [editId, setEditId] = useState('')
  const [editBody, setEditBody] = useState('')
  const [dragId, setDragId] = useState('')
  const [dropIndicator, setDropIndicator] = useState(null)
  const [errorMessage, setErrorMessage] = useState('')
  const draftInputRef = useRef(null)
  const dragIdRef = useRef('')
  const orderedNotes = useMemo(() => sortNotes(notes), [notes])
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

  const submitCreate = () => {
    if (!db || !user) {
      return
    }

    const body = normalizeBody(draft)
    if (!body) {
      return
    }

    const nextSortIndex = findNextSortIndex(orderedNotes, false)

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

  const clearDragState = () => {
    dragIdRef.current = ''
    setDragId('')
    setDropIndicator(null)
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

    setErrorMessage('')
    dragIdRef.current = note.id
    setDragId(note.id)
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', note.id)
  }

  const handleDragOver = (note, event) => {
    const activeDragId = dragIdRef.current || dragId || event.dataTransfer.getData('text/plain')
    if (!activeDragId || activeDragId === note.id) {
      return
    }

    const draggingNote = orderedNotes.find((item) => item.id === activeDragId)
    if (!draggingNote) {
      return
    }

    const targetPinned = Boolean(note.pinned)
    if (Boolean(draggingNote.pinned) !== targetPinned) {
      return
    }

    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === targetPinned)
    const targetIndex = currentGroup.findIndex((item) => item.id === note.id)
    if (targetIndex < 0) {
      return
    }

    const rect = event.currentTarget.getBoundingClientRect()
    const shouldInsertAfter = event.clientY > rect.top + rect.height / 2
    const nextDropIndex = targetIndex + (shouldInsertAfter ? 1 : 0)

    setDropIndicator((current) => {
      if (current && current.pinned === targetPinned && current.index === nextDropIndex) {
        return current
      }
      return { pinned: targetPinned, index: nextDropIndex }
    })
  }

  const handleDrop = async (targetNote, event) => {
    event.preventDefault()

    const activeDragId = dragIdRef.current || dragId || event.dataTransfer.getData('text/plain')

    if (!db || !user || !activeDragId || activeDragId === targetNote.id) {
      clearDragState()
      return
    }

    const draggingNote = orderedNotes.find((item) => item.id === activeDragId)
    if (!draggingNote) {
      clearDragState()
      return
    }

    const targetPinned = Boolean(targetNote.pinned)
    if (Boolean(draggingNote.pinned) !== targetPinned) {
      setErrorMessage('ピン留め中のメモと通常メモは別グループで並び替えてください。')
      clearDragState()
      return
    }

    const currentGroup = orderedNotes.filter((item) => Boolean(item.pinned) === targetPinned)
    const fromIndex = currentGroup.findIndex((item) => item.id === activeDragId)
    if (fromIndex < 0) {
      clearDragState()
      return
    }

    let insertIndex = currentGroup.findIndex((item) => item.id === targetNote.id)
    if (dropIndicator && dropIndicator.pinned === targetPinned) {
      insertIndex = dropIndicator.index
    }
    if (insertIndex < 0) {
      clearDragState()
      return
    }
    insertIndex = Math.max(0, Math.min(insertIndex, currentGroup.length))

    const toIndex = insertIndex > fromIndex ? insertIndex - 1 : insertIndex
    if (fromIndex === toIndex) {
      clearDragState()
      return
    }

    const reordered = [...currentGroup]
    const [moved] = reordered.splice(fromIndex, 1)
    reordered.splice(toIndex, 0, moved)

    setErrorMessage('')

    try {
      const batch = writeBatch(db)
      let updateCount = 0

      reordered.forEach((note, index) => {
        const noteIndex = getSortIndex(note)
        if (noteIndex !== index) {
          batch.update(doc(db, 'notes', note.id), {
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
    } finally {
      clearDragState()
    }
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

    const ok = window.confirm('Delete this note?')
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
    } catch (error) {
      setErrorMessage(getErrorMessage(error))
    }
  }

  const renderConfigError = () => (
    <section className="setup-card">
      <h1>Firebase config is missing</h1>
      <p>Create <code>.env.local</code> from <code>.env.example</code> and fill your values.</p>
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

  const renderNotes = () => (
    <>
      <header className="app-header">
        <div>
          <h1>MemoMe</h1>
          <p>{user.displayName || 'Google User'}</p>
        </div>
        <button
          type="button"
          className="btn-logout"
          onClick={handleSignOut}
          disabled={authPending}
        >
          ログアウト
        </button>
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
          {notesLoading ? <span>同期中...</span> : <span>{notes.length} items</span>}
        </div>

        {notes.length === 0 && !notesLoading ? (
          <p className="empty-state">メモがありません</p>
        ) : (
          <ul className="notes-list">
            {orderedNotes.map((note) => {
              const isEditing = editId === note.id
              const isDragging = dragId === note.id
              const noteGroupMeta = noteGroupMetaById.get(note.id)
              const isInsertBefore = Boolean(
                dropIndicator &&
                  noteGroupMeta &&
                  dropIndicator.pinned === noteGroupMeta.pinned &&
                  dropIndicator.index === noteGroupMeta.index &&
                  dragId !== note.id,
              )
              const isInsertAfter = Boolean(
                dropIndicator &&
                  noteGroupMeta &&
                  noteGroupMeta.index === noteGroupMeta.size - 1 &&
                  dropIndicator.pinned === noteGroupMeta.pinned &&
                  dropIndicator.index === noteGroupMeta.size &&
                  dragId !== note.id,
              )
              const updatedLabel = formatTimestamp(note.updatedAt)

              return (
                <li
                  key={note.id}
                  className={[
                    'note-item',
                    note.pinned ? 'note-item--pinned' : '',
                    isDragging ? 'note-item--dragging' : '',
                    isInsertBefore ? 'note-item--insert-before' : '',
                    isInsertAfter ? 'note-item--insert-after' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable={!isEditing}
                  onDragStart={(event) => handleDragStart(note, event)}
                  onDragOver={(event) => handleDragOver(note, event)}
                  onDrop={(event) => void handleDrop(note, event)}
                  onDragEnd={clearDragState}
                >
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
                    <small>{updatedLabel ? `Updated: ${updatedLabel}` : ''}</small>
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
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDelete(note.id)}
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </>
  )

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
