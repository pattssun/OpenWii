/**
 * Client side of the relay protocol.
 *
 * Every sample carries a `slot` — the player index the server assigned to that
 * controller. Only slot 0 is used today, but games that read `slot` from the
 * start cost nothing now and don't need rewriting when a second phone appears.
 */
export class GameLink {
  constructor({ onOrientation, onCommand, onPresence } = {}) {
    // eslint-disable-next-line no-undef
    this.socket = io({ transports: ['websocket', 'polling'] });
    this.controllers = 0;
    this.slots = [];
    this.rate = 0;

    this.socket.on('connect', () => this.socket.emit('register', 'game'));

    let samples = 0;
    let mark = performance.now();
    this.socket.on('orientation', (data) => {
      const now = performance.now();
      samples += 1;
      if (now - mark >= 1000) {
        this.rate = (samples * 1000) / (now - mark);
        samples = 0;
        mark = now;
      }
      if (onOrientation) onOrientation(data, data.slot ?? 0);
    });

    this.socket.on('command', (cmd) => onCommand && onCommand(cmd, cmd.slot ?? 0));
    this.socket.on('presence', (p) => {
      this.controllers = p.controller;
      this.slots = p.slots || [];
      if (onPresence) onPresence(p);
    });

    // Latency probe: the phone echoes these back so we can measure a true
    // round trip. One-way timestamps would need synchronised clocks across two
    // devices, which we do not have.
    this.pingCallbacks = new Map();
    this.socket.on('pong-probe', ({ id }) => {
      const started = this.pingCallbacks.get(id);
      if (started === undefined) return;
      this.pingCallbacks.delete(id);
      if (this.onLatency) this.onLatency(performance.now() - started);
    });
  }

  feedback(msg) {
    this.socket.emit('feedback', msg);
  }

  /** Fire a round-trip probe; resolves via onLatency. */
  probeLatency() {
    const id = Math.floor(performance.now() * 1000) % 1e9;
    this.pingCallbacks.set(id, performance.now());
    this.socket.emit('ping-probe', { id });
    // Don't leak entries when a phone drops mid-probe.
    setTimeout(() => this.pingCallbacks.delete(id), 5000);
  }
}
