import { createPortal } from "react-dom";

export default function LoadingScreen({ message = "Loading..." }) {
  return createPortal(
    <div className="fixed inset-0 z-[9000] bg-black/70 backdrop-blur-sm flex flex-col items-center justify-center">
      <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin mb-4" />
      <span className="text-[11px] text-white/40 uppercase tracking-widest">{message}</span>
    </div>,
    document.body
  );
}
