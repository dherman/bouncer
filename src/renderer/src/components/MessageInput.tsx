import { useEffect, useRef, useState } from 'react'

interface Props {
  onSend: (text: string) => void
  disabled: boolean
  placeholder?: string
}

export function MessageInput({ onSend, disabled, placeholder }: Props) {
  const [text, setText] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const wasDisabled = useRef(disabled)

  // Focus on mount and refocus when transitioning from disabled to enabled
  useEffect(() => {
    if (!disabled) {
      inputRef.current?.focus()
    }
    wasDisabled.current = disabled
  }, [disabled])

  function handleSubmit() {
    const trimmed = text.trim()
    if (!trimmed || disabled) return
    onSend(trimmed)
    setText('')
    // Keep focus after sending
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  return (
    <div className="message-input">
      <input
        ref={inputRef}
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
