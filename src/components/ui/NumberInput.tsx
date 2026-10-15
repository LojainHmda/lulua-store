import { useEffect, useRef, useState, type ChangeEvent, type FocusEvent, type InputHTMLAttributes } from "react";

// Reusable numeric-input behavior, shared by admin, POS, and (if ever
// needed) the storefront -- see the numeric-input-UX-audit report this was
// built from. Fixes, in one place instead of per-field: a permanent "0"
// nobody typed, native browser spinners, and clamping mid-keystroke that
// makes typing a new number impossible without first deleting the old one.
//
// Deliberately renders `type="text"` + `inputMode` rather than
// `type="number"` -- this is what makes native spinners structurally
// impossible (they only exist for type="number") without relying on
// cross-browser CSS overrides, and it's what lets keystroke filtering be
// exact (e.g. rejecting a second "." or a bare "e", which native number
// inputs actually accept as valid scientific notation).

// null always means "no value" -- never silently treated as 0. Callers that
// must always end up with a real number (e.g. price) simply ignore a null
// onChange call rather than writing it into their own state; see each call
// site for the short `(v) => v !== null && setX(v)` pattern this implies.
export type NumericValue = number | null;

// Parses a draft string as typed so far. Returns null for the empty string
// and for any in-progress state that isn't a finished number yet ("-", ".",
// "-.") -- never NaN, never a silent 0.
export function parseNumericInput(raw: string): NumericValue {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-" || trimmed === "." || trimmed === "-.") return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

export function clampNumericValue(n: number, opts: { min?: number; max?: number; integerOnly?: boolean }): number {
  let v = opts.integerOnly ? Math.round(n) : n;
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return v;
}

export interface NumberInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "value" | "onChange" | "defaultValue"> {
  /** null = no value. Never a forced 0 -- see the module doc comment. */
  value: NumericValue;
  /** Fires on every keystroke with the live, UNCLAMPED value (or null while
   *  empty / mid-typing an unfinished number). Clamping/rounding only ever
   *  happens at blur -- see clampNumericValue above. */
  onChange: (value: NumericValue) => void;
  /** Integer-only fields (stock qty, sort order, day counts). Default false
   *  = decimals allowed (prices, fees, percentages). */
  integerOnly?: boolean;
  /** Applied only at blur, never mid-keystroke -- so typing past a would-be
   *  ceiling/floor is never blocked, only settled once editing is done. */
  min?: number;
  max?: number;
  /** true: the field may legitimately rest empty (null) once blurred, e.g.
   *  an optional compare-at price or stock that's never been confirmed.
   *  false (default): the field must always resolve to a real number at
   *  rest -- clearing it and blurring without typing a replacement reverts
   *  to the last real value, it never becomes/stays empty. */
  nullable?: boolean;
}

export function NumberInput({
  value,
  onChange,
  integerOnly = false,
  min,
  max,
  nullable = false,
  onFocus,
  onBlur,
  className,
  ...rest
}: NumberInputProps) {
  const [draft, setDraft] = useState(value === null ? "" : String(value));
  // A ref, not state -- read synchronously inside the value-sync effect
  // below without that effect itself needing to depend on (and re-run for)
  // focus changes.
  const focusedRef = useRef(false);

  // Re-derives the visible text from the external value whenever it changes
  // from OUTSIDE this field (a parent reset, a fresh row loaded, etc.) --
  // but never while the user is actively typing here, so a parent re-render
  // mid-edit (even one triggered by this same field's own onChange) can
  // never yank back what's being typed.
  useEffect(() => {
    if (!focusedRef.current) setDraft(value === null ? "" : String(value));
  }, [value]);

  const charPattern = integerOnly
    ? min !== undefined && min >= 0
      ? /^\d*$/
      : /^-?\d*$/
    : min !== undefined && min >= 0
      ? /^\d*\.?\d*$/
      : /^-?\d*\.?\d*$/;

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const raw = e.target.value;
    if (raw !== "" && !charPattern.test(raw)) return; // not a valid in-progress number -- ignore the keystroke
    setDraft(raw);
    onChange(parseNumericInput(raw));
  }

  function handleFocus(e: FocusEvent<HTMLInputElement>) {
    focusedRef.current = true;
    onFocus?.(e);
  }

  function handleBlur(e: FocusEvent<HTMLInputElement>) {
    focusedRef.current = false;
    const parsed = parseNumericInput(draft);
    if (parsed === null) {
      if (nullable) {
        setDraft("");
        if (value !== null) onChange(null);
      } else {
        // This field can't rest empty -- revert the display to the last
        // real value. Nothing actually changed, so onChange isn't called.
        setDraft(value === null ? "" : String(value));
      }
      onBlur?.(e);
      return;
    }
    const finalValue = clampNumericValue(parsed, { min, max, integerOnly });
    setDraft(String(finalValue));
    if (finalValue !== value) onChange(finalValue);
    onBlur?.(e);
  }

  return (
    <input
      {...rest}
      type="text"
      inputMode={integerOnly ? "numeric" : "decimal"}
      value={draft}
      onChange={handleChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      className={className}
    />
  );
}
