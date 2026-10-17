'use strict';
const { createHash } = require('crypto');

/** Slot reservations live for one server run. */
class PhoneSlots {
  constructor(max = 4) {
    this.slots = Array.from({ length: max }, () => ({ socket: null, identity: null }));
  }
  assign(socket, identity = null) {
    if (typeof identity === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(identity)) {
      const reserved = this.slots.findIndex((entry) => entry.identity === identity);
      if (reserved !== -1) {
        if (this.slots[reserved].socket) return -1;
        this.slots[reserved].socket = socket;
        return reserved;
      }
    } else identity = null;
    const free = this.slots.findIndex((entry) => entry.socket === null && entry.identity === null);
    if (free === -1) return -1;
    this.slots[free] = { socket, identity };
    return free;
  }
  release(socket) {
    const i = this.slotOf(socket);
    if (i >= 0) this.slots[i].socket = null;
    if (i >= 0 && !this.slots[i].identity) this.slots[i] = { socket: null, identity: null };
  }
  slotOf(socket) { return this.slots.findIndex((entry) => entry.socket === socket); }
  socketAt(slot) { return this.slots[slot]?.socket || null; }
  presence() { return this.slots.map((entry, slot) => ({ slot, occupied: !!entry.socket,
    identity: entry.identity ? createHash('sha256').update(entry.identity).digest('hex') : null })); }
}

module.exports = { PhoneSlots };
