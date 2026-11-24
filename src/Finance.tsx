const timeZone = 'America/Sao_Paulo'
export const dayKey = new Intl.DateTimeFormat('sv-SE', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
const shortDay = new Intl.DateTimeFormat('pt-BR', { timeZone: 'UTC', day: '2-digit', month: '2-digit' })

export function receiptsByPeriod(series: {day:string;amount:string}[], span: 7 | 30) {
  const today = new Date(dayKey.format(new Date()) + 'T12:00:00Z')
  const step = span === 7 ? 1 : 5
  const days = Array.from({ length: span }, (_, index) => {
    const date = new Date(today)
    date.setUTCDate(today.getUTCDate() - span + index + 1)
    return { date, key: date.toISOString().slice(0, 10) }
  })
  const totals = new Map(series.map(point=>[point.day,Number(point.amount)]))
  return days.filter((_, index) => index % step === 0).map((first, index) => {
    const group = days.slice(index * step, (index + 1) * step)
    const last = group[group.length - 1]
    const label = shortDay.format(last.date)
    return { label, range: step === 1 ? label : shortDay.format(first.date) + '–' + label,
      value: group.reduce((sum, day) => sum + (totals.get(day.key) ?? 0), 0) }
  })
}
