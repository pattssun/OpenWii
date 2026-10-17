import { CHARACTERS } from './logic.js';

export class DuoLobby {
  constructor(playerCount = 2) {
    this.playerCount = playerCount === 4 ? 4 : 2;
    this.reset();
  }
  reset() {
    this.characters = CHARACTERS.slice(0, this.playerCount).map(c => c.id);
    this.ready = Array(this.playerCount).fill(false);
    this.identities = Array(this.playerCount).fill(null);
  }
  choose(slot, direction) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.playerCount || this.ready[slot]) return false;
    const delta = { left: -1, right: 1, up: -4, down: 4 }[direction];
    if (!delta) return false;
    let index = CHARACTERS.findIndex((c) => c.id === this.characters[slot]);
    const original = index;
    const occupied = new Set(this.characters.filter((_, i) => i !== slot));
    // A vertical step can visit only two characters. Bound that search and
    // fall back to the next free driver rather than locking the lobby.
    const visited = new Set();
    while (!visited.has(index)) {
      visited.add(index);
      index = (index + delta + CHARACTERS.length) % CHARACTERS.length;
      if (index !== original && !occupied.has(CHARACTERS[index].id)) {
        this.characters[slot] = CHARACTERS[index].id;
        return true;
      }
    }
    for (let offset = 1; offset < CHARACTERS.length; offset++) {
      const candidate = CHARACTERS[(original + offset) % CHARACTERS.length].id;
      if (!occupied.has(candidate)) {
        this.characters[slot] = candidate;
        return true;
      }
    }
    return false;
  }
  setReady(slot, identity, motionReady) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.playerCount || !identity || !motionReady) return false;
    this.ready[slot] = true;
    this.identities[slot] = identity;
    return true;
  }
  cancel(slot) {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.playerCount) return;
    this.ready[slot] = false;
  }
  sync(slots, live) {
    for (let slot = 0; slot < this.playerCount; slot++) {
      if (!slots[slot]?.occupied || !live[slot] ||
        (this.identities[slot] && this.identities[slot] !== slots[slot].identity))
        this.ready[slot] = false;
    }
  }
  canStart(slots, live) {
    return this.ready.every(Boolean) && this.ready.every((_, slot) =>
      slots[slot]?.occupied && slots[slot].identity === this.identities[slot] && live[slot]);
  }
  sameParticipants(slots) {
    return this.ready.every((_, slot) => this.identities[slot] &&
      slots[slot]?.occupied && slots[slot].identity === this.identities[slot]);
  }
}
