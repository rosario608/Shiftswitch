"use client";

import * as React from "react";
import { X } from "lucide-react";

/**
 * A conventional multi-address entry field.
 *
 * The behaviour people already expect from every mail client, stated plainly
 * because each part matters:
 *
 *   - typing goes into a normal text input that is always visible and always
 *     focusable by clicking anywhere in the box;
 *   - Enter and Tab commit what you have typed, and so does typing a comma or
 *     a semicolon — detected from the value rather than the keystroke, because
 *     Android soft keyboards do not report punctuation reliably;
 *   - pasting commits everything in the paste at once, split on commas,
 *     semicolons, newlines, tabs and spaces, so a column copied out of a
 *     spreadsheet works without being reformatted;
 *   - Backspace on an empty input edits the previous address rather than
 *     deleting it outright, because deleting the thing somebody just typed is
 *     never what they meant;
 *   - each committed address becomes a chip that can be removed on its own.
 *
 * Validity is shown per address, not as one verdict for the whole field: with
 * twenty pasted addresses, "one of these is wrong" is not a usable error.
 */

export interface EmailEntry {
  value: string;
  valid: boolean;
  duplicate: boolean;
}

/* Deliberately permissive. The purpose is to catch "sarah@" and "sarah gmail
   com" while somebody is typing — not to adjudicate RFC 5322. The server
   validates again, and the real proof an address works is that a person signs
   in with it. */
const SHAPE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]{2,}$/;

export function isProbablyEmail(value: string): boolean {
  return SHAPE.test(value.trim());
}

/** Splits pasted or typed text on every separator a person might plausibly use. */
export function splitAddresses(text: string): string[] {
  return text
    .split(/[\s,;\n\r\t]+/)
    .map((entry) => entry.trim().replace(/^[<"']+|[>"',.]+$/g, ""))
    .filter(Boolean);
}

/**
 * Turns raw values into entries, marking the second and later occurrences of an
 * address as duplicates. The first stays clean, so removing the flagged one
 * leaves something valid behind.
 */
export function toEntries(values: string[]): EmailEntry[] {
  const seen = new Set<string>();
  return values.map((value) => {
    const key = value.trim().toLowerCase();
    const duplicate = seen.has(key);
    seen.add(key);
    return { value, valid: isProbablyEmail(value), duplicate };
  });
}

export function EmailListInput({
  values,
  onChange,
  id,
  placeholder = "name@hospital.org",
  disabled,
}: {
  values: string[];
  onChange: (next: string[]) => void;
  id: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = React.useState("");
  const inputRef = React.useRef<HTMLInputElement>(null);
  const entries = toEntries(values);

  function commit(text: string) {
    const parsed = splitAddresses(text);
    if (parsed.length === 0) return;
    onChange([...values, ...parsed]);
    setDraft("");
  }

  /**
   * Separators are handled here rather than in `keydown` on purpose. Soft
   * keyboards on Android routinely report punctuation as keyCode 229 with no
   * usable `key`, so a comma typed on a phone never fires a recognisable key
   * event — and this is a mobile-first product. Watching the value instead
   * works the same on every keyboard, and for programmatic input too.
   */
  function handleChange(event: React.ChangeEvent<HTMLInputElement>) {
    const next = event.target.value;
    if (/[,;\n\t]/.test(next)) {
      const parts = splitAddresses(next);
      const trailing = /[,;\s]$/.test(next);
      // Anything before the final separator is committed; whatever follows it
      // stays in the box so it can still be edited.
      const complete = trailing ? parts : parts.slice(0, -1);
      const remainder = trailing ? "" : (parts[parts.length - 1] ?? "");
      if (complete.length > 0) onChange([...values, ...complete]);
      setDraft(remainder);
      return;
    }
    setDraft(next);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === "Tab") {
      if (draft.trim() === "") {
        // Let Tab do its normal job when there is nothing to commit.
        if (event.key !== "Tab") event.preventDefault();
        return;
      }
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === "Backspace" && draft === "" && values.length > 0) {
      // Put the last address back in the input rather than dropping it: a typo
      // in the third of twenty addresses should be fixable, not re-typable.
      event.preventDefault();
      setDraft(values[values.length - 1]);
      onChange(values.slice(0, -1));
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLInputElement>) {
    const text = event.clipboardData.getData("text");
    if (!text) return;
    // A single clean address pasted into an empty field behaves like typing it,
    // so the caret stays put and it can still be edited before committing.
    const parsed = splitAddresses(text);
    if (parsed.length <= 1 && draft === "" && !/[\s,;]/.test(text.trim())) return;
    event.preventDefault();
    commit(`${draft} ${text}`);
  }

  const invalid = entries.filter((entry) => !entry.valid).length;
  const duplicates = entries.filter((entry) => entry.duplicate).length;

  return (
    <div className="space-y-2">
      <div
        className="flex min-h-[3rem] w-full cursor-text flex-wrap items-center gap-1.5 rounded-lg border border-border-strong bg-surface p-2 focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/30"
        onClick={() => inputRef.current?.focus()}
      >
        {entries.map((entry, index) => (
          <Chip
            key={`${entry.value}-${index}`}
            entry={entry}
            onRemove={() => onChange(values.filter((_, i) => i !== index))}
          />
        ))}
        <input
          ref={inputRef}
          id={id}
          type="email"
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          disabled={disabled}
          value={draft}
          placeholder={values.length === 0 ? placeholder : "Add another…"}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => draft.trim() && commit(draft)}
          className="min-w-[12rem] flex-1 border-0 bg-transparent px-1 py-1 text-base text-ink outline-none"
        />
      </div>

      <p className="text-xs text-ink-subtle">
        Type an address and press <kbd className="font-sans font-semibold">Enter</kbd>,
        or paste a whole list — commas, semicolons and one-per-line all work.
      </p>

      {(invalid > 0 || duplicates > 0) && (
        <p className="text-xs font-medium text-critical">
          {invalid > 0 && (
            <>
              {invalid} address{invalid === 1 ? " does not" : "es do not"} look right.
              Fix or remove {invalid === 1 ? "it" : "them"} before inviting.
            </>
          )}
          {invalid > 0 && duplicates > 0 && " "}
          {duplicates > 0 && (
            <>
              {duplicates} duplicate{duplicates === 1 ? "" : "s"} — the extra
              {duplicates === 1 ? " one" : " ones"} will be ignored.
            </>
          )}
        </p>
      )}
    </div>
  );
}

function Chip({ entry, onRemove }: { entry: EmailEntry; onRemove: () => void }) {
  const bad = !entry.valid;
  return (
    <span
      data-testid="email-chip"
      data-valid={entry.valid ? "true" : "false"}
      data-duplicate={entry.duplicate ? "true" : "false"}
      className={[
        "inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-sm",
        bad
          ? "border-critical/50 bg-critical-soft text-critical"
          : entry.duplicate
            ? "border-caution/50 bg-caution-soft text-caution"
            : "border-border-strong bg-surface-muted text-ink",
      ].join(" ")}
      title={
        bad
          ? "That does not look like an email address"
          : entry.duplicate
            ? "Already in the list"
            : undefined
      }
    >
      <span className="truncate">{entry.value}</span>
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onRemove();
        }}
        aria-label={`Remove ${entry.value}`}
        className="rounded-full p-0.5 hover:bg-black/10"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    </span>
  );
}
