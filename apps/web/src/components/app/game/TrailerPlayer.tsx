// Трейлер из Steam (спека 2026-10-27 §3.5): постер с кнопкой ▶, по клику — `<video>`
// на месте. Steam отдаёт только HLS/DASH: там, где `<video>` умеет m3u8 (Safari),
// играем нативно, иначе подгружаем `hls.js` динамически и отцепляем при размонтировании.
import { Play } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const HLS_MIME = "application/vnd.apple.mpegurl";

export function TrailerPlayer({
  hls,
  poster,
  name,
}: {
  hls: string;
  poster: string;
  name: string;
}) {
  const [playing, setPlaying] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!playing || video === null) return;
    if (video.canPlayType(HLS_MIME) !== "") {
      video.src = hls;
      return;
    }
    let cancelled = false;
    let player: { destroy: () => void } | null = null;
    void import("hls.js").then(({ default: Hls }) => {
      if (cancelled || !Hls.isSupported()) return;
      const instance = new Hls();
      instance.loadSource(hls);
      instance.attachMedia(video);
      player = instance;
    });
    return () => {
      cancelled = true;
      player?.destroy();
    };
  }, [playing, hls]);

  if (!playing)
    return (
      <button
        type="button"
        aria-label={`Смотреть трейлер: ${name}`}
        onClick={() => setPlaying(true)}
        className="group relative aspect-video w-full overflow-hidden rounded-[10px] bg-[#1a1d26]"
      >
        <img src={poster} alt="" className="size-full object-cover" />
        <span className="absolute inset-0 flex items-center justify-center">
          <span className="flex size-12 items-center justify-center rounded-full bg-black/60 text-[#eef1ff] transition group-hover:bg-black/80">
            <Play className="size-5" />
          </span>
        </span>
      </button>
    );

  return (
    <video
      ref={videoRef}
      controls
      autoPlay
      playsInline
      poster={poster}
      aria-label={`Трейлер: ${name}`}
      className="aspect-video w-full rounded-[10px] bg-black"
    />
  );
}
