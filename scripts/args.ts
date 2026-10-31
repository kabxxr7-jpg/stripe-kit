// Minimal flag parsing shared by the CLIs: `--name value`, `--flag`, and positional arguments.
export function parseArgs(argv: readonly string[], valueFlags: readonly string[]): { flags: Map<string, string | true>; positional: string[] } {
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    if (valueFlags.includes(name)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags.set(name, value);
    } else {
      flags.set(name, true);
    }
  }
  return { flags, positional };
}
