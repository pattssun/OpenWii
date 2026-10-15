import test from "node:test";
import assert from "node:assert/strict";
import { WheelInput } from "./input.js";
import { AUDIO_SLOTS, engineFrequency, KartAudio } from "./audio.js";
import { EVENT_TYPES, CHARACTERS } from "./logic.js";
import { modelSpec } from "./model-spec.js";
import { Quaternion, Matrix4, Vector3 } from "three";
// Build observed tray orientations from vectors and a separate Three.js matrix
// implementation. The documented device pin says the east/right end drops when
// rotating around world north. No Euler labels from the implementation reused.
function sample(degrees = 0, flip = false) {
  const lean = (10 * Math.PI) / 180,
    s = Math.sin(lean),
    c = Math.cos(lean);
  const axes = flip
    ? [new Vector3(0, c, s), new Vector3(-1, 0, 0), new Vector3(0, -s, c)]
    : [new Vector3(0, -c, -s), new Vector3(1, 0, 0), new Vector3(0, -s, c)];
  const roll = new Quaternion().setFromAxisAngle(
    new Vector3(0, 1, 0),
    (degrees * Math.PI) / 180,
  );
  axes.forEach((v) => v.applyQuaternion(roll));
  return {
    quat: new Quaternion()
      .setFromRotationMatrix(new Matrix4().makeBasis(...axes))
      .toArray(),
  };
}
function settled(flip = false) {
  const w = new WheelInput();
  for (let t = 0; t < 800; t += 16)
    w.sample(sample(0, flip), t, { canCapture: true });
  return w;
}
test("both landscape grips honor the device-pinned east-end-down sign", () => {
  for (const flip of [false, true]) {
    const w = settled(flip);
    assert.ok(w.ref);
    w.sample(sample(12, flip), 816);
    assert.ok(w.read(820).steer > 0.3);
    w.sample(sample(-12, flip), 832);
    assert.ok(w.read(840).steer < -0.3);
  }
});
test("small phone tilts give gentle corrections while larger tilts retain full steering", () => {
  for (const flip of [false, true]) {
    const w = settled(flip);
    let now = 816;
    for (const direction of [-1, 1]) {
      const values = [];
      for (const degrees of [2, 5, 12, 18, 30]) {
        w.sample(sample(degrees * direction, flip), now);
        values.push(w.read(now + 1).steer * direction);
        now += 16;
      }
      assert.equal(Math.abs(values[0]), 0, 'hand tremor stays inside the deadzone');
      assert.ok(values[1] > .08 && values[1] < .12, '5 degrees is a small correction');
      assert.ok(values[2] > .3 && values[2] < .4, '12 degrees is below half steering');
      assert.ok(values[3] > .55 && values[3] < .65, 'the former full-lock angle is now moderate');
      assert.equal(values[4], 1, '30 degrees still reaches full steering');
      assert.ok(values.every((v,i) => i === 0 || v > values[i-1]));
    }
  }
});
test("one tilted/moving countdown sample never becomes a permanent wrong neutral", () => {
  const w = new WheelInput();
  for (let t = 0; t < 1500; t += 16)
    w.sample(sample(7), t, { canCapture: true });
  assert.equal(w.ref, null);
  assert.equal(w.read(1495).steer, 0);
  for (let t = 1504; t < 2300; t += 16)
    w.sample(sample(0), t, { canCapture: true });
  assert.ok(w.ref);
  assert.equal(w.read(2300).steer, 0);
});
test("invalid samples cannot contaminate steering; idle/stale input becomes neutral", () => {
  const w = settled();
  w.sample(sample(25), 816);
  assert.ok(w.read(820).steer > 0);
  assert.equal(w.sample({ quat: [NaN, 0, 0, 1] }, 832), false);
  assert.equal(w.sample({ quat: [1, 1, 1, 1] }, 850), false);
  assert.equal(w.read(1400).steer, 0);
  w.sample(sample(0), 1416);
  assert.equal(w.read(1420).steer, 0);
});
test("multi-touch holds, individual release, snapshots, and stale holds", () => {
  const w = settled();
  w.command({ type: "button", button: "2", pressed: true }, 800);
  w.command({ type: "button", button: "A", pressed: true }, 820);
  let r = w.read(825);
  assert.ok(r.gas && r.drift);
  w.command({ type: "button-up", button: "A" }, 850);
  r = w.read(860);
  assert.ok(r.gas && !r.drift);
  w.command({ type: "buttons", buttons: { 1: true } }, 900);
  r = w.read(910);
  assert.ok(r.brake && !r.gas);
  assert.equal(w.read(1700).brake, false);
});
test("holding a real corner is never slowly mistaken for sensor bias", () => {
  const w = settled();
  w.sample(sample(5), 816);
  const first = w.read(820).steer;
  for (let t = 832; t < 30000; t += 16) w.sample(sample(5), t);
  assert.ok(Math.abs(w.read(30000).steer - first) < 1e-8);
});
test("invert preference reverses direction, reset requires fresh stable neutral", () => {
  const w = settled();
  w.sample(sample(12), 820);
  const a = w.read(825).steer;
  w.invert = true;
  w.sample(sample(12), 840);
  assert.ok(Math.abs(w.read(845).steer + a) < 1e-8);
  w.reset();
  assert.equal(w.read(850).steer, 0);
  assert.equal(w.ref, null);
});
test("all simulation events have sound slots and registered synth fallbacks", () => {
  const audio = new KartAudio();
  for (const event of EVENT_TYPES) {
    assert.ok(AUDIO_SLOTS.includes("mk-" + event));
    assert.equal(typeof audio.engine.synths.get("mk-" + event), "function");
  }
  assert.ok(
    AUDIO_SLOTS.includes("mk-engine") && AUDIO_SLOTS.includes("mk-music"),
  );
  assert.ok(
    engineFrequency(40) > engineFrequency(20) &&
      engineFrequency(20) > engineFrequency(0),
  );
  assert.ok(Number.isFinite(engineFrequency(NaN)));
});
test("eight model specifications have distinct silhouettes, named wheel pivots and finite dimensions", () => {
  const signatures = new Set();
  for (const c of CHARACTERS) {
    const spec = modelSpec(c.id);
    assert.equal(spec.id, c.id);
    for (let i = 0; i < 4; i++)
      assert.ok(spec.parts.find((p) => p.name === "wheel-" + i));
    for (const p of spec.parts) {
      assert.ok(
        p.p.every(Number.isFinite) &&
          p.s.every((n) => Number.isFinite(n) && n > 0),
      );
    }
    signatures.add(spec.parts.map((p) => p.name).join(","));
  }
  // Mario/Luigi deliberately share the plumber silhouette, with different badges.
  assert.equal(signatures.size, 7);
});

test("Mario Kart uses A for drift and right for items, with separate brake and gas", () => {
  const w = settled();
  w.setButtons({A:true,right:true,2:true},800);
  const r=w.read(810);assert.ok(r.gas&&r.drift&&r.item&&!r.brake);
  w.setButtons({B:true,up:true,1:true},820);
  const old=w.read(830);assert.ok(old.brake&&!old.gas&&!old.drift&&!old.item);
});
