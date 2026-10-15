import { useEffect, useRef } from "react";

// A USB/Bluetooth HID barcode scanner "types" its payload almost
// instantly (every keystroke well under ~40ms apart) then sends Enter,
// unlike a human typing. Global listener, no dedicated input focus
// required — keeps working anywhere in the POS while it's mounted.
const MAX_KEY_INTERVAL_MS = 40;
const MIN_CODE_LENGTH = 3;

export function useBarcodeScanner(onScan: (code: string) => void) {
  const bufferRef = useRef("");
  const lastKeyTimeRef = useRef(0);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      const isTyping = target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
      if (isTyping) return;

      const now = performance.now();
      const elapsed = now - lastKeyTimeRef.current;
      lastKeyTimeRef.current = now;

      if (e.key === "Enter") {
        if (bufferRef.current.length >= MIN_CODE_LENGTH) {
          onScanRef.current(bufferRef.current);
        }
        bufferRef.current = "";
        return;
      }

      if (e.key.length !== 1) return;

      bufferRef.current = elapsed <= MAX_KEY_INTERVAL_MS ? bufferRef.current + e.key : e.key;
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);
}
