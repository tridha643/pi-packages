import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  CURSOR_MARKER,
  matchesKey,
  truncateToWidth,
} from "@earendil-works/pi-tui";

// Match the blue palette used by Ben Davis's Pi header:
// https://github.com/davis7dotsh/my-pi-setup/tree/main/extensions/ui-customization

type Rgb = [number, number, number];

type SkillCommand = {
  invocationName: string;
  skillName: string;
};

type SkillSuggestion = {
  skillName: string;
  suffix: string;
};

const RESET = "\x1b[0m";
const FAKE_CURSOR = "\x1b[7m \x1b[0m";
const ACCEPTED_SKILL_COLOR: Rgb = [230, 186, 112];
const GHOST_SKILL_COLOR: Rgb = [111, 118, 133];
const BLUE_GRADIENT_PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const ANSI_ESCAPE_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const EDITOR_BORDER_PATTERN = /^─+(?: [↑↓] \d+ more ─*)?$/u;
const SKILL_STYLE_COMMAND_NAMES = new Set(["side", "side-end"]);

function escapeRegularExpression(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mixColorChannel(a: number, b: number, amount: number): number {
  return Math.round(a + (b - a) * amount);
}

function sampleBlueGradient(position: number): Rgb {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * BLUE_GRADIENT_PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % BLUE_GRADIENT_PALETTE.length;
  const amount = scaled - index;
  const start = BLUE_GRADIENT_PALETTE[index]!;
  const end = BLUE_GRADIENT_PALETTE[nextIndex]!;

  return [
    mixColorChannel(start[0], end[0], amount),
    mixColorChannel(start[1], end[1], amount),
    mixColorChannel(start[2], end[2], amount),
  ];
}

function colorForeground([red, green, blue]: Rgb, text: string): string {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function renderBlueGradient(text: string, phase: number): string {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : colorForeground(
            sampleBlueGradient(index / span + phase),
            character,
          ),
    )
    .join("");
}

function isEditorBorderLine(line: string): boolean {
  const plainLine = line.replace(ANSI_ESCAPE_PATTERN, "");
  return EDITOR_BORDER_PATTERN.test(plainLine);
}

/** Finds the shortest skill whose name starts with the slash token at the cursor. */
export function findInlineSkillSuggestion(
  textBeforeCursor: string,
  skillNames: string[],
): SkillSuggestion | undefined {
  const match = textBeforeCursor.match(/(?:^|\s)\/([a-z0-9-]*)$/i);
  const prefix = match?.[1];
  if (!prefix) return undefined;

  const skillName = skillNames
    .filter((name) => name.startsWith(prefix) && name !== prefix)
    .sort((left, right) =>
      left.length === right.length
        ? left.localeCompare(right)
        : left.length - right.length,
    )[0];
  if (!skillName) return undefined;

  return {
    skillName,
    suffix: skillName.slice(prefix.length),
  };
}

/** Moves a completed skill-style slash token to Pi's canonical command position on submit. */
export function transformInlineSkillInvocation(
  text: string,
  skills: SkillCommand[],
): string | undefined {
  for (const skill of skills) {
    const tokenPattern = new RegExp(
      `(^|\\s)/${escapeRegularExpression(skill.skillName)}(?=\\s|$)`,
    );
    const match = tokenPattern.exec(text);
    if (!match) continue;

    const tokenStart = match.index + match[1]!.length;
    const tokenEnd = tokenStart + skill.skillName.length + 1;
    const remainingText = `${text.slice(0, tokenStart)}${text.slice(tokenEnd)}`
      .replace(/[ \t]{2,}/g, " ")
      .trim();

    const transformedText = remainingText
      ? `/${skill.invocationName} ${remainingText}`
      : `/${skill.invocationName}`;
    return transformedText === text ? undefined : transformedText;
  }

  return undefined;
}

class BlueGradientSkillEditor extends CustomEditor {
  private readonly skillNames: string[];
  private readonly acceptedSkillPattern?: RegExp;

  constructor(
    tui: ConstructorParameters<typeof CustomEditor>[0],
    theme: ConstructorParameters<typeof CustomEditor>[1],
    keybindings: ConstructorParameters<typeof CustomEditor>[2],
    skillNames: string[],
  ) {
    super(tui, theme, keybindings);
    this.skillNames = skillNames;
    this.acceptedSkillPattern = skillNames.length
      ? new RegExp(
          `(^|\\s)(/(?:${skillNames
            .map(escapeRegularExpression)
            .join("|")}))(?=$|\\s|\\x1b)`,
          "g",
        )
      : undefined;
  }

  override handleInput(data: string): void {
    const cursor = this.getCursor();
    const currentLine = this.getLines()[cursor.line] ?? "";
    const suggestion = findInlineSkillSuggestion(
      currentLine.slice(0, cursor.col),
      this.skillNames,
    );

    if (suggestion && matchesKey(data, "tab")) {
      this.insertTextAtCursor(`${suggestion.suffix} `);
      return;
    }

    super.handleInput(data);
  }

  override render(width: number): string[] {
    const cursor = this.getCursor();
    const currentLine = this.getLines()[cursor.line] ?? "";
    const suggestion = findInlineSkillSuggestion(
      currentLine.slice(0, cursor.col),
      this.skillNames,
    );
    let borderIndex = 0;

    return super.render(width).map((line) => {
      if (isEditorBorderLine(line)) {
        const plainLine = line.replace(ANSI_ESCAPE_PATTERN, "");
        const phase = borderIndex === 0 ? 0 : 0.18;
        borderIndex += 1;
        return renderBlueGradient(plainLine, phase);
      }

      let renderedLine = this.acceptedSkillPattern
        ? line.replace(
            this.acceptedSkillPattern,
            (_match, whitespace: string, token: string) =>
              `${whitespace}${colorForeground(ACCEPTED_SKILL_COLOR, token)}`,
          )
        : line;

      if (!suggestion || !renderedLine.includes(CURSOR_MARKER)) {
        return renderedLine;
      }

      const ghostSuffix = colorForeground(
        GHOST_SKILL_COLOR,
        suggestion.suffix,
      );
      renderedLine = renderedLine.replace(
        `${CURSOR_MARKER}${FAKE_CURSOR}`,
        `${CURSOR_MARKER}${FAKE_CURSOR}${ghostSuffix}`,
      );
      return truncateToWidth(renderedLine, width, "");
    });
  }
}

export default function blueGradientEditor(pi: ExtensionAPI): void {
  let skills: SkillCommand[] = [];

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    skills = pi
      .getCommands()
      .filter(
        (command) =>
          command.source === "skill" ||
          SKILL_STYLE_COMMAND_NAMES.has(command.name),
      )
      .map((command) => ({
        invocationName: command.name,
        skillName: command.name.replace(/^skill:/, ""),
      }));

    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new BlueGradientSkillEditor(
          tui,
          theme,
          keybindings,
          skills.map((skill) => skill.skillName),
        ),
    );
  });

  pi.on("input", (event) => {
    const transformedText = transformInlineSkillInvocation(event.text, skills);
    return transformedText
      ? { action: "transform", text: transformedText }
      : { action: "continue" };
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setEditorComponent(undefined);
  });
}
