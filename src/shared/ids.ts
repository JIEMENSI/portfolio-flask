export function randomHex(bytes = 16): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomShareId(): string {
  return randomHex(32);
}
