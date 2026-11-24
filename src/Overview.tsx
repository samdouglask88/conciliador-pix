import { useState } from 'react'
import type { ReactNode } from 'react'
import { Icon } from './Icon'
import { receiptsByPeriod } from './Finance'

import './overview.css'

const shortTime = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
})
const compact = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 })
const activityIcons = { success: 'circleCheck', warning: 'alert', neutral: 'receipt' } as const

const brl=new Intl.NumberFormat('pt-BR',{style:'currency',currency:'BRL'})
const money=(value:number|string)=>brl.format(Number(value)/100)
export type Dashboard = {
  paid:string;pending:string;paidCount:number;pendingCount:number;reviews:number;
  series:{day:string;amount:string}[];
  activity:{id:string;kind:'events'|'charges';outcome:string;amount:number|null;description?:string;created_at:string}[];
}
export type QueueItem={id:string;reason?:string;expected?:number|null;received?:number;charge_id?:string;charge_description?:string;client_name?:string}
type OverviewProps={
  summary?:Dashboard;period:7|30;setPeriod:(period:7|30)=>void;periodData?:Dashboard;
  periodState?:ReactNode;queue?:QueueItem[];queueState?:ReactNode;summaryState?:ReactNode;
  action:ReactNode;onboard?:ReactNode;onFilter:(page:string,filter:string)=>void;
  onOpen:(kind:string,id:string)=>void;label:(key?:string)=>string;
}

function Receipts({period,setPeriod,periodData,periodState}:OverviewProps) {
  const [point, setPoint] = useState<number>()
  const buckets = receiptsByPeriod(periodData?.series??[], period)
  const total = buckets.reduce((sum, bucket) => sum + bucket.value, 0)
  const peak = Math.max(1, ...buckets.map(bucket => bucket.value))
  const magnitude = 10 ** Math.floor(Math.log10(peak))
  const axisStep = Math.max(100, Math.ceil(peak / (4 * magnitude)) * magnitude)
  const limit = Math.ceil(peak / (2 * axisStep)) * 2 * axisStep
  const points = buckets.map((bucket, index) => ({
    x: (index + .5) * 600 / buckets.length,
    y: 108 - bucket.value / limit * 100,
  }))
  const selected = Math.min(point ?? buckets.length - 1,buckets.length-1)
  const path = points.map(({ x, y }) => x + ',' + y).join(' ')
  const first = points[0]
  const last = points[points.length - 1]

  return <section className="overview-receipts overview-enter" aria-labelledby="overview-receipts-title">
    <div className="overview-receipts-header">
      <div>
        <h2 id="overview-receipts-title"><Icon name="receipt" size={17}/> Recebimentos Pix</h2>
        {periodData&&<strong key={total} className="overview-total">{money(total)}</strong>}
        <p>Recebido nos últimos {period} dias</p>
      </div>
      <div className="overview-period" role="group" aria-label="Período dos recebimentos">
        {([7, 30] as const).map(span => <button key={span} aria-pressed={period === span}
          onClick={() => { setPeriod(span); setPoint(undefined) }}>{span} dias</button>)}
      </div>
    </div>
    {periodState??(periodData?.series.length===0?<p className="overview-empty">Nenhum recebimento neste período.</p>:periodData&&<>
    <div className="overview-chart-readout" aria-live="polite">
      <span>{buckets[selected].range}</span><strong>{money(buckets[selected].value)}</strong>
    </div>
    <div className="overview-chart">
      <div className="overview-chart-axis" aria-hidden="true">
        {[limit, limit / 2, 0].map(tick => <span key={tick}>R$ {compact.format(tick / 100)}</span>)}
      </div>
      <div className="overview-chart-body">
        <svg className="overview-plot" key={period} viewBox="0 0 600 110" preserveAspectRatio="none" aria-hidden="true">
          {[8, 58, 108].map(y => <line key={y} x1="0" x2="600" y1={y} y2={y} stroke="#4c7869" vectorEffect="non-scaling-stroke"/>)}
          <polygon points={first.x + ',108 ' + path + ' ' + last.x + ',108'} fill="#46c18d" fillOpacity=".22"/>
          <polyline className="overview-plot-line" points={path} fill="none" stroke="#8becb7" strokeWidth="2.5" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
          <line x1={points[selected].x} x2={points[selected].x} y1={points[selected].y} y2="108" stroke="#a9eecb" strokeDasharray="3 4" vectorEffect="non-scaling-stroke"/>
        </svg>
        <div className="overview-chart-controls" style={{ gridTemplateColumns: 'repeat(' + buckets.length + ', minmax(0, 1fr))' }}>
          {buckets.map((bucket, index) => <button key={bucket.label} aria-pressed={index === selected}
            aria-label={bucket.range + ', ' + money(bucket.value)}
            onClick={() => setPoint(index)} onFocus={() => setPoint(index)}
            onPointerEnter={event => { if (event.pointerType === 'mouse') setPoint(index) }}>
            <span className="overview-point-area"><i style={{ top: points[index].y / 110 * 100 + '%' }}/></span>
            <span>{bucket.label}</span>
          </button>)}
        </div>
      </div>
    </div>
    </>)}
  </section>
}

function Portfolio({summary,onFilter}:OverviewProps){
  if(!summary)return null
  const rows=[
    {title:'Total conciliado',color:'confirmed',icon:'check',help:'Acumulado desde o início',value:money(summary.paid),page:'charges',filter:'paid'},
    {title:'A receber',color:'pending',icon:'clock',help:'Cobranças pendentes agora',value:money(summary.pending),page:'charges',filter:'pending'},
    {title:'Em revisão',color:'review',icon:'alert',help:'Ocorrências em aberto',value:String(summary.reviews),page:'reviews',filter:'open'},
  ] as const
  return <section className="overview-portfolio overview-enter" aria-labelledby="portfolio-title">
    <div className="overview-portfolio-heading"><h2 id="portfolio-title">Carteira de cobranças</h2>
      <span>{summary.paidCount+summary.pendingCount} cobranças</span></div>
    <div className="overview-distribution" aria-hidden="true">
      {summary.paidCount>0&&<i className="confirmed" style={{flexGrow:summary.paidCount}}/>}
      {summary.pendingCount>0&&<i className="pending" style={{flexGrow:summary.pendingCount}}/>}
    </div>
    <ul>{rows.map(row=><li key={row.filter}><button onClick={()=>onFilter(row.page,row.filter)}>
      <span className={'overview-wallet-icon '+row.color}><Icon name={row.icon} size={15}/></span>
      <span className="overview-wallet-label">{row.title}<small>{row.help}</small></span>
      <strong>{row.value}</strong><Icon name="right" size={13}/>
    </button></li>)}</ul>
  </section>
}

function Activity({summary,onOpen,onFilter,label}:OverviewProps){
  const events=summary?.activity??[]
  return <section className="overview-activity overview-enter" aria-labelledby="activity-title">
    <header className="overview-section-heading"><h2 id="activity-title">Atividade recente</h2>
      <button className="overview-link" onClick={()=>onFilter('events','')}>Ver eventos <Icon name="diagonal" size={14}/></button></header>
    {!events.length?<p className="overview-empty">Nenhuma atividade registrada.</p>:<ul>
      {events.slice(0,3).map(event=>{
        const tone=event.outcome==='settled'?'success':['divergent','extra','conflict'].includes(event.outcome)?'warning':'neutral'
        return <li key={event.kind+':'+event.id}><button onClick={()=>onOpen(event.kind,event.id)}>
          <span className={'overview-event-icon '+tone}><Icon name={activityIcons[tone]} size={17}/></span>
          <span><strong>{label(event.outcome)}</strong><small>{[event.description,event.amount==null?null:money(event.amount)].filter(Boolean).join(' · ')||event.id}</small></span>
          <time dateTime={event.created_at}>{shortTime.format(new Date(event.created_at))}</time>
        </button></li>
      })}
    </ul>}
  </section>
}

function ReviewQueue({queue,queueState,onOpen,onFilter,label}:OverviewProps){
  return <section className="overview-review overview-enter" aria-labelledby="overview-review-title">
    <header className="overview-section-heading"><h2 id="overview-review-title">Fila de revisão</h2><Icon name="alert" size={19}/></header>
    {queueState??(!queue?.length?<p className="overview-empty">Nenhuma divergência a revisar.</p>:<ul>
      {queue.slice(0,3).map(review=>{
        const difference=review.received!=null&&review.expected!=null?review.received-review.expected:null
        return <li key={review.id}><button onClick={()=>onOpen('reviews',review.id)}>
          <span><strong>{review.client_name??review.charge_description??label(review.reason)}</strong>
            <small>{review.client_name||review.charge_description?label(review.reason):review.charge_id}</small></span>
          {difference!==null&&<span className="overview-difference"><strong>{money(Math.abs(difference))}</strong>
            <small>{difference<0?'A menor':difference>0?'A maior':'Diferença'}</small></span>}
        </button></li>
      })}
    </ul>)}
    <button className="overview-link" onClick={()=>onFilter('reviews','open')}>Abrir revisões <Icon name="right" size={14}/></button>
  </section>
}

export function Overview(props:OverviewProps){
  return <div className="overview">
    <header className="overview-intro overview-enter">
      <div><p className="overview-context">Financeiro <span aria-hidden="true">/</span> Conciliação Pix</p>
        <h1>Visão geral</h1><p>Recebimentos, cobranças e divergências da sua operação.</p></div>
      {props.action}
    </header>
    {props.summaryState}
    {props.onboard}
    {props.summary&&<div className="overview-grid">
      <Receipts {...props}/><Portfolio {...props}/><Activity {...props}/><ReviewQueue {...props}/>
    </div>}
  </div>
}
