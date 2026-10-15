import jsQR from "jsqr";
import { useEffect, useRef, useState } from "react";
import { useLanguage } from "../context/LanguageContext";

// Traditional retail barcodes (EAN/UPC/CODE128/...) are Sisely's primary
// scan format -- this is what a real garment-tag barcode is, and what the
// USB/Bluetooth keyboard-wedge scanner in useBarcodeScanner.ts already reads
// natively (any HID scanner just "types" the decoded value). This modal is
// the camera-based counterpart, for a device with no physical scanner
// attached. It prefers the browser's native BarcodeDetector API (Shape
// Detection API), which decodes real 1D barcodes AND QR codes from the live
// video feed directly, with no extra dependency. Where that API isn't
// available (Safari, Firefox, as of this writing), it falls back to the
// jsQR-only decoding this modal always used -- QR keeps working exactly as
// before there; only camera-based *barcode* reading is unavailable, matching
// "camera-based barcode scanning where supported."
//
// Either path calls the same onScan(data) -- matchProductFromScan()
// (scanProductMatch.ts) resolves the decoded text the same way regardless of
// which symbology produced it, so no caller-side branching is needed.
type NativeBarcodeDetector = {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue: string }>>;
};
type NativeBarcodeDetectorCtor = new (options: { formats: string[] }) => NativeBarcodeDetector;

// Common retail 1D formats plus QR, so one camera view reads either.
const BARCODE_FORMATS = ["ean_13", "ean_8", "upc_a", "upc_e", "code_128", "code_39", "itf", "codabar", "qr_code"];

export function CameraScannerModal({ onScan, onClose }: { onScan: (data: string) => void; onClose: () => void }) {
  const { t } = useLanguage();
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);
  const onScanRef = useRef(onScan);
  onScanRef.current = onScan;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let stopped = false;
    let detector: NativeBarcodeDetector | null = null;

    const BarcodeDetectorCtor = (window as unknown as { BarcodeDetector?: NativeBarcodeDetectorCtor }).BarcodeDetector;
    if (BarcodeDetectorCtor) {
      try {
        detector = new BarcodeDetectorCtor({ formats: BARCODE_FORMATS });
      } catch {
        // Some browsers expose the constructor but reject an unsupported
        // format list -- fall back to jsQR (QR-only) rather than fail the
        // whole scanner over it.
        detector = null;
      }
    }

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (stopped) {
          stream.getTracks().forEach((tr) => tr.stop());
          return;
        }
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play();
        }
        tick();
      } catch {
        setError(t("pos.scanner.cameraError"));
      }
    }

    async function tickNative() {
      const video = videoRef.current;
      if (video && detector && video.readyState === video.HAVE_ENOUGH_DATA) {
        try {
          const results = await detector.detect(video);
          if (results.length > 0 && results[0].rawValue) {
            onScanRef.current(results[0].rawValue);
            return;
          }
        } catch {
          // A transient per-frame detection error shouldn't kill the scan
          // loop -- just try again on the next frame.
        }
      }
      if (!stopped) raf = requestAnimationFrame(() => void tickNative());
    }

    function tickJsQr() {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas && video.readyState === video.HAVE_ENOUGH_DATA) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
          const result = jsQR(imageData.data, imageData.width, imageData.height);
          if (result?.data) {
            onScanRef.current(result.data);
            return;
          }
        }
      }
      if (!stopped) raf = requestAnimationFrame(tickJsQr);
    }

    function tick() {
      if (detector) void tickNative();
      else tickJsQr();
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [t]);

  return (
    <div className="fixed inset-0 z-[200] flex flex-col items-center justify-center bg-black/90 p-6">
      <button
        onClick={onClose}
        className="absolute end-6 top-6 flex h-11 w-11 items-center justify-center rounded-full bg-on-accent/10 text-on-accent hover:bg-on-accent/20"
        aria-label={t("pos.scanner.closeScanner")}
      >
        <svg className="h-5 w-5" viewBox="0 0 18 18" fill="none">
          <path d="M1 1L17 17M17 1L1 17" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>
      {error ? (
        <p className="max-w-sm text-center text-on-accent">{error}</p>
      ) : (
        <>
          <div className="relative w-full max-w-md overflow-hidden rounded-2xl border-2 border-on-accent/30">
            <video ref={videoRef} className="w-full" muted playsInline />
            <div className="pointer-events-none absolute inset-8 rounded-xl border-2 border-wine" />
          </div>
          <p className="mt-4 text-sm text-on-accent/70">{t("pos.scanner.pointCamera")}</p>
        </>
      )}
      <canvas ref={canvasRef} className="hidden" />
    </div>
  );
}
