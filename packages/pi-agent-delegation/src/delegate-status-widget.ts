import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** One running delegate row rendered in the persistent above-editor widget. */
export interface DelegateStatusWidgetItem {
  readonly title: string;
  readonly subagent?: string;
  readonly profile?: string;
  readonly harness?: string;
  readonly startTime: number;
  readonly status?: string;
}

/** Format a delegate elapsed duration as an unbounded MM:SS value. */
export function formatDelegateElapsedMMSS(
  startTime: number,
  now = Date.now(),
): string {
  const seconds = Math.max(0, Math.floor((now - startTime) / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function normalizeWidgetWidth(width: number): number {
  if (!Number.isFinite(width)) return process.stdout.columns ?? 80;
  return Math.max(0, Math.floor(width));
}

function padVisible(text: string, width: number, fill = " "): string {
  const missing = Math.max(0, width - visibleWidth(text));
  return `${text}${fill.repeat(missing)}`;
}

function fitVisible(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  return truncateToWidth(text, width, "…");
}

function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "│";

  const innerWidth = Math.max(0, width - 2);
  const rightWidth = visibleWidth(right);
  if (rightWidth >= innerWidth) {
    return `│${padVisible(fitVisible(right, innerWidth), innerWidth)}│`;
  }

  const fittedLeft = fitVisible(left, innerWidth - rightWidth);
  const gap = " ".repeat(
    Math.max(0, innerWidth - visibleWidth(fittedLeft) - rightWidth),
  );
  return `│${fittedLeft}${gap}${right}│`;
}

function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╭";

  const innerWidth = Math.max(0, width - 2);
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fill = "─".repeat(
    Math.max(0, innerWidth - visibleWidth(titlePart) - visibleWidth(infoPart)),
  );
  const fitted = fitVisible(`${titlePart}${fill}${infoPart}`, innerWidth);
  return `╭${padVisible(fitted, innerWidth, "─")}╮`;
}

function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return "╰";
  return `╰${"─".repeat(Math.max(0, width - 2))}╯`;
}

function delegateIdentityTag(item: DelegateStatusWidgetItem): string {
  if (item.subagent && item.profile) {
    return ` (${item.subagent}[${item.profile}])`;
  }
  if (item.subagent) return ` (${item.subagent})`;
  if (item.harness) return ` (freeform · ${item.harness})`;
  return "";
}

/** Render the boxed, width-aware running-subagent widget used above Pi's editor. */
export function renderDelegateStatusWidgetLines(
  items: ReadonlyArray<DelegateStatusWidgetItem>,
  now = Date.now(),
  width = process.stdout.columns ?? 80,
): string[] {
  const widgetWidth = normalizeWidgetWidth(width);
  const lines = [
    borderTop("Subagents", `${items.length} running`, widgetWidth),
  ];

  for (const item of items) {
    const elapsed = formatDelegateElapsedMMSS(item.startTime, now);
    const left = ` ${elapsed}  ${item.title}${delegateIdentityTag(item)}`;
    const status = item.status?.trim() || "working";
    const right = ` ${status} · ${elapsed} `;
    lines.push(borderLine(left, right, widgetWidth));
  }

  lines.push(borderBottom(widgetWidth));
  return lines;
}
