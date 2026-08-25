/** Model-facing schema description for delegate ids to await. */
export const SUBAGENT_WAIT_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent or chain ids to wait for, e.g. ["sa-1", "chain-1"]',
};

/** Model-facing schema description for delegate ids to cancel. */
export const SUBAGENT_CANCEL_PARAMETER_DESCRIPTIONS = {
  ids: 'Subagent or chain ids to cancel, e.g. ["sa-1", "chain-1"]',
};

/** Model-facing schema description for one delegate id to inspect. */
export const SUBAGENT_CHECK_PARAMETER_DESCRIPTIONS = {
  id: "Subagent or chain id",
};

/** Build the child completion or failure wrapper delivered to the parent. */
export function buildSubagentResultMessage(options: {
  id: string;
  title: string;
  status: "running" | "done" | "error";
  errorText?: string;
  output: string;
}): string {
  const verb = options.status === "error" ? "failed" : "finished";
  let text = `Subagent ${options.id} "${options.title}" ${verb}.`;
  if (options.errorText) text += `\nError: ${options.errorText}`;
  return `${text}\n\n${options.output}`;
}
