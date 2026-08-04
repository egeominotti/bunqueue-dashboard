import { type ChangeEvent, useCallback, useEffect, useRef } from 'react';
import { MAX_BULK_INPUT_BYTES } from './constants';
import { bulkInputBudgetError } from './input';

type ImportResult = { ok: boolean; msg: string } | null;

export function useBulkFileInput({
  text,
  setText,
  setResult,
}: {
  text: string;
  setText: (text: string) => void;
  setResult: (result: ImportResult) => void;
}) {
  const readerRef = useRef<FileReader | null>(null);
  const generationRef = useRef(0);

  const cancelPending = useCallback(() => {
    generationRef.current += 1;
    const reader = readerRef.current;
    readerRef.current = null;
    try {
      reader?.abort();
    } catch {
      // Generation ownership still prevents a late load from replacing edits.
    }
  }, []);

  useEffect(() => cancelPending, [cancelPending]);

  const onFile = (event: ChangeEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const file = input.files?.[0];
    if (!file) return;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    const previous = readerRef.current;
    readerRef.current = null;
    try {
      previous?.abort();
    } catch {
      // Generation ownership suppresses a reader that cannot abort.
    }
    input.value = '';

    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_BULK_INPUT_BYTES) {
      setResult({ ok: false, msg: `File is too large; maximum is 64 MiB (${file.name})` });
      return;
    }
    if (text.trim() !== '' && !window.confirm(`Replace the current input with "${file.name}"?`)) {
      return;
    }

    const reader = new FileReader();
    const isCurrent = () => generationRef.current === generation && readerRef.current === reader;
    const finish = () => {
      if (isCurrent()) readerRef.current = null;
    };
    reader.onload = () => {
      if (!isCurrent()) return;
      if (typeof reader.result !== 'string') {
        setResult({ ok: false, msg: `Could not decode file as text (${file.name})` });
        finish();
        return;
      }
      const budgetError = bulkInputBudgetError(reader.result);
      if (budgetError) setResult({ ok: false, msg: `${budgetError} (${file.name})` });
      else {
        setText(reader.result);
        setResult(null);
      }
      finish();
    };
    reader.onerror = () => {
      if (!isCurrent()) return;
      setResult({ ok: false, msg: `Could not read file (${file.name})` });
      finish();
    };
    reader.onabort = finish;
    readerRef.current = reader;
    setResult(null);
    try {
      reader.readAsText(file);
    } catch {
      if (!isCurrent()) return;
      setResult({ ok: false, msg: `Could not read file (${file.name})` });
      finish();
    }
  };

  return { cancelPending, onFile };
}
