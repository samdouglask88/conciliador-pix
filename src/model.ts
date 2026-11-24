export type ChargeStatus = 'conciliada' | 'pendente'
export type Scenario = 'correct' | 'duplicate' | 'different'
export type ProcessingResult = 'conciliado' | 'divergente' | 'extra' | 'duplicado'
export type Entry = { id: string; title: string; description: string; time: string; tone: 'success' | 'warning' | 'neutral' }
export type Payment = { id: string; amount: number; time: string; settled: boolean }
export type PaymentNotification = {
  id: string
  paymentId: string
  time: string
  amount: number
  result: ProcessingResult
  duplicateOf?: string
}
export type Review = {
  id: string
  notificationId: string
  expected: number
  received: number
  difference: number
  reason: 'divergente' | 'extra'
  time: string
}
export type Charge = {
  id: number
  customer: string
  expected: number
  received: number | null
  status: ChargeStatus
  createdAt: string
  events: Entry[]
  payments: Payment[]
  notifications: PaymentNotification[]
  reviews: Review[]
}

const money = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100)

export interface SimulationResult {
  charge: Charge
  notification: PaymentNotification
  message: string
}

export interface ChargeRepository {
  list(): Promise<Charge[]>
  create(customer: string, expected: number): Promise<Charge>
  demonstration?: { simulate(id: number, scenario: Scenario): Promise<SimulationResult> }
}

function demoTime(daysAgo: number, hour: number) {
  const day = new Date()
  day.setUTCDate(day.getUTCDate() - daysAgo)
  day.setUTCHours(hour + 3, 0, 0, 0)
  return new Date(Math.min(day.getTime(), Date.now())).toISOString()
}

function newCharge(id: number, customer: string, expected: number, createdAt: string): Charge {
  return {
    id, customer, expected, createdAt, received: null, status: 'pendente',
    payments: [], notifications: [], reviews: [],
    events: [{ id: 'created-' + id, time: createdAt, title: 'Cobrança criada',
      description: 'Cobrança registrada no ambiente de demonstração.', tone: 'neutral' }],
  }
}

type IncomingNotification = { id: string; paymentId: string; amount: number; time: string }

// The mock webhook processor owns idempotency and settlement. Pages only consume its result.
function processNotification(current: Charge, incoming: IncomingNotification): SimulationResult {
  const original = current.notifications.find(event => event.paymentId === incoming.paymentId)
  if (original) {
    const notification: PaymentNotification = { ...incoming, result: 'duplicado', duplicateOf: original.id }
    const message = 'Reenvio registrado. Pagamento, baixa e revisões preservados.'
    return { notification, message, charge: { ...current,
      notifications: [...current.notifications, notification],
      events: [...current.events, { id: incoming.id, time: incoming.time,
        title: 'Notificação repetida', description: message, tone: 'neutral' }],
    } }
  }

  const expected = current.status === 'conciliada' ? 0 : current.expected
  const settled = current.status === 'pendente' && incoming.amount === current.expected
  const result = settled ? 'conciliado' : current.status === 'conciliada' ? 'extra' : 'divergente'
  const notification: PaymentNotification = { ...incoming, result }
  const payment: Payment = { id: incoming.paymentId, amount: incoming.amount, time: incoming.time, settled }
  const message = settled ? 'Pagamento fictício conciliado.'
    : result === 'extra' ? 'Pagamento extra registrado. A cobrança continua conciliada.'
    : 'Divergência registrada. A cobrança continua pendente.'
  const receivedEvent: Entry = { id: incoming.id, time: incoming.time, title: 'Pagamento recebido',
    description: 'Recebimento de ' + money(incoming.amount) + ' via Pix simulado.', tone: 'success' }
  const resultEvent: Entry = { id: incoming.id + '-resultado', time: incoming.time,
    title: settled ? 'Conciliação concluída' : result === 'extra' ? 'Pagamento extra' : 'Divergência identificada',
    description: message, tone: settled ? 'success' : 'warning' }
  const reviews: Review[] = result === 'conciliado' ? current.reviews : [...current.reviews, {
    id: 'rev-' + incoming.id, notificationId: incoming.id, expected, received: incoming.amount,
    difference: Math.abs(expected - incoming.amount), reason: result, time: incoming.time,
  }]
  return {
    notification, message,
    charge: { ...current, received: (current.received ?? 0) + incoming.amount,
      status: settled ? 'conciliada' : current.status,
      payments: [...current.payments, payment], notifications: [...current.notifications, notification],
      reviews, events: [...current.events, receivedEvent, resultEvent] },
  }
}

function demoCharge(id: number, customer: string, expected: number, amounts: number[], daysAgo: number) {
  return amounts.reduce((charge, amount, index) => {
    const paymentId = 'pix-' + id + '-' + (index + 1)
    return processNotification(charge, { id: 'evt-' + id + '-' + (index + 1), paymentId,
      amount, time: demoTime(daysAgo, 14 + index) }).charge
  }, newCharge(id, customer, expected, demoTime(daysAgo, 10)))
}

let charges = [
  demoCharge(1084, 'Mercado Horizonte', 1284500, [1284500], 0),
  demoCharge(1083, 'Studio Atlas', 245000, [225000], 2),
  demoCharge(1082, 'Casa Nativa', 342800, [], 3),
  demoCharge(1081, 'Oficina Norte', 589000, [589000], 4),
  demoCharge(1080, 'Maré Design', 96000, [96000, 12000], 11),
  demoCharge(1079, 'Vila Botânica', 126200, [], 12),
]
let nextEventId = 1

export const demoRepository: ChargeRepository = {
  async list() { return charges },
  async create(customer, expected) {
    if (!customer.trim() || !Number.isSafeInteger(expected) || expected < 1) {
      throw new Error('Informe um pagador e um valor válido.')
    }
    const charge = newCharge(Math.max(...charges.map(item => item.id)) + 1, customer.trim(), expected, new Date().toISOString())
    charges = [charge, ...charges]
    return charge
  },
  demonstration: {
    async simulate(id, scenario) {
      await new Promise(resolve => setTimeout(resolve, 420))
      const current = charges.find(charge => charge.id === id)
      if (!current) throw new Error('Cobrança indisponível.')
      const sequence = nextEventId++
      const lastNotification = current.notifications[current.notifications.length - 1]
      if (scenario === 'duplicate' && !lastNotification) {
        throw new Error('Simule um pagamento antes de repetir a notificação.')
      }
      const amount = scenario === 'duplicate' ? lastNotification.amount : scenario === 'correct' ? current.expected
        : current.expected > 1 ? current.expected - Math.max(1, Math.round(current.expected / 10)) : 2
      const result = processNotification(current, {
        id: 'evt-demo-' + sequence,
        paymentId: scenario === 'duplicate' ? lastNotification.paymentId : 'pix-demo-' + sequence,
        time: new Date().toISOString(), amount,
      })
      charges = charges.map(item => item.id === id ? result.charge : item)
      return result
    },
  },
}
