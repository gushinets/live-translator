export function parseCliArguments(args: readonly string[]): Record<string, string> {
  const values = Object.create(null) as Record<string, string>;
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    const name = key?.startsWith("--") ? key.slice(2) : "";
    if (!name || !value || value.startsWith("--") || Object.hasOwn(values, name)) throw new Error("invalid_arguments");
    values[name] = value;
  }
  return values;
}
