import { useEffect, useRef, useState } from "react";

const MIN_THUMB = 40;

// Overlay replacement for the page's native scrollbar (hidden via
// html.custom-scrollbar in index.css). The native one always takes its own
// column beside the sticky header; this one is drawn over the page, starts
// at the header's bottom edge so the top bar spans the full width above it,
// and stays invisible until the pointer is over its strip (or it's dragged).
export default function PageScrollbar() {
  const [state, setState] = useState({ top: 0, thumbTop: 0, thumbH: 0, visible: false });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ startY: number; startScroll: number; ratio: number } | null>(null);

  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("custom-scrollbar");

    let frame = 0;
    const measure = () => {
      frame = 0;
      const header = document.querySelector("header");
      const top = Math.max(0, header ? header.getBoundingClientRect().bottom : 0);
      const viewH = window.innerHeight;
      const docH = root.scrollHeight;
      const trackH = viewH - top;
      const maxScroll = docH - viewH;
      if (maxScroll <= 0 || trackH <= MIN_THUMB) {
        setState((s) => (s.visible ? { ...s, visible: false } : s));
        return;
      }
      const thumbH = Math.max(MIN_THUMB, (trackH * viewH) / docH);
      const thumbTop = (window.scrollY / maxScroll) * (trackH - thumbH);
      setState({ top, thumbTop, thumbH, visible: true });
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    const ro = new ResizeObserver(schedule);
    ro.observe(document.body);

    return () => {
      root.classList.remove("custom-scrollbar");
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      ro.disconnect();
    };
  }, []);

  if (!state.visible) return null;

  const scrollRatio = () => {
    const trackH = window.innerHeight - state.top;
    const maxScroll = document.documentElement.scrollHeight - window.innerHeight;
    return maxScroll / Math.max(1, trackH - state.thumbH);
  };

  const onThumbDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startY: e.clientY, startScroll: window.scrollY, ratio: scrollRatio() };
    setDragging(true);
  };
  const onThumbMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    window.scrollTo(0, d.startScroll + (e.clientY - d.startY) * d.ratio);
  };
  const onThumbUp = () => {
    drag.current = null;
    setDragging(false);
  };
  const onTrackDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const y = e.clientY - state.top - state.thumbH / 2;
    window.scrollTo(0, y * scrollRatio());
  };

  return (
    <div
      aria-hidden="true"
      onPointerDown={onTrackDown}
      style={{ top: state.top }}
      className={`group fixed bottom-0 end-0 z-[45] w-3 transition-opacity duration-200 ${
        dragging ? "opacity-100" : "opacity-0 hover:opacity-100"
      }`}
    >
      <div
        onPointerDown={onThumbDown}
        onPointerMove={onThumbMove}
        onPointerUp={onThumbUp}
        onPointerCancel={onThumbUp}
        style={{ transform: `translateY(${state.thumbTop}px)`, height: state.thumbH }}
        className={`absolute inset-x-[2px] top-0 rounded-full transition-colors ${
          dragging ? "bg-wine" : "bg-wine/70 hover:bg-wine"
        }`}
      />
    </div>
  );
}
