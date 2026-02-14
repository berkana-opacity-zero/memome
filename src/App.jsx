import { useEffect, useState } from 'react'
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
} from 'firebase/firestore'
import './App.css'
import { auth, db, firebaseConfigError } from './lib/firebase'

const provider = new GoogleAuthProvider()

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

function formatTimestamp(value) {
  const ms = toMillis(value)

  if (!ms) {
    return 'Saving...'
  }

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(ms)
}

function App() {
  const [user, setUser] = useState(null)
  const [authLoading, setAuthLoading] = useState(!firebaseConfigError)
  const [notesLoading, setNotesLoading] = useState(false)
  const [notes, setNotes] = useState([])
  const [draft, setDraft] = useState('')
  const [actionId, setActionId] = useState('')
  const [editId, setEditId] = useState('')
  const [editBody, setEditBody] = useState('')
  const [errorMessage, setErrorMessage] = useState('')

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
        const nextNotes = snapshot.docs
          .map((item) => ({ id: item.id, ...item.data() }))
          .sort((a, b) => toMillis(b.updatedAt) - toMillis(a.updatedAt))
        setNotes(nextNotes)
        setNotesLoading(false)
      },
      (error) => {
        setErrorMessage(error.message)
        setNotesLoading(false)
      },
    )

    return unsubscribe
  }, [user])

  const handleSignIn = async () => {
    if (!auth) {
      return
    }

    setErrorMessage('')
    setActionId('auth')

    try {
      await signInWithPopup(auth, provider)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setActionId('')
    }
  }

  const handleSignOut = async () => {
    if (!auth) {
      return
    }

    setErrorMessage('')
    setActionId('auth')

    try {
      await signOut(auth)
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setActionId('')
    }
  }

  const handleCreate = async (event) => {
    event.preventDefault()

    if (!db || !user) {
      return
    }

    const body = draft.trim()
    if (!body) {
      return
    }

    setErrorMessage('')
    setActionId('create')

    try {
      await addDoc(collection(db, 'notes'), {
        uid: user.uid,
        body,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      })
      setDraft('')
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setActionId('')
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

  const handleUpdate = async () => {
    if (!db || !editId) {
      return
    }

    const body = editBody.trim()
    if (!body) {
      return
    }

    setErrorMessage('')
    setActionId(`update:${editId}`)

    try {
      await updateDoc(doc(db, 'notes', editId), {
        body,
        updatedAt: serverTimestamp(),
      })
      cancelEdit()
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setActionId('')
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
    setActionId(`delete:${id}`)

    try {
      await deleteDoc(doc(db, 'notes', id))
      if (editId === id) {
        cancelEdit()
      }
    } catch (error) {
      setErrorMessage(error.message)
    } finally {
      setActionId('')
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
      <p>Google login keeps your notes synced across devices.</p>
      <button type="button" onClick={handleSignIn} disabled={actionId === 'auth'}>
        {actionId === 'auth' ? 'Signing in...' : 'Sign in with Google'}
      </button>
    </section>
  )

  const renderNotes = () => (
    <>
      <header className="app-header">
        <div>
          <h1>MemoMe</h1>
          <p>{user.email}</p>
        </div>
        <button type="button" onClick={handleSignOut} disabled={actionId === 'auth'}>
          {actionId === 'auth' ? 'Working...' : 'Sign out'}
        </button>
      </header>

      <form className="composer" onSubmit={handleCreate}>
        <label htmlFor="new-note">New note</label>
        <textarea
          id="new-note"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Write your memo..."
          rows={4}
        />
        <button type="submit" disabled={actionId === 'create' || !draft.trim()}>
          {actionId === 'create' ? 'Saving...' : 'Add note'}
        </button>
      </form>

      <section className="notes-section">
        <div className="notes-title">
          <h2>Your notes</h2>
          {notesLoading ? <span>Syncing...</span> : <span>{notes.length} items</span>}
        </div>

        {notes.length === 0 && !notesLoading ? (
          <p className="empty-state">No notes yet. Add your first memo above.</p>
        ) : (
          <ul className="notes-list">
            {notes.map((note) => {
              const isEditing = editId === note.id
              const isUpdating = actionId === `update:${note.id}`
              const isDeleting = actionId === `delete:${note.id}`

              return (
                <li key={note.id} className="note-item">
                  {isEditing ? (
                    <textarea
                      value={editBody}
                      onChange={(event) => setEditBody(event.target.value)}
                      rows={4}
                    />
                  ) : (
                    <p>{note.body}</p>
                  )}

                  <div className="note-footer">
                    <small>Updated: {formatTimestamp(note.updatedAt)}</small>
                    <div className="actions">
                      {isEditing ? (
                        <>
                          <button
                            type="button"
                            onClick={handleUpdate}
                            disabled={isUpdating || !editBody.trim()}
                          >
                            {isUpdating ? 'Saving...' : 'Save'}
                          </button>
                          <button type="button" onClick={cancelEdit} disabled={isUpdating}>
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => startEdit(note)}
                          disabled={Boolean(actionId)}
                        >
                          Edit
                        </button>
                      )}
                      <button
                        type="button"
                        className="danger"
                        onClick={() => handleDelete(note.id)}
                        disabled={isDeleting || isUpdating}
                      >
                        {isDeleting ? 'Deleting...' : 'Delete'}
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
      {!firebaseConfigError && authLoading ? <p className="hint">Checking session...</p> : null}
      {!firebaseConfigError && !authLoading && !user ? renderSignIn() : null}
      {!firebaseConfigError && !authLoading && user ? renderNotes() : null}
      {errorMessage ? <p className="error">{errorMessage}</p> : null}
    </main>
  )
}

export default App
