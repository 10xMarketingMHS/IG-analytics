// Clock times always read 12-hour, "7:04 PM", whatever the browser is set to
// (a 24-hour setting would show 19:04). Dates keep the browser's own style.
const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
const HOUR = new Intl.DateTimeFormat("en-US", { hour: "numeric", hour12: true });

// "7:04 PM"
export const clockTime = (d: Date | string | number): string => CLOCK.format(new Date(d));

// "7 PM" on the hour, "7:30 PM" otherwise.
export const clockTimeShort = (d: Date | string | number): string => {
  const date = new Date(d);
  return (date.getMinutes() ? CLOCK : HOUR).format(date);
};

// A date with its time: "18 Oct 2026, 7:04 PM" (the date in the browser's order).
export const dateTime = (d: Date | string | number): string =>
  `${new Date(d).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}, ${clockTime(d)}`;
