import { useState } from 'react'

interface Props {
  onSend: (text: string) => void
  disabled: boolean
  placeholder?: string
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [text, setText] = useState('')

  function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
  }

  return (
    <div className="message-input">
      <input
        type="text"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') handleSubmit()
        }}
        placeholder={placeholder ?? (disabled ? 'Agent is responding...' : 'Type a message...')}
        disabled={disabled}
      />
      <button onClick={handleSubmit} disabled={disabled || !text.trim()}>
        Send
      </button>
    </div>
  )
}
