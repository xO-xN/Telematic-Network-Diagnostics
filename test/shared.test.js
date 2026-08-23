const assert = require("node:assert/strict");
const test = require("node:test");

const {
  freqRange,
  freqFromValue,
  freqFraction,
  freqTicks,
  registers,
  defaultRegister,
} = require("../public/shared");

test("freqTicks.semitones covers the 19 notes strictly inside the range", () => {
  assert.equal(freqTicks.semitones.length, 19);

  for (let i = 1; i < freqTicks.semitones.length; i += 1) {
    assert.ok(freqTicks.semitones[i] > freqTicks.semitones[i - 1]);
  }

  // The range endpoints (1000 / 3000 Hz) are not notes: no tick at either.
  assert.ok(freqTicks.semitones[0] > freqRange.min);
  assert.ok(freqTicks.semitones.at(-1) < freqRange.max);

  // F5 = 698.456 Hz and B6 = 1975.533 Hz (A4 = 440 Hz): the extreme ticks
  // of the default register.
  assert.ok(Math.abs(freqTicks.semitones[0] - 440 * 2 ** (8 / 12)) < 1e-9);
  assert.ok(Math.abs(freqTicks.semitones.at(-1) - 440 * 2 ** (26 / 12)) < 1e-9);
});

test("freqTicks.labeled marks the center note and its upper/lower fifth", () => {
  assert.deepEqual(
    freqTicks.labeled.map((entry) => entry.name),
    ["A", "E", "B"],
  );

  // A5 = E6's lower fifth (midi 81), B6 = E6's upper fifth (midi 95).
  const expected = [
    { name: "A", midi: 81 },
    { name: "E", midi: 88 },
    { name: "B", midi: 95 },
  ];
  const semitoneSet = new Set(freqTicks.semitones);

  freqTicks.labeled.forEach((entry, index) => {
    assert.ok(
      entry.freq > freqRange.min && entry.freq < freqRange.max,
      `${entry.name} sits inside the range`,
    );
    assert.ok(semitoneSet.has(entry.freq), `${entry.name} is a semitone tick`);
    assert.ok(
      Math.abs(entry.freq - 440 * 2 ** ((expected[index].midi - 69) / 12)) <
        1e-9,
      `${entry.name} is ${expected[index].name}`,
    );
  });

  // The center label is the semitone tick nearest the band's center.
  const center = freqTicks.labeled[1];
  const bandCenter = freqRange.min + (freqRange.max - freqRange.min) / 2;
  const nearest = freqTicks.semitones.reduce((best, freq) =>
    Math.abs(freq - bandCenter) < Math.abs(best - bandCenter) ? freq : best,
  );
  assert.equal(center.freq, nearest);
});

test("freq helpers invert the linear fader ↔ Hz mapping", () => {
  assert.equal(freqFromValue(0), freqRange.min);
  assert.equal(freqFromValue(1), freqRange.max);
  assert.equal(
    freqFromValue(0.5),
    freqRange.min + 0.5 * (freqRange.max - freqRange.min),
  );
  assert.equal(freqFraction(freqRange.min), 0);
  assert.equal(freqFraction(freqRange.max), 1);
  assert.equal(freqFraction(freqFromValue(0.25)), 0.25);
});

test("registers expose three bands with the same 19-tick structure", () => {
  assert.deepEqual(Object.keys(registers).map(Number), [1, 2, 3]);

  for (const key of [1, 2, 3]) {
    const reg = registers[key];
    assert.equal(reg.freqTicks.semitones.length, 19);
    assert.equal(reg.freqTicks.labeled.length, 3);

    for (let i = 1; i < reg.freqTicks.semitones.length; i += 1) {
      assert.ok(reg.freqTicks.semitones[i] > reg.freqTicks.semitones[i - 1]);
    }

    // Band endpoints are not notes: extreme ticks sit strictly inside.
    assert.ok(reg.freqTicks.semitones[0] > reg.freqRange.min);
    assert.ok(reg.freqTicks.semitones.at(-1) < reg.freqRange.max);

    // Labeled notes are semitone ticks with distinct letters.
    const letters = new Set(reg.freqTicks.labeled.map((e) => e.name));
    assert.equal(letters.size, 3);
    const semitoneSet = new Set(reg.freqTicks.semitones);
    for (const entry of reg.freqTicks.labeled) {
      assert.ok(semitoneSet.has(entry.freq), `${entry.name} is a semitone tick`);
    }

    // The center note sits at the same fader fraction in every register
    // (the bands are exact shifts of each other).
    const referenceCenterFraction = freqFraction(
      registers[3].freqTicks.labeled[1].freq,
    );
    const centerFraction = freqFraction(
      reg.freqTicks.labeled[1].freq,
      reg.freqRange,
    );
    assert.ok(Math.abs(centerFraction - referenceCenterFraction) < 1e-12);
  }
});

test("register bands descend by fifths (each register's labels = the previous register's shifted down one fifth)", () => {
  // Centers are E6 / A5 / D5; every labeled note of a register is the
  // same-named note of the next register, one fifth lower.
  const expectedNames = {
    3: ["A", "E", "B"],
    2: ["D", "A", "E"],
    1: ["G", "D", "A"],
  };
  for (const key of [1, 2, 3]) {
    assert.deepEqual(
      registers[key].freqTicks.labeled.map((e) => e.name),
      expectedNames[key],
    );
  }

  for (const index of [0, 1, 2]) {
    // register 2's label[i] = register 3's label[i] shifted down one fifth.
    assert.ok(
      Math.abs(
        registers[2].freqTicks.labeled[index].freq -
          registers[3].freqTicks.labeled[index].freq / 2 ** (7 / 12),
      ) < 1e-9,
    );
    // register 1's label[i] = register 2's label[i] shifted down one fifth.
    assert.ok(
      Math.abs(
        registers[1].freqTicks.labeled[index].freq -
          registers[2].freqTicks.labeled[index].freq / 2 ** (7 / 12),
      ) < 1e-9,
    );
  }

  // Bands shift by 7 semitones per register; register 3 itself sits one
  // fifth below the original 1000–3000 Hz range.
  assert.ok(Math.abs(registers[3].freqRange.min - 1000 * 2 ** (-7 / 12)) < 1e-9);
  assert.ok(Math.abs(registers[2].freqRange.min - 1000 * 2 ** (-14 / 12)) < 1e-9);
  assert.ok(Math.abs(registers[1].freqRange.min - 1000 * 2 ** (-21 / 12)) < 1e-9);
});

test("default register is 3 and freqRange/freqTicks alias it", () => {
  assert.equal(defaultRegister, 3);
  assert.deepEqual(freqRange, registers[3].freqRange);
  assert.deepEqual(freqTicks, registers[3].freqTicks);
});
