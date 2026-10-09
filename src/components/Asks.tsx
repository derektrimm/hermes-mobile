import { useEffect, useState } from 'react'

import { haptic } from '../lib/haptics'
import { openByLiveId } from '../lib/hermes'
import { type Ask, useStore } from '../lib/store'
import { ChevronIcon } from './icons'

// Commands whose first word deserves a second look before allowing them.
const RISKY = /^(\s*)(sudo|rm|dd|mkfs\S*|shred|chmod|chown|kill|pkill|killall|reboot|shutdown|git push --force|git reset --hard|pacman -R\S*)\b/

function Command({ text }: { text: string }) {
  const match = text.match(RISKY)

  if (!match) {
    return <pre className="ask-command">{text}</pre>
  }

  return (
    <pre className="ask-command">
      {match[1]}
      <span className="risky">{match[2]}</span>
      {text.slice(match[0].length)}
    </pre>
  )
}

/** Who is asking, when it is not simply this phone's own chat. */
function useAsker(ask: Ask) {
  const chat = useStore(s => s.chat)

  if (ask.backend.startsWith('pc-')) {
    return 'Asked by the Hermes window on your PC'
  }

  if (ask.backend !== 'main') {
    return 'Asked by the chat open in the desktop app'
  }

  return ask.liveId === chat.liveId ? null : 'Asked in another chat'
}

function Head({ ask, title }: { ask: Ask; title: string }) {
  const asker = useAsker(ask)

  return (
    <>
      <div className="ask-head">
        <span className="dot" />
        <span>{title}</span>
      </div>
      {asker ? <p className="ask-asker">{asker}</p> : null}
    </>
  )
}

function answer(ask: Ask, result: Record<string, unknown>) {
  haptic()
  ask.respond(result)
}

function ApprovalCard({ ask }: { ask: Ask }) {
  const p = ask.params
  const choices = Array.isArray(p.choices) ? (p.choices as string[]) : ['once', 'session', 'always', 'deny']
  const allowSession = p.allow_session !== false && choices.includes('session')
  const allowAlways = p.allow_permanent !== false && choices.includes('always')
  const command = typeof p.command === 'string' ? p.command : ''
  const description = typeof p.description === 'string' ? p.description : ''

  return (
    <div className="ask">
      <Head ask={ask} title={p.smart_denied ? 'Hermes flagged this command' : 'Allow this command?'} />
      {description ? <p className="ask-text">{description}</p> : null}
      {command ? <Command text={command} /> : null}
      <div className="ask-actions">
        <button type="button" className="btn primary wide" onClick={() => answer(ask, { choice: 'once' })}>
          Allow once
        </button>
        {allowSession ? (
          <button type="button" className={`btn ${allowAlways ? '' : 'wide'}`} onClick={() => answer(ask, { choice: 'session' })}>
            For this chat
          </button>
        ) : null}
        {allowAlways ? (
          <button type="button" className={`btn ${allowSession ? '' : 'wide'}`} onClick={() => answer(ask, { choice: 'always' })}>
            Always
          </button>
        ) : null}
        <button type="button" className="btn danger wide" onClick={() => answer(ask, { choice: 'deny' })}>
          Deny
        </button>
      </div>
    </div>
  )
}

interface Question {
  qid: string
  question: string
  choices?: string[] | null
  multi_select?: boolean
}

function ClarifyCard({ ask }: { ask: Ask }) {
  const questions = (Array.isArray(ask.params.questions) ? ask.params.questions : []) as Question[]
  const [answers, setAnswers] = useState<Record<string, string[]>>({})
  const [other, setOther] = useState<Record<string, string>>({})

  const toggle = (q: Question, choice: string) =>
    setAnswers(current => {
      const picked = current[q.qid] ?? []

      if (q.multi_select) {
        return { ...current, [q.qid]: picked.includes(choice) ? picked.filter(c => c !== choice) : [...picked, choice] }
      }

      return { ...current, [q.qid]: [choice] }
    })

  // Answers shaped as the desktop app sends them (apps/.../clarify/pending.tsx): several picks as a
  // JSON list with any typed text added, one pick as itself (a pick wins over typed text), else the
  // typed text, else null for a question left unanswered.
  const answerFor = (q: Question): string | null => {
    const typed = other[q.qid]?.trim()
    const picked = answers[q.qid] ?? []

    if (q.multi_select) {
      const all = [...picked, ...(typed ? [typed] : [])]

      return all.length ? JSON.stringify(all) : null
    }

    return picked[0] ?? (typed || null)
  }

  const result = () => Object.fromEntries(questions.map(q => [q.qid, answerFor(q)]))

  const complete = questions.some(q => answerFor(q) !== null)

  return (
    <div className="ask">
      <Head ask={ask} title="Hermes has a question" />
      {questions.map(q => (
        <div key={q.qid} className="ask-question">
          <p className="ask-text">{q.question}</p>
          {q.choices?.length ? (
            <div className="chips">
              {q.choices.map(choice => (
                <button
                  key={choice}
                  type="button"
                  className={`chip ${answers[q.qid]?.includes(choice) ? 'on' : ''}`}
                  aria-pressed={Boolean(answers[q.qid]?.includes(choice))}
                  onClick={() => toggle(q, choice)}
                >
                  {choice}
                </button>
              ))}
            </div>
          ) : null}
          <input
            className="field"
            aria-label={q.choices?.length ? 'Or type an answer' : 'Your answer'}
            placeholder={q.choices?.length ? 'Or type an answer' : 'Your answer'}
            value={other[q.qid] ?? ''}
            onChange={event => setOther(current => ({ ...current, [q.qid]: event.target.value }))}
          />
        </div>
      ))}
      <div className="ask-actions">
        <button type="button" className="btn primary wide" disabled={!complete} onClick={() => answer(ask, { answers: result() })}>
          Send answer
        </button>
        <button type="button" className="btn ghost wide" onClick={() => answer(ask, {})}>
          Skip
        </button>
      </div>
    </div>
  )
}

function SecretCard({ ask }: { ask: Ask }) {
  const [value, setValue] = useState('')
  const sudo = ask.method === 'sudo'
  const command = sudo && typeof ask.params.command === 'string' ? ask.params.command : ''
  const prompt = sudo ? '' : String(ask.params.prompt || `Value for ${String(ask.params.env_var || 'a secret')}`)

  return (
    <div className="ask">
      <Head ask={ask} title={sudo ? 'Password for sudo' : 'Secret needed'} />
      {prompt ? <p className="ask-text">{prompt}</p> : null}
      {command ? <Command text={command} /> : null}
      <input
        className="field"
        aria-label={sudo ? 'Sudo password' : prompt}
        type="password"
        autoComplete="off"
        autoCapitalize="off"
        enterKeyHint="done"
        value={value}
        onChange={event => setValue(event.target.value)}
        onKeyDown={event => event.key === 'Enter' && value && answer(ask, { value })}
      />
      <div className="ask-actions">
        <button type="button" className="btn primary wide" disabled={!value} onClick={() => answer(ask, { value })}>
          Submit
        </button>
        <button type="button" className="btn ghost wide" onClick={() => answer(ask, { value: '' })}>
          Cancel
        </button>
      </div>
    </div>
  )
}

export function Asks({ asks, liveId, backend }: { asks: Ask[]; liveId: string | null; backend: string }) {
  const mine = (a: Ask) => a.liveId === liveId && a.backend === backend
  const here = asks.filter(mine)
  const elsewhere = asks.filter(a => !mine(a))
  const newest = asks[asks.length - 1]?.id

  // A tick when a question arrives (iOS plays it only during a gesture; elsewhere it is free).
  useEffect(() => {
    if (newest) {
      haptic()
    }
  }, [newest])

  if (!here.length && !elsewhere.length) {
    return null
  }

  return (
    <div className="asks">
      {elsewhere.length ? (
        <button type="button" className="ask-elsewhere" onClick={() => void openByLiveId(elsewhere[0].liveId)}>
          <span className="dot" />
          <span>{elsewhere.length === 1 ? 'Another chat is waiting for your answer' : `${elsewhere.length} chats are waiting for your answer`}</span>
          <ChevronIcon size={16} />
        </button>
      ) : null}
      {here.slice(0, 1).map(ask =>
        ask.method === 'approval' ? (
          <ApprovalCard key={ask.id} ask={ask} />
        ) : ask.method === 'clarify' ? (
          <ClarifyCard key={ask.id} ask={ask} />
        ) : (
          <SecretCard key={ask.id} ask={ask} />
        )
      )}
    </div>
  )
}
