// Shared motivational quotes — one source used by both the Break overlay
// ("It's Break Time!") and My Day's hero card, so the two can't drift apart or
// duplicate a hardcoded string. The Break overlay picks one at random per break
// session; the hero picks one stable per calendar day (see quoteOfDay).

export const QUOTES = [
  "Rest is not a reward, it's what makes you get better.",
  "Almost everything works again if you unplug it for a few minutes — including you.",
  "Take rest; a field that has rested gives a bountiful crop.",
  "Your calm mind is the ultimate weapon against your challenges.",
  "Sometimes the most productive thing you can do is step away.",
  "Consistent creators build extraordinary futures.",
  "Discipline today, bigger tomorrow.",
  "Small tasks, done daily, become big wins.",
  "Progress beats perfection — ship, learn, repeat.",
  "The work you finish today is the momentum you feel tomorrow.",
];

// A random quote (Break overlay — a fresh one each break).
export function randomQuote(): string {
  return QUOTES[Math.floor(Math.random() * QUOTES.length)];
}

// A quote that stays the same for the whole calendar day, so the hero card
// doesn't reshuffle on every background re-render (the greeting clock ticks
// every minute). Rotates day to day off the date, no randomness.
export function quoteOfDay(d: Date = new Date()): string {
  const dayIndex = Math.floor(
    Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86_400_000,
  );
  return QUOTES[((dayIndex % QUOTES.length) + QUOTES.length) % QUOTES.length];
}
