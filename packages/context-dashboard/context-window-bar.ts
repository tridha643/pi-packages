const DESIRED_TRACK_WIDTH = 18;
const MINIMUM_TRACK_WIDTH_WITH_DETAILS = 12;
const MINIMUM_TRACK_WIDTH = 4;

export type ContextWindowBarTone = "success" | "warning" | "error" | "muted";

/** Context-window usage values used to build the responsive footer bar. */
export interface ContextWindowBarUsage {
  contextTokens: number | null;
  contextWindow: number;
  contextPercent: number | null;
  cost: number;
  tokensPerSecond: number | null;
}

/** Plain-text context-window bar segments that callers can theme without changing layout width. */
export interface ContextWindowBarLayout {
  label: string;
  filledTrack: string;
  emptyTrack: string;
  percentLabel: string;
  details: string;
  tone: ContextWindowBarTone;
}

function formatTokenCount(tokens: number) {
  if (tokens < 1_000) return `${Math.round(tokens)}`;
  if (tokens < 1_000_000) return `${Math.round(tokens / 1_000)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function clampContextPercent(percent: number | null) {
  if (percent === null || !Number.isFinite(percent)) return null;
  return Math.min(100, Math.max(0, percent));
}

function selectContextBarTone(percent: number | null): ContextWindowBarTone {
  if (percent === null) return "muted";
  if (percent >= 90) return "error";
  if (percent >= 70) return "warning";
  return "success";
}

function createContextDetailCandidates(usage: ContextWindowBarUsage) {
  const contextTokens =
    usage.contextTokens !== null && Number.isFinite(usage.contextTokens) && usage.contextTokens >= 0
      ? formatTokenCount(usage.contextTokens)
      : "?";
  const contextWindow =
    Number.isFinite(usage.contextWindow) && usage.contextWindow > 0
      ? formatTokenCount(usage.contextWindow)
      : "?";
  const tokenDetail = ` · ${contextTokens}/${contextWindow}`;
  const costDetail = ` · $${Math.max(0, usage.cost).toFixed(2)}`;
  const throughputDetail =
    usage.tokensPerSecond === null || !Number.isFinite(usage.tokensPerSecond)
      ? " · — tok/s"
      : ` · ${Math.round(Math.max(0, usage.tokensPerSecond))} tok/s`;

  return [
    `${tokenDetail}${costDetail}${throughputDetail}`,
    `${tokenDetail}${costDetail}`,
    tokenDetail,
    "",
  ];
}

function selectContextBarLabel(availableWidth: number, percentLabel: string) {
  for (const label of ["Context ›", "Ctx ›", "Ctx"]) {
    const fixedWidth = label.length + 1 + 1 + percentLabel.length;
    if (availableWidth - fixedWidth >= MINIMUM_TRACK_WIDTH) return label;
  }
  return "";
}

/** Builds a Codex-style occupied-context progress bar that never exceeds the supplied width. */
export function createContextWindowBarLayout(
  usage: ContextWindowBarUsage,
  availableWidth: number,
): ContextWindowBarLayout {
  const normalizedWidth = Math.max(0, Math.floor(availableWidth));
  const percent = clampContextPercent(usage.contextPercent);
  const percentLabel = percent === null ? "?%" : `${Math.round(percent)}%`;
  const label = selectContextBarLabel(normalizedWidth, percentLabel);

  if (!label) {
    return {
      label: "",
      filledTrack: "",
      emptyTrack: "",
      percentLabel: percentLabel.slice(0, normalizedWidth),
      details: "",
      tone: selectContextBarTone(percent),
    };
  }

  const fixedWidth = label.length + 1 + 1 + percentLabel.length;
  let details = "";
  let trackWidth = Math.min(DESIRED_TRACK_WIDTH, Math.max(MINIMUM_TRACK_WIDTH, normalizedWidth - fixedWidth));

  for (const candidate of createContextDetailCandidates(usage)) {
    const candidateTrackWidth = Math.min(DESIRED_TRACK_WIDTH, normalizedWidth - fixedWidth - candidate.length);
    if (candidateTrackWidth >= MINIMUM_TRACK_WIDTH_WITH_DETAILS || candidate === "") {
      details = candidate;
      trackWidth = Math.max(MINIMUM_TRACK_WIDTH, candidateTrackWidth);
      break;
    }
  }

  const filledWidth =
    percent === null ? 0 : Math.min(trackWidth, Math.max(0, Math.round((percent / 100) * trackWidth)));

  return {
    label,
    filledTrack: "━".repeat(filledWidth),
    emptyTrack: "─".repeat(trackWidth - filledWidth),
    percentLabel,
    details,
    tone: selectContextBarTone(percent),
  };
}

/** Joins an unstyled context-window layout for tests and narrow fallback rendering. */
export function formatPlainContextWindowBar(layout: ContextWindowBarLayout) {
  if (!layout.label) return layout.percentLabel;
  return `${layout.label} ${layout.filledTrack}${layout.emptyTrack} ${layout.percentLabel}${layout.details}`;
}
