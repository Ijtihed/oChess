import { useEffect, useRef } from "react";

const INTERACTIVE = "button, a, [role='button'], input, label, select, textarea";

export default function CustomCursor() {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onMove = (e) => {
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;

      const target = document.elementFromPoint(e.clientX, e.clientY);
      const hit = target?.closest?.(INTERACTIVE);
      el.classList.toggle("cursor--over", Boolean(hit));
    };

    const onLeave = () => {
      el.style.opacity = "0";
    };
    const onEnter = () => {
      el.style.opacity = "1";
    };

    window.addEventListener("mousemove", onMove, { passive: true });
    document.addEventListener("mouseleave", onLeave);
    document.addEventListener("mouseenter", onEnter);
    return () => {
      window.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseleave", onLeave);
      document.removeEventListener("mouseenter", onEnter);
    };
  }, []);

  return <div id="custom-cursor" ref={ref} aria-hidden="true" />;
}
