import assert from "node:assert/strict";
import { test } from "node:test";
import { getPasswordStrength } from "./passwordStrength.js";

test("getPasswordStrength returns null for an empty password, so the meter can stay hidden before typing starts", () => {
  assert.equal(getPasswordStrength(""), null);
});

test("getPasswordStrength rates a long single-character-class password as weak", () => {
  assert.equal(getPasswordStrength("aaaaaaaa"), "weak");
  assert.equal(getPasswordStrength("aaaaaaaaaaaa"), "weak");
});

test("getPasswordStrength rates a password with some variety as fair", () => {
  assert.equal(getPasswordStrength("Password1"), "fair");
});

test("getPasswordStrength rates a longer password using all four character classes as strong", () => {
  assert.equal(getPasswordStrength("Password1!"), "strong");
  assert.equal(getPasswordStrength("K7$mq!zX9pL"), "strong");
});

test("getPasswordStrength is monotonic: adding character-class variety to the same base never lowers the rating", () => {
  const base = "abcdEFGH";
  const order = ["weak", "fair", "strong"];
  const withDigit = getPasswordStrength(base + "1")!;
  const withDigitAndSymbol = getPasswordStrength(base + "1!")!;
  assert.ok(
    order.indexOf(withDigitAndSymbol) >= order.indexOf(withDigit),
    "adding a symbol on top of a digit must never rate as weaker",
  );
});
