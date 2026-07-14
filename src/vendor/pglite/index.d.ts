export class PGlite {
  constructor(options?: { readonly extensions?: Readonly<Record<string, unknown>> })
  readonly waitReady: Promise<void>
  exec(sql: string): Promise<unknown>
  query<Row = Record<string, unknown>>(text: string, params?: readonly unknown[]): Promise<{ readonly rows: Row[] }>
  close(): Promise<void>
}
