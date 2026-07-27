/**
 * useFeedback — Procedural sound effects & haptic feedback
 * Reads the "verdict-settings" localStorage key for soundEffects / vibration toggles.
 * Uses Web Audio API for lightweight procedural sounds (no audio files needed).
 */
import { useCallback, useMemo } from "react";

function getSettings() {
  try {
    const saved = localStorage.getItem("verdict-settings");
    return saved
      ? JSON.parse(saved)
      : { soundEffects: true, vibration: true };
  } catch {
    return { soundEffects: true, vibration: true };
  }
}

/** Create a shared AudioContext lazily (must be triggered by user gesture). */
let _audioCtx = null;
function getAudioCtx() {
  if (!_audioCtx) {
    _audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser policy)
  if (_audioCtx.state === "suspended") {
    _audioCtx.resume().catch(() => {});
  }
  return _audioCtx;
}

/**
 * Play a short procedural "pop" sound.
 * freq: base frequency in Hz, dur: duration in seconds
 */
function playTone(freq = 600, dur = 0.08, vol = 0.15, type = "sine") {
  try {
    const ctx = getAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = type;
    osc.frequency.setValueAtTime(freq, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(freq * 1.8, ctx.currentTime + dur * 0.3);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.5, ctx.currentTime + dur);

    gain.gain.setValueAtTime(vol, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + dur);
  } catch {
    // Audio not available — silently ignore
  }
}

export default function useFeedback() {
  const vibrate = useCallback((ms = 50) => {
    const s = getSettings();
    if (!s.vibration) return;
    if (navigator.vibrate) {
      navigator.vibrate(ms);
    }
  }, []);

  const playTap = useCallback(() => {
    const s = getSettings();
    if (!s.soundEffects) return;
    playTone(800, 0.06, 0.1, "sine");
  }, []);

  const playReaction = useCallback(() => {
    const s = getSettings();
    if (!s.soundEffects) return;
    playTone(1200, 0.1, 0.12, "sine");
  }, []);

  const playDrop = useCallback(() => {
    const s = getSettings();
    if (!s.soundEffects) return;
    // Two-note "incoming" chime
    playTone(523, 0.12, 0.15, "triangle"); // C5
    setTimeout(() => playTone(784, 0.18, 0.12, "triangle"), 120); // G5
  }, []);

  const playVerdict = useCallback(() => {
    const s = getSettings();
    if (!s.soundEffects) return;
    // Rising three-note "result" chime
    playTone(523, 0.1, 0.12, "triangle"); // C5
    setTimeout(() => playTone(659, 0.1, 0.12, "triangle"), 100); // E5
    setTimeout(() => playTone(784, 0.2, 0.15, "triangle"), 200); // G5
  }, []);

  const playCountdownTick = useCallback(() => {
    const s = getSettings();
    if (!s.soundEffects) return;
    playTone(440, 0.03, 0.05, "square");
  }, []);

  return { vibrate, playTap, playReaction, playDrop, playVerdict, playCountdownTick };
}
