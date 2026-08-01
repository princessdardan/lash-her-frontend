const LOCAL_DATE_TIME_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

export function localDateTimeToUtc(
  value: string,
  timezone: string,
): Date {
  const match = LOCAL_DATE_TIME_PATTERN.exec(value.trim());

  if (!match) {
    throw new Error("A valid local date and time is required");
  }

  const desired = {
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    month: Number(match[2]),
    year: Number(match[1]),
  };
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
  );
  const formatter = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    timeZone: timezone,
    year: "numeric",
  });
  let candidate = desiredUtc;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = getParts(new Date(candidate), formatter);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
    );
    candidate += desiredUtc - actualAsUtc;
  }

  const result = new Date(candidate);
  const resolved = getParts(result, formatter);

  if (
    resolved.year !== desired.year
    || resolved.month !== desired.month
    || resolved.day !== desired.day
    || resolved.hour !== desired.hour
    || resolved.minute !== desired.minute
  ) {
    throw new Error("This local time does not exist in the resource timezone");
  }

  return result;
}

function getParts(date: Date, formatter: Intl.DateTimeFormat) {
  const values = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, Number(part.value)]),
  );

  return {
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    month: values.month,
    year: values.year,
  };
}
