/* eslint-disable @typescript-eslint/no-explicit-any */
import { useState, useRef, useEffect, useCallback } from "react";
import {
  getOfflineBlob,
  storeTrackBlob,
  storeSetting
} from "../managers/idbWrapper";

// Import getFallbackUrl for use in getTrackUrl
// (If getFallbackUrl is defined below, this import is safe for future refactor.)
import audioElement from "../managers/audioManager";
import { Track } from "../types/types";

async function getSaavnFallbackUrl(trackId: string): Promise<string | null> {
  try {
    const deezerRes = await fetch(`https://scrape2-ruddy.vercel.app/api/scrape?url=https://api.deezer.com/track/${trackId}`);
    if (!deezerRes.ok) throw new Error("Deezer metadata fetch failed");
    const deezerData = await deezerRes.json();
    const title = encodeURIComponent(deezerData.content?.title ?? "");
    const artist = encodeURIComponent(deezerData.content?.artist?.name ?? "");

    if (!title || !artist) throw new Error("Missing title or artist in Deezer data");

    const searchRes = await fetch(`https://jiosaavn-api-privatecvc2.vercel.app/search/songs?query=${title}+${artist}&limit=5&page=1`);
    if (!searchRes.ok) throw new Error("Saavn search failed");
    const searchData = await searchRes.json();

    const result = searchData?.data?.results?.find((item: any) =>
      item.name?.toLowerCase() === (deezerData.content?.title ?? "").toLowerCase() &&
      item.primaryArtists?.toLowerCase().includes((deezerData.content?.artist?.name ?? "").toLowerCase())
    );

    if (!result || !result.downloadUrl?.length) return null;

    const best = result.downloadUrl.findLast((d: any) => d.link);
    return best?.link || null;
  } catch (e) {
    console.warn("Saavn fallback failed:", e);
    return null;
  }
}

/* ─────────────────────────── URLs ──────────────────────────────── */
export function getTrackUrl(id: string, q: string): string {
  switch (q) {
    case "MAX":
      // return `https://deezer-worker.justvinixy.workers.dev/flac/?track=${id}`;
      return getFallbackUrl(id);
    case "HIGH":
      // return `https://deezer-worker.justvinixy.workers.dev/lossless/?track=${id}`;
      return getFallbackUrl(id);
    case "NORMAL":
      // return `https://deezer-worker.justvinixy.workers.dev/320/?track=${id}`;
      return getFallbackUrl(id);
    case "DATA_SAVER":
      // return `https://deezer-worker.justvinixy.workers.dev/128/?track=${id}`;
      return getFallbackUrl(id);
    default:
      // return `https://deezer-worker.justvinixy.workers.dev/320/?track=${id}`;
      return getFallbackUrl(id);
  }
}
function getFallbackUrl(id: string): string {
  return `https://api.octave.gold/api/track/${id}.mp3`;
}

/* ───────── Worker failure budget ──────────────────────────────── */
const FAILURE_BUDGET = 5;
let   workerFailures = 0;
const workerAllowed  = () => workerFailures < FAILURE_BUDGET;
const bumpFailure    = () => { workerFailures++; };
const resetFailures  = () => { workerFailures = 0; };

/* ───────── retry util (single GET, no HEAD) ───────────────────── */
async function getWithRetry(
  url: string,
  signal: AbortSignal,
  retries = 3
): Promise<Response> {
  let last: any;
  for (let i = 0; i < retries; i++) {
    try {
      const r = await fetch(url, { cache: "no-store", signal });
      if (r.ok) return r;
      last = new Error(`status ${r.status}`);
    } catch (e) { last = e; }
    await new Promise(r => setTimeout(r, 1200));
  }
  throw last;
}

/* ───────── quick MSE util ─────────────────────────────────────── */
async function streamViaMSE(
  audio : HTMLAudioElement,
  mime  : string,
  blob  : Blob,
  resume: number,
  wasPlaying: boolean
) {
  if (!window.MediaSource || !MediaSource.isTypeSupported(mime))
    throw new Error("MSE unsupported");

  const ms = new MediaSource();
  audio.src = URL.createObjectURL(ms);
  await new Promise<void>(r => ms.addEventListener("sourceopen", () => r(), { once:true }));

  const sb = ms.addSourceBuffer(mime);
  const reader = blob.stream().getReader();

  for (let first = true;;) {
    const { value, done } = await reader.read();
    if (done) break;
    await new Promise<void>(r => {
      sb.addEventListener("updateend", () => r(), { once:true });
      sb.appendBuffer(value);
    });
    if (first) {
      audio.currentTime = resume;
      if (wasPlaying) await audio.play().catch(()=>{});
      first = false;
    }
  }
  await new Promise<void>(r => {
    sb.addEventListener("updateend", () => r(), { once:true });
    sb.appendBuffer(new Uint8Array());
  });
  ms.endOfStream();
}

/* ─────────── Hook ─────────────────────────────────────────────── */
export function useAudio() {
  const [isPlaying, setIsPlaying] = useState(false);
  const [duration,  setDuration]  = useState(0);
  const [volume,    setVolume]    = useState(1);

  const [audioQuality, setAudioQuality] =
    useState<"MAX"|"HIGH"|"NORMAL"|"DATA_SAVER">("NORMAL");
  const [isDataSaver,  setIsDataSaver]  = useState(false);

  const onTrackEndRef = useRef<() => void>();
  const abortRef      = useRef<AbortController|null>(null);

  /* element listeners */
  useEffect(() => {
  if (!audioElement) return;
  const el = audioElement;

  const setDur = () => {
    /* take the first finite duration we see */
    if (Number.isFinite(el.duration)) setDuration(el.duration);
  };

  /* ───────── listeners ───────── */
  el.addEventListener("loadedmetadata", setDur);
  el.addEventListener("durationchange",  setDur);   // ← NEW
  el.addEventListener("play",  () => setIsPlaying(true));
  el.addEventListener("pause", () => setIsPlaying(false));
  el.addEventListener("ended", () => onTrackEndRef.current?.());

  return () => {
    el.removeEventListener("loadedmetadata", setDur);
    el.removeEventListener("durationchange",  setDur);   // ← NEW
    el.removeEventListener("play",  () => setIsPlaying(true));
    el.removeEventListener("pause", () => setIsPlaying(false));
    el.removeEventListener("ended", () => onTrackEndRef.current?.());
  };
}, []);


  /* utils */
  const getCurrentPlaybackTime = useCallback(
    () => audioElement?.currentTime ?? 0,
    []
  );
  const handleSeek = useCallback((t:number)=>{
    if (audioElement) audioElement.currentTime = t;
  },[]);
  const onVolumeChange = useCallback((v:number)=>{
    v = Math.min(Math.max(v,0),1);
    if (audioElement) audioElement.volume = v;
    setVolume(v);
    storeSetting("volume", String(v)).catch(()=>{});
  },[]);
  const setLoop = useCallback((on:boolean)=>{
    if (audioElement) audioElement.loop = on;
  },[]);

  /* core loader */
  const playTrackFromSource = useCallback(
async (
  track: Track,
  startAt = 0,
  autoPlay = true,
  qualityOverride?: "MAX"|"HIGH"|"NORMAL"|"DATA_SAVER",
  forceFetch = false,
  userGesture = true
) => {
  if (!audioElement) return;

  // Cancel any previous fetch operations
  if (abortRef.current) {
    abortRef.current.abort();
    abortRef.current = null;
  }
  
  // Create a new abort controller with proper error handling
  const ac = new AbortController();
  abortRef.current = ac;

  // Add a check to see if we're aborted early
  const checkAborted = () => {
    if (ac.signal.aborted) {
      throw new Error("Operation cancelled");
    }
  };

  const wanted = "DATA_SAVER"; // always attempt fallback quality

  try {
    /* ---- LOW quality first ------------------------------------ */
    checkAborted();
    const lowKey = `${track.id}_DATA_SAVER`;
    let lowBlob = !forceFetch ? await getOfflineBlob(lowKey) : null;

    if (!lowBlob) {
      // const r = await fetch(getFallbackUrl(track.id), { cache: "no-store", signal: ac.signal });
      // lowBlob = await r.blob();

      try {
        checkAborted();
        // Attempt Qobuz fallback
        const qobuzRes = await fetch(`https://ejgsapis.vercel.app/api/qobuz?id=${track.id}`, { signal: ac.signal, redirect: 'manual' });
        if (qobuzRes.status >= 300 && qobuzRes.status < 400) {
          const location = qobuzRes.headers.get("Location");
          if (!location) throw new Error("Qobuz redirect missing Location header");
          checkAborted();
          const audioRes = await fetch(location, { signal: ac.signal });
          if (!audioRes.ok) throw new Error("Qobuz audio fetch failed");
          lowBlob = await audioRes.blob();
        } else {
          throw new Error("Qobuz fallback did not redirect");
        }
      } catch (qErr) {
        try {
          checkAborted();
          // Attempt DeezerMusic fallback
          const deezerMusicRes = await fetch(`https://ejgsapis.vercel.app/api/deezermusic?id=${track.id}`, { signal: ac.signal });
          if (!deezerMusicRes.ok) throw new Error("DeezerMusic fallback fetch failed");
          const deezerMusicJson = await deezerMusicRes.json();
          const mp3Url = deezerMusicJson.mp3;
          if (!mp3Url) throw new Error("DeezerMusic response missing mp3 field");
          checkAborted();
          const mp3Res = await fetch(mp3Url, { signal: ac.signal });
          if (!mp3Res.ok) throw new Error("DeezerMusic mp3 fetch failed");
          lowBlob = await mp3Res.blob();
        } catch (dErr) {
          try {
            // Fallback to Saavn as before
            const saavnUrl = await getSaavnFallbackUrl(track.id);
            if (saavnUrl) {
              const r = await getWithRetry(saavnUrl, ac.signal);
              if (!r.ok) throw new Error("Saavn fetch failed");
              lowBlob = await r.blob();
            }
          } catch (se) {
            console.warn("Saavn fallback failed:", se);
          }
        }
      }

      if (lowBlob) storeTrackBlob(lowKey, lowBlob).catch(() => {});
    }

    // Another abort check before playing
    checkAborted();

    /* play low quality */
    const prev = audioElement.src;
    if (!lowBlob) throw new Error("Low quality blob is undefined");
    audioElement.src = URL.createObjectURL(lowBlob);
    if (prev.startsWith("blob:")) URL.revokeObjectURL(prev);
    audioElement.currentTime = startAt;
    if (autoPlay && userGesture) await audioElement.play().catch(()=>{});

    // Removed background upgrade block as per instructions

  } catch (err) {
    // Only log non-abort errors
    if (!ac.signal.aborted) {
      console.error("Error in playTrackFromSource:", err);
    }
  }
}, [audioQuality, isDataSaver]);

  /* pause / stop */
  const pauseAudio = useCallback(()=>{
    if (audioElement) audioElement.pause();
  },[]);
  const stop = useCallback(()=>{
    abortRef.current?.abort();
    if (!audioElement) return;
    audioElement.pause();
    audioElement.removeAttribute("src");
    audioElement.load();
  },[]);

  /* offline downloader */
  const loadAudioBuffer = useCallback(async(id:string)=>{
    const key = `${id}_${audioQuality}`;
    const cached = await getOfflineBlob(key);
    if (cached) return cached;
    const url = workerAllowed()
      ? getTrackUrl(id, audioQuality)
      : getFallbackUrl(id);
    const blob = await (await fetch(url)).blob();
    await storeTrackBlob(key, blob);
    return blob;
  },[audioQuality]);

  /* flags */
  const toggleDataSaver = useCallback(async(on:boolean)=>{
    setIsDataSaver(on);
    await storeSetting("dataSaver", String(on));
    if (on) setAudioQuality("DATA_SAVER");
  },[]);
  const changeAudioQuality = useCallback(async(q:"MAX"|"HIGH"|"NORMAL"|"DATA_SAVER")=>{
    if (isDataSaver && q!=="DATA_SAVER") return;
    setAudioQuality(q);
    await storeSetting("audioQuality", q);
  },[isDataSaver]);

  /* public API (unchanged) */
  return {
    isPlaying,
    setIsPlaying,
    duration,
    volume,
    setVolume,
    currentTime: getCurrentPlaybackTime(),
    currentTrack: null as Track | null,
    audioQuality,
    isDataSaver,
    playTrackFromSource,
    pauseAudio,
    stop,
    handleSeek,
    onVolumeChange,
    getCurrentPlaybackTime,
    loadAudioBuffer,
    setOnTrackEndCallback: (cb:()=>void)=>{ onTrackEndRef.current = cb; },
    audioElement,
    toggleDataSaver,
    changeAudioQuality,
    setAudioQuality,
    setIsDataSaver,
    setLoop
  };
}
