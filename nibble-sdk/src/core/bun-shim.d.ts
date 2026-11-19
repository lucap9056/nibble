// Merges with @types/bun when installed; otherwise stays empty so websocket types resolve to unknown.
// Type parameters must match @types/bun exactly, or the merge fails with TS2428.
declare module "bun" {
  interface ServerWebSocket<T = undefined> {}
  interface WebSocketHandler<T> {}
}
