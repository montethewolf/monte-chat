import test from "node:test";
import assert from "node:assert/strict";
import { age, buildBrief, chunkText } from "../src/brief.js";

const NOW = new Date("2026-09-05T12:00:00Z");
const MS = NOW.getTime();

test("age renders compact relative times", () => {
  assert.equal(age(MS - 30_000, MS), "now");
  assert.equal(age(MS - 10 * 60_000, MS), "10m");
  assert.equal(age(MS - 5 * 3_600_000, MS), "5h");
  assert.equal(age(MS - 18 * 86_400_000, MS), "18d");
  assert.equal(age(null, MS), "");
  assert.equal(age(MS + 1000, MS), "");
});

test("chunkText splits on newlines under the cap and never exceeds it", () => {
  assert.deepEqual(chunkText("short"), ["short"]);
  const text = Array.from({ length: 100 }, (_, i) => `line ${i} ${"x".repeat(50)}`).join("\n");
  const chunks = chunkText(text, 500);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= 500, `chunk of ${c.length} exceeds cap`);
  assert.equal(chunks.join("\n"), text);
  // no newline available: hard cut
  const hard = chunkText("y".repeat(1200), 500);
  assert.deepEqual(
    hard.map((c) => c.length),
    [500, 500, 200],
  );
});

test("minimal brief keeps header, focus line, directive, and ack", () => {
  const brief = buildBrief({ now: NOW });
  assert.match(brief, /^\[SYSTEM BRIEF /);
  assert.match(brief, /\[voice focus: none — default conversation\]/);
  assert.match(brief, /Absorb silently\./);
  assert.match(brief, /Acknowledge now with only: "Ready\."/);
});

test("cron failures come first with the error detail", () => {
  const brief = buildBrief({
    now: NOW,
    cron: [
      { name: "journal", ok: true, finishedAt: MS - 3_600_000, error: null },
      { name: "review loop", ok: false, finishedAt: MS - 7_200_000, error: "SyntaxError in loop.py" },
    ],
  });
  assert.match(brief, /Cron \(12h\): 1 ok; FAILED: "review loop" 2h ago \(SyntaxError in loop\.py\)\./);
});

test("focused brief carries the thread contract and title ack", () => {
  const brief = buildBrief({
    now: NOW,
    focus: { title: "Kokoro API", messageCount: 30 },
  });
  assert.match(brief, /\[voice focus: thread "Kokoro API" — the Hermes conversation now IS that thread \(30 msgs\)/);
  assert.match(brief, /recent_voice_context/);
  assert.match(brief, /Acknowledge now with only: "Focused on Kokoro API\."/);
});

test("over-budget briefs drop thread items first and never the tail", () => {
  const threads = Array.from({ length: 30 }, (_, i) => ({
    sessionId: `s${i}`,
    title: `A fairly long conversation title number ${i} about something`,
    lastActive: MS - i * 86_400_000,
  }));
  const brief = buildBrief({ now: NOW, threads, maxChars: 700 });
  assert.ok(brief.length <= 700, `brief is ${brief.length} chars`);
  assert.match(brief, /Acknowledge now with only: "Ready\."/);
  const listed = (brief.match(/^- /gm) ?? []).length;
  assert.ok(listed < 30, "thread list should have been trimmed");
});

test("extreme budget still preserves focus and ack via middle truncation", () => {
  const brief = buildBrief({
    now: NOW,
    focus: { title: "T", messageCount: 1 },
    cron: Array.from({ length: 20 }, (_, i) => ({
      name: `job with a very long descriptive name ${i}`,
      ok: false,
      finishedAt: MS - 1000,
      error: "e".repeat(100),
    })),
    maxChars: 600,
  });
  assert.ok(brief.length <= 620, `brief is ${brief.length} chars`); // small slack for the ellipsis line
  assert.match(brief, /Acknowledge now with only: "Focused on T\."/);
});
