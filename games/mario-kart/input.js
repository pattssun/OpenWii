import { axesFromSample } from "../../core/orientation.js";
import {
  captureTray,
  trayRead,
  SteerFilter,
  STEER_FULL,
} from "../alien-attack/logic.js";
import { clamp } from "./track.js";
// Reduce phone steering by 40% before clamping. Small corrections are gentler,
// while a deliberate ~28-degree tilt still reaches full steering lock.
const STEERING_SENSITIVITY = 0.6;
/** Thin safety envelope around Alien Attack's proven, device-pinned mapping. */
export class WheelInput {
  constructor({ invert = false } = {}) {
    this.invert = invert;
    this.ref = null;
    this.filter = new SteerFilter();
    this.lastAt = -Infinity;
    this.lastButtonsAt = -Infinity;
    this.value = 0;
    this.buttons = {};
    this.stable = [];
    this.lastAxes = null;
    this.status = "Hold the wheel level";
    this.armed = false;
  }
  reset() {
    this.ref = null;
    this.filter = new SteerFilter();
    this.stable = [];
    this.value = 0;
    this.armed = false;
    this.status = "Hold the wheel level";
  }
  release() {
    this.buttons = {};
    this.value = 0;
    this.armed = false;
  }
  sample(sample, now, { canCapture = false } = {}) {
    if (!sample || !Number.isFinite(now)) return false;
    const vals = sample.quat || [sample.alpha, sample.beta, sample.gamma];
    if (!Array.isArray(vals) || vals.some((v) => !Number.isFinite(v)))
      return false;
    if (
      sample.quat &&
      (vals.length !== 4 || Math.abs(Math.hypot(...vals) - 1) > 0.05)
    )
      return false;
    const axes = axesFromSample(sample);
    const dt = clamp((now - this.lastAt) / 1000, 1 / 240, 0.1);
    this.lastAt = now;
    this.lastAxes = axes;
    if (sample.buttons) this.setButtons(sample.buttons, now);
    if (!this.ref && canCapture) {
      // Long axis must be level; z axis must face mostly up. A turned wheel at
      // countdown is rejected, not silently learned as straight for the race.
      if (Math.abs(axes.y.z) > 0.0436 || axes.z.z < 0.7) {
        this.stable = [];
        this.status = "Level the wheel · R / − to recenter";
        return true;
      }
      this.stable.push({ axes, at: now });
      this.stable = this.stable.filter((s) => now - s.at <= 650);
      const zs = this.stable.map((s) => s.axes.y.z);
      if (
        this.stable.length >= 10 &&
        now - this.stable[0].at >= 450 &&
        Math.max(...zs) - Math.min(...zs) < 0.035
      ) {
        this.ref = captureTray(axes);
        this.filter = new SteerFilter();
        this.status = "Wheel ready";
        this.armed = true;
      }
    }
    if (this.ref) {
      const raw = trayRead(axes, this.ref).bank;
      // Learn small resting bias only while stationary/counting in. During a
      // held corner retain the player's deliberate input, regardless of duration.
      const shaped = canCapture
        ? this.filter.update(raw, dt)
        : this.filter.update(raw, 0);
      this.value = clamp((shaped / STEER_FULL) * STEERING_SENSITIVITY, -1, 1) * (this.invert ? -1 : 1);
      this.armed = true;
      this.status = "Wheel ready";
    }
    return true;
  }
  setButtons(buttons, now) {
    if (!buttons || typeof buttons !== "object") return;
    this.buttons = Object.fromEntries(
      ["A", "B", "1", "2", "up", "down", "left", "right"].map((k) => [k, buttons[k] === true]),
    );
    this.lastButtonsAt = now;
  }
  command(cmd, now) {
    if (cmd.type === "buttons") this.setButtons(cmd.buttons, now);
    if (cmd.type === "button" && cmd.button) {
      this.buttons[cmd.button] = cmd.pressed !== false;
      this.lastButtonsAt = now;
    }
    if (cmd.type === "button-up") {
      this.buttons[cmd.button] = false;
      this.lastButtonsAt = now;
    }
  }
  read(now) {
    const live = now - this.lastAt < 450,
      buttonsLive = now - this.lastButtonsAt < 650;
    // Packet loss cannot leave gas/drift stuck, even if no disconnect event arrives.
    if (!live) {
      this.value = 0;
      this.armed = false;
    }
    const b = buttonsLive ? this.buttons : {};
    return {
      steer: live && this.armed ? this.value : 0,
      gas: !!b["2"],
      brake: !!b["1"],
      drift: !!b.A,
      item: !!b.right,
      live,
      status: live ? this.status : "Wheel signal lost · keyboard available",
    };
  }
}
