import assert from "node:assert/strict";
import test from "node:test";
import { matterQrSvg } from "./matter-qr.js";

test("QR has black finder patterns on white with a four-module quiet zone", () => {
  const svg = matterQrSvg("MT:Y.K9042C00KA0648G00");
  assert.match(svg, /viewBox="0 0 29 29"/);
  assert.match(svg, /width="464" height="464"/);
  assert.match(svg, /<rect width="29" height="29" fill="#fff"/);
  assert.match(svg, /fill="#000"/);
  const black = new Set([...svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)].map(([, x, y]) => `${x},${y}`));
  assert.ok(black.size > 0);
  for (let y = 0; y < 29; y++) {
    for (let x = 0; x < 29; x++) {
      if (x < 4 || y < 4 || x >= 25 || y >= 25) assert.equal(black.has(`${x},${y}`), false);
    }
  }
  // Standard 7x7 finder: black border, white ring, black 3x3 center.
  // This fails if terminal background blocks are mistaken for dark modules.
  for (const [left, top] of [[4, 4], [18, 4], [4, 18]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        const expected = x === 0 || x === 6 || y === 0 || y === 6 ||
          (x >= 2 && x <= 4 && y >= 2 && y <= 4);
        assert.equal(black.has(`${left + x},${top + y}`), expected, `finder ${left},${top} at ${x},${y}`);
      }
    }
  }
});
