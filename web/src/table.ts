export function cellColor(value: any): string {
  if (isNaN(value) || value === 0) {
    return ''
  }
  if (value > 0) {
    return 'text-danger'
  }
  return 'text-success'
}
