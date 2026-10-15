import { CHARACTERS } from './logic.js';

export class DuoLobby {
  constructor() { this.reset(); }
  reset() {
    this.characters = [CHARACTERS[0].id, CHARACTERS[1].id];
    this.ready = [false, false];
    this.identities = [null, null];
  }
  choose(slot, direction) {
    if (slot !== 0 && slot !== 1 || this.ready[slot]) return false;
    const delta = { left: -1, right: 1, up: -4, down: 4 }[direction];
    if (!delta) return false;
    let index = CHARACTERS.findIndex((c) => c.id === this.characters[slot]);
    do { index = (index + delta + CHARACTERS.length) % CHARACTERS.length; }
    while (CHARACTERS[index].id === this.characters[1 - slot]);
    this.characters[slot] = CHARACTERS[index].id;
    return true;
  }
  setReady(slot, identity, motionReady) {
    if ((slot !== 0 && slot !== 1) || !identity || !motionReady) return false;
    this.ready[slot] = true;
    this.identities[slot] = identity;
    return true;
  }
  cancel(slot) {
    if (slot !== 0 && slot !== 1) return;
    this.ready[slot] = false;
  }
  sync(slots, live) {
    for (let slot = 0; slot < 2; slot++) {
      if (!slots[slot]?.occupied || !live[slot] ||
        (this.identities[slot] && this.identities[slot] !== slots[slot].identity))
        this.ready[slot] = false;
    }
  }
  canStart(slots, live) {
    return this.ready.every(Boolean) && [0, 1].every((slot) =>
      slots[slot]?.occupied && slots[slot].identity === this.identities[slot] && live[slot]);
  }
  sameParticipants(slots) {
    return [0, 1].every((slot) => this.identities[slot] &&
      slots[slot]?.occupied && slots[slot].identity === this.identities[slot]);
  }
}
