export function redirect() {
  const a = 'a'
  const b = { a, b: 'b' }
  const c = { b }
  return {
    ...b,
    c,
    d: 'd',
  }
}
