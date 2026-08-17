import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { Icon } from './Icon'
import { Ripple } from './Ripple'
import { cx } from './utils'
import './SearchBar.css'

export interface SearchSuggestion {
  id: string
  /** Libelle principal. */
  headline: string
  /** Complement discret sur la meme ligne. */
  supporting?: string
  leadingIcon?: string
  /** Pastille de couleur, pour les objets qui en ont une. */
  dot?: string
  /** Valeur alignee a droite : magnitude, hauteur. */
  trailing?: ReactNode
}

export interface SearchBarProps {
  value: string
  onChange: (value: string) => void
  /** Resultats proposes sous le champ. Une liste vide referme le volet. */
  suggestions: readonly SearchSuggestion[]
  onSelect: (id: string) => void
  placeholder?: string
  label?: string
  /** Message affiche quand une saisie ne donne aucun resultat. */
  emptyText?: string
  className?: string
}

/**
 * Barre de recherche MD3, en forme pleine, avec volet de resultats attache.
 *
 * Le volet ne s'ouvre que lorsqu'il a quelque chose a montrer, et la navigation
 * au clavier reste complete : fleches pour parcourir, Entree pour valider,
 * Echap pour refermer sans perdre la saisie.
 */
export function SearchBar({
  value,
  onChange,
  suggestions,
  onSelect,
  placeholder = 'Rechercher',
  label = 'Rechercher',
  emptyText,
  className,
}: SearchBarProps) {
  const [focused, setFocused] = useState(false)
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  // L'indice actif se recale des que la liste change : sans cela, une frappe
  // rapide validerait un resultat qui n'est plus a la meme place.
  useEffect(() => setActive(0), [suggestions])

  // Un clic hors du composant referme le volet, mais conserve la saisie.
  useEffect(() => {
    if (!focused) return
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setFocused(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [focused])

  const showEmpty = Boolean(emptyText) && value.trim().length > 0 && suggestions.length === 0
  const open = focused && (suggestions.length > 0 || showEmpty)

  const commit = (id: string) => {
    onSelect(id)
    setFocused(false)
    inputRef.current?.blur()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setFocused(false)
      return
    }
    if (suggestions.length === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((i) => (i + 1) % suggestions.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((i) => (i - 1 + suggestions.length) % suggestions.length)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      commit(suggestions[Math.min(active, suggestions.length - 1)].id)
    }
  }

  return (
    <div ref={rootRef} className={cx('md-search', open && 'is-open', className)}>
      <div className="md-search__bar">
        <Icon name="search" size={20} className="md-search__leading" />
        <input
          ref={inputRef}
          type="search"
          role="combobox"
          className="md-search__input md-type-body-large"
          value={value}
          placeholder={placeholder}
          aria-label={label}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          aria-autocomplete="list"
          autoComplete="off"
          spellCheck={false}
          onFocus={() => setFocused(true)}
          onChange={(e) => {
            onChange(e.target.value)
            setFocused(true)
          }}
          onKeyDown={onKeyDown}
        />
        {value.length > 0 && (
          <button
            type="button"
            className="md-search__clear"
            aria-label="Effacer la recherche"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
          >
            <Icon name="close" size={18} />
          </button>
        )}
      </div>

      {open && (
        <div className="md-search__panel">
          {showEmpty ? (
            <p className="md-type-body-medium md-search__empty">{emptyText}</p>
          ) : (
            <ul id={listId} role="listbox" className="md-search__list">
              {suggestions.map((s, i) => (
                <li key={s.id} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    className={cx('md-search__option', i === active && 'is-active')}
                    onPointerEnter={() => setActive(i)}
                    onClick={() => commit(s.id)}
                  >
                    <Ripple />
                    {s.dot && <span className="md-search__dot" style={{ background: s.dot }} />}
                    {s.leadingIcon && !s.dot && <Icon name={s.leadingIcon} size={20} className="md-search__icon" />}
                    <span className="md-search__text">
                      <span className="md-type-body-large md-search__headline">{s.headline}</span>
                      {s.supporting && <span className="md-type-body-small md-search__support">{s.supporting}</span>}
                    </span>
                    {s.trailing && <span className="md-type-label-large md-numeric md-search__trailing">{s.trailing}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
