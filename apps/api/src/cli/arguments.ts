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

export function parseCliInstant(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("invalid_arguments");
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
  const offsetHour = Number(match[8] ?? 0), offsetMinute = Number(match[9] ?? 0);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > days[month - 1]! ||
      hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) {
    throw new Error("invalid_arguments");
  }
  const parsed = Date.parse(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error("invalid_arguments");
  return parsed;
}
