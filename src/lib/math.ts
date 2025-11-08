export function bpsDelta(a: number, b: number) {
  return (Math.abs(a - b) / b) * 10_000; // basis points
}
