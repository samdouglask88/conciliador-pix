import type { ReactNode } from 'react'

const paths = {
  people: <><circle cx="9" cy="7" r="3"/><path d="M3 20v-2a5 5 0 0 1 5-5h2a5 5 0 0 1 5 5v2M16 4a3 3 0 0 1 0 6m1 3a5 5 0 0 1 4 5v2"/></>,
  pin: <><path d="m15 3 6 6-3 1-3 3v4l-8-8h4l3-3 1-3ZM11 13l-7 7"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></>,
  receipt: <><path d="M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21V3Z"/><path d="M9 8h6m-6 4h6"/></>,
  alert: <><circle cx="12" cy="12" r="9"/><path d="M12 8v4m0 4h.01"/></>,
  history: <><path d="M3 12a9 9 0 1 1 2.5 6.2M3 12V6m0 6h6m3-5v5l3 2"/></>,
  flask: <><path d="M9 3h6m-5 0v7l-5 8a2 2 0 0 0 1.7 3h10.6a2 2 0 0 0 1.7-3l-5-8V3M8 15h8"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  circleCheck: <><circle cx="12" cy="12" r="9"/><path d="m8 12 2.5 2.5L16 9"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  plus: <path d="M12 5v14M5 12h14"/>,
  search: <><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/></>,
  right: <path d="m9 5 7 7-7 7"/>,
  diagonal: <path d="M7 17 17 7M7 7h10v10"/>,
  refresh: <><path d="M20 7v5h-5M4 17v-5h5"/><path d="M5 9a7.5 7.5 0 0 1 12.6-3L20 9M4 15l2.4 3A7.5 7.5 0 0 0 19 15"/></>,
  close: <path d="m6 6 12 12M18 6 6 18"/>,
  store: <><path d="M4 10v10h16V10M3 10l2-6h14l2 6H3Zm6 10v-6h6v6"/></>,
} satisfies Record<string, ReactNode>

export type IconName = keyof typeof paths
export function Icon({ name, size = 19 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none"
    stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round">{paths[name]}</svg>
}


