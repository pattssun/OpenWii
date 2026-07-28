import { TAU } from './orientation.js';

/**
 * One Euro filter — adaptive low-pass.
 *
 * Heavy smoothing when the input is nearly still (kills IMU jitter), almost
 * none when it's moving fast (keeps swings crisp). A plain moving average has
 * to choose one or the other and smears every fast gesture.
 */
export class OneEuro {
  constructor(minCutoff = 1.4, beta = 0.05, dCutoff = 1) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = null;
    this.dx = 0;
  }

  static alpha(cutoff, dt) {
    const tau = 1 / (TAU * cutoff);
    return 1 / (1 + tau / dt);
  }

  filter(value, dt) {
    if (this.x === null) {
      this.x = value;
      return value;
    }
    const dRaw = (value - this.x) / dt;
    this.dx += OneEuro.alpha(this.dCutoff, dt) * (dRaw - this.dx);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.dx);
    this.x += OneEuro.alpha(cutoff, dt) * (value - this.x);
    return this.x;
  }

  reset() {
    this.x = null;
    this.dx = 0;
  }
}
