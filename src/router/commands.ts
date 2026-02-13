export type CommandName =
  | 'help'
  | 'status'
  | 'stop'
  | 'reset'
  | 'debug'
  | 'thread'
  | 'compact'
  | 'model'
  | 'effort'
  | 'spark'
  | 'pause'
  | 'resume'
  | 'notifications'
  | 'restart';

export interface ParsedCommand {
  name: CommandName;
  args: string[];
  raw: string;
}

const COMMANDS = new Set<CommandName>([
  'help',
  'status',
  'stop',
  'reset',
  'debug',
  'thread',
  'compact',
  'model',
  'effort',
  'spark',
  'pause',
  'resume',
  'notifications',
  'restart',
]);

export function parseSlashCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) {
    return null;
  }

  const withoutSlash = trimmed.slice(1).trim();
  if (withoutSlash.length === 0) {
    return null;
  }

  const parts = withoutSlash.split(/\s+/g);
  const [nameRaw, ...args] = parts;
  if (!nameRaw) {
    return null;
  }

  const name = nameRaw.toLowerCase() as CommandName;
  if (!COMMANDS.has(name)) {
    return null;
  }

  return {
    name,
    args,
    raw: input,
  };
}

export function helpText(): string {
  return [
    'Commands:',
    '/help - show this help',
    '/status - show bridge/session status',
    '/stop - interrupt active turn',
    '/reset - start a fresh thread and clear active turn',
    '/debug - show timeline for most recent turn',
    '/thread - show current thread id',
    '/thread new - start a new thread',
    '/compact - request Codex thread compaction',
    '/model <id> - set model (e.g. gpt-5.3-codex or gpt-5.3-codex-spark)',
    '/effort [level] - view or set reasoning effort for current model',
    '/spark - toggle between current model and spark',
    '/pause - emergency kill-switch (pause turns, disable auto-approve)',
    '/resume - re-enable turns and auto-approve',
    '/notifications [count] [source] - show recent notifications',
    '/restart <codex|bridge|both> - restart runtime components',
  ].join('\n');
}
