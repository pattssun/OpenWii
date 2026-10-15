import { AudioEngine } from "../../core/audio.js";
import { SampledKartAudio } from "./sample-audio.js";
import { EVENT_TYPES } from "./logic.js";
export const AUDIO_SLOTS = [
  ...EVENT_TYPES.map((t) => "mk-" + t),
  "mk-engine",
  "mk-music",
];
export function engineFrequency(speed) {
  return 48 + Math.min(60, Math.abs(Number.isFinite(speed) ? speed : 0)) * 3.1;
}
export class KartAudio {
  constructor() {
    this.engine = new AudioEngine({ volume: 0.55 });
    this.original = new SampledKartAudio(this.engine);
    this.motor = null;
    this.music = null;
    this.musicGain = null;
    this.stopped = false;
    this.beat = 0;
    this.nextBeat = 0;
    for (const [i, type] of EVENT_TYPES.entries())
      this.engine.register("mk-" + type, (a, opts = {}) => {
        if (["hit", "wall", "burnout", "bump"].includes(type)) {
          a.noise({ dur: 0.3, gain: 0.23, freq: 500, sweepTo: 90 });
          a.tone({
            freq: 145,
            slideTo: 48,
            dur: 0.35,
            type: "sawtooth",
            gain: 0.09,
          });
        } else if (
          ["boost", "turbo", "rocket", "glider", "antigrav"].includes(type)
        ) {
          a.noise({ dur: 0.35, gain: 0.13, freq: 500, sweepTo: 4000 });
          a.tone({
            freq: 260,
            slideTo: 1100,
            dur: 0.3,
            type: "triangle",
            gain: 0.13,
          });
        } else if (["finish", "results", "finalLap"].includes(type)) {
          [523, 659, 784, 1047].forEach((freq, j) =>
            a.tone({
              freq,
              delay: j * 0.1,
              dur: 0.3,
              gain: 0.15,
              type: "triangle",
            }),
          );
        } else if (type === "countdown" || type === "go")
          a.tone({
            freq: type === "go" ? 1047 : 523,
            dur: type === "go" ? 0.35 : 0.15,
            type: "square",
            gain: 0.09,
          });
        else {
          a.tone({
            freq: type === "coin" ? 1318 : 440 + (i % 8) * 90,
            dur: 0.13,
            gain: 0.12,
            type: "triangle",
          });
          if (type === "coin")
            a.tone({ freq: 1760, dur: 0.16, delay: 0.065, gain: 0.1 });
        }
      });
  }
  prepare() { return this.original.prepare(); }
  async unlock() {
    await this.engine.unlock();
    if (!this.engine.ctx) return;
    if (await this.prepare()) {
      this.engine.master.gain.setValueAtTime(this.engine.enabled ? this.engine.volume : 0, this.engine.ctx.currentTime);
      return;
    }
    this.stopped = false;
    this.engine.master.gain.setValueAtTime(
      this.engine.enabled ? this.engine.volume : 0,
      this.engine.ctx.currentTime,
    );
    if (!this.motor) {
      const ctx = this.engine.ctx,
        g = ctx.createGain(),
        filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 550;
      g.gain.value = 0;
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = 48;
      osc.connect(filter).connect(g).connect(this.engine.master);
      osc.start();
      this.motor = { osc, g, override: null };
      this.engine.loadOverride("mk-engine").then((buffer) => {
        if (!buffer || !this.motor) return;
        const s = ctx.createBufferSource();
        s.buffer = buffer;
        s.loop = true;
        s.connect(g);
        s.start();
        this.motor.override = s;
        osc.disconnect();
      });
      this.engine.loadOverride("mk-music").then((buffer) => {
        if (!buffer || this.music || this.stopped) return;
        const src = ctx.createBufferSource(),
          gain = ctx.createGain();
        src.buffer = buffer;
        src.loop = true;
        gain.gain.value = 0;
        src.connect(gain).connect(this.engine.master);
        src.start();
        this.music = src;
        this.musicGain = gain;
      });
    }
  }
  get resultsReady(){return this.original.ready ? this.original.resultsReady : !this.engine.ctx || this.engine.ctx.state !== 'running' || this.engine.ctx.currentTime >= (this.fallbackFinishUntil || 0);}
  presentResults(race,duration){this.original.presentResults(race,duration);}
  async ui(kind='confirm') {
    await this.unlock();
    if (!this.engine.enabled) return;
    const key={cursor:'uiCursor',confirm:'uiConfirm',cancel:'uiCancel',start:'uiStart'}[kind];
    if(this.original.ready&&this.original.buffers.has(key))this.original.play(key,{bus:'ui'});
    else this.engine.tone({freq:kind==='cursor'?880:660,dur:.055,gain:.06,type:'sine'});
  }
  event(e, race) {
    if (e.type === 'finish' && race?.humanCount === 2) {
      if (race.state !== 'finishing') return;
      e = { ...e, racer: 0 };
    }
    if (race && this.original.event(e, race)) return;
    if (e.racer !== 0) return;
    if (e.type === 'finish') this.fallbackFinishUntil = (this.engine.ctx?.currentTime || 0) + .6;
    this.engine.play("mk-" + e.type, e);
  }
  update(race) {
    if (this.original.ready) { this.original.update(race); return; }
    const ctx = this.engine.ctx;
    if (!ctx || !this.motor) return;
    const r = race.player,
      active = !["ready", "results"].includes(race.state);
    this.motor.osc.frequency.setTargetAtTime(
      engineFrequency(r.speed),
      ctx.currentTime,
      0.045,
    );
    if (this.motor.override)
      this.motor.override.playbackRate.setTargetAtTime(
        0.7 + Math.abs(r.speed) / 36,
        ctx.currentTime,
        0.05,
      );
    if (this.musicGain)
      this.musicGain.gain.setTargetAtTime(
        active ? 0.3 : 0,
        ctx.currentTime,
        0.25,
      );
    this.motor.g.gain.setTargetAtTime(
      active ? 0.028 + (Math.abs(r.speed) / 55) * 0.022 : 0,
      ctx.currentTime,
      0.15,
    );
    if (
      !this.music &&
      active &&
      ctx.state === "running" &&
      ctx.currentTime >= this.nextBeat
    ) {
      // Original syncopated stadium groove, never a Nintendo melody transcription.
      const notes = [196, 246.94, 293.66, 329.63, 220, 261.63, 329.63, 392];
      this.engine.tone({
        freq: notes[this.beat % 8],
        dur: 0.15,
        type: "triangle",
        gain: 0.045,
      });
      if (this.beat % 2 === 0)
        this.engine.tone({ freq: 73.42, slideTo: 40, dur: 0.12, gain: 0.07 });
      if (this.beat % 4 === 2)
        this.engine.noise({ dur: 0.08, freq: 1700, gain: 0.035 });
      this.nextBeat = ctx.currentTime + (race.laps > 1 && r.lap === race.laps ? 0.19 : 0.225);
      this.beat++;
    }
  }
  stop() {
    this.original.stop();
    this.stopped = true;
    if (this.music) {
      try {
        this.music.stop();
      } catch {}
    }
    if (this.motor) {
      this.motor.osc.stop();
      this.motor.override?.stop();
      this.motor = null;
    }
    this.engine.ctx?.suspend();
  }
}
