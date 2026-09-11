// Pure assembly of the call-start system brief. No I/O here: index.js gathers
// the data (hermes-status.js) and this module turns it into one bounded text
// block. The brief is an index, not a database — realtime context is billed on
// every turn, so it stays compact and points the model at
// continue_hermes_conversation for anything deeper.

const DAY = 86_400_000;

export function age(thenMs, nowMs) {
  if (!thenMs || !nowMs || thenMs > nowMs) return "";
  const d = nowMs - thenMs;
  if (d < 90_000) return "now";
  if (d < 5_400_000) return `${Math.round(d / 60_000)}m`;
  if (d < 2 * DAY) return `${Math.round(d / 3_600_000)}h`;
  return `${Math.round(d / DAY)}d`;
}

export function chunkText(text, max = 1900) {
  const chunks = [];
  let rest = String(text);
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut < max / 2) cut = max;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}

function gatewayLine(gateway) {
  if (!gateway) return null;
  const platforms = gateway.platforms?.length
    ? `${gateway.platforms.length} platforms up (${gateway.platforms.join(", ")})`
    : "no platforms connected";
  return `Gateway: ${gateway.state}, ${platforms}.`;
}

function kanbanLine(kanban) {
  if (!kanban) return null;
  const total = Object.values(kanban.counts).reduce((a, b) => a + b, 0);
  if (total === 0) return "Factory: kanban idle.";
  const parts = Object.entries(kanban.counts).map(([status, n]) => `${n} ${status}`);
  const examples = kanban.inProgress.length
    ? ` — ${kanban.inProgress.map((t) => `"${t}"`).join(", ")}`
    : "";
  return `Factory: ${parts.join(", ")}${examples}.`;
}

function cronLines(cron, nowMs, withDetail) {
  if (!cron || cron.length === 0) return null;
  const failed = cron.filter((c) => !c.ok);
  const okCount = cron.length - failed.length;
  const failParts = failed.map((c) => {
    const when = age(c.finishedAt, nowMs);
    const detail = withDetail && c.error ? ` (${c.error})` : "";
    return `"${c.name}" ${when} ago${detail}`;
  });
  let line = `Cron (12h): ${okCount} ok`;
  if (failParts.length > 0) line += `; FAILED: ${failParts.join(", ")}`;
  return `${line}.`;
}

function backgroundLine(work) {
  if (!work) return null;
  const parts = [];
  if (work.delegations > 0) parts.push(`${work.delegations} delegation${work.delegations > 1 ? "s" : ""} running`);
  if (work.activeTurns > 0) parts.push(`${work.activeTurns} chat turn${work.activeTurns > 1 ? "s" : ""} in flight`);
  if (work.pendingDeliveries > 0) parts.push(`${work.pendingDeliveries} deliveries pending`);
  if (parts.length === 0) return Object.values(work).some((v) => v == null) ? "Background: status unavailable." : "Background: quiet.";
  return `Background: ${parts.join(", ")}.`;
}

function focusBlock(focus) {
  if (!focus) {
    return {
      line: "[voice focus: none — default conversation]",
      ack: 'Acknowledge now with only: "Ready."',
    };
  }
  const title = focus.title ?? "the focused thread";
  const msgs = focus.messageCount ? ` (${focus.messageCount} msgs)` : "";
  return {
    line:
      `[voice focus: thread "${title}" — the Hermes conversation now IS that thread${msgs}. ` +
      `Use the selected discussion history; consult Hermes for missing evidence. ` +
      `Background tasks do not inherit the thread — pass the relevant facts in recent_voice_context.]`,
    ack: `Acknowledge now with only: "Focused on ${title}."`,
  };
}

export function buildBrief({
  now = new Date(),
  gateway = null,
  kanban = null,
  cron = null,
  activeWork = null,
  threads = [],
  focus = null,
  maxChars = 1800,
} = {}) {
  const nowMs = now.getTime();
  const stamp = now.toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const { line: focusLine, ack } = focusBlock(focus);
  const header = `[SYSTEM BRIEF ${stamp} — not spoken by the user; context only]`;
  const guidance =
    "Hermes command approvals are presented in this call and through Discord buttons. Wait for an explicit answer; never suggest rerunning a pending command. " +
    "Use the project catalog and discovery before asking for identifiers. Brainstorm consultations can query GitHub, Factory and CLI tools. Small explicitly requested actions retain Brainstorm.";
  const directive =
    "Absorb silently. Use consult_hermes for evidence in Brainstorm, Work tools for implementation, and local mode controls for mode changes.";

  const assemble = (threadCount, cronDetail, withGuidance) => {
    const lines = [header, gatewayLine(gateway), kanbanLine(kanban), cronLines(cron, nowMs, cronDetail), backgroundLine(activeWork)];
    if (threads.length > 0 && threadCount > 0) {
      lines.push('Recent Discord threads:');
      for (const t of threads.slice(0, threadCount)) {
        const when = t.lastActive ? ` (${age(t.lastActive, nowMs)})` : "";
        lines.push(`- ${t.title}${when}`);
      }
    }
    lines.push(focusLine, withGuidance ? guidance : null, directive, ack);
    return lines.filter(Boolean).join("\n");
  };

  // Deterministic trim: drop thread items, then cron error detail, then the
  // approval/mirroring guidance, then hard cut.
  let threadCount = threads.length;
  let cronDetail = true;
  let withGuidance = true;
  let text = assemble(threadCount, cronDetail, withGuidance);
  while (text.length > maxChars && threadCount > 0) {
    threadCount -= 1;
    text = assemble(threadCount, cronDetail, withGuidance);
  }
  if (text.length > maxChars && cronDetail) {
    cronDetail = false;
    text = assemble(threadCount, cronDetail, withGuidance);
  }
  if (text.length > maxChars && withGuidance) {
    withGuidance = false;
    text = assemble(threadCount, cronDetail, withGuidance);
  }
  if (text.length > maxChars) {
    // Never cut the focus/directive/ack tail: trim the middle instead.
    const tail = [focusLine, directive, ack].join("\n");
    const headroom = maxChars - tail.length - 2;
    text = `${text.slice(0, Math.max(headroom, header.length))}…\n${tail}`;
  }
  return text;
}
