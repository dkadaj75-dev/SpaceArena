/**
 * Tiny typed pub/sub event bus.
 *
 * `TEventMap` maps event name -> payload type, e.g.:
 *
 * ```ts
 * type MyEvents = {
 *   "config:changed": { id: string };
 *   "ship:destroyed": { shipId: string; killerId: string | null };
 * };
 * const bus = new EventBus<MyEvents>();
 * bus.on("config:changed", (payload) => console.log(payload.id));
 * bus.emit("config:changed", { id: "ship.interceptor" });
 * ```
 */

export type EventHandler<T> = (payload: T) => void;

export class EventBus<TEventMap extends Record<string, unknown>> {
  private readonly listeners: {
    [K in keyof TEventMap]?: Set<EventHandler<TEventMap[K]>>;
  } = {};

  on<K extends keyof TEventMap>(event: K, handler: EventHandler<TEventMap[K]>): () => void {
    let set = this.listeners[event];
    if (!set) {
      set = new Set();
      this.listeners[event] = set;
    }
    set.add(handler);
    return () => this.off(event, handler);
  }

  once<K extends keyof TEventMap>(event: K, handler: EventHandler<TEventMap[K]>): () => void {
    const off = this.on(event, (payload) => {
      off();
      handler(payload);
    });
    return off;
  }

  off<K extends keyof TEventMap>(event: K, handler: EventHandler<TEventMap[K]>): void {
    this.listeners[event]?.delete(handler);
  }

  emit<K extends keyof TEventMap>(event: K, payload: TEventMap[K]): void {
    const set = this.listeners[event];
    if (!set || set.size === 0) return;
    // Copy to array so handlers can safely unsubscribe during emit.
    for (const handler of Array.from(set)) {
      handler(payload);
    }
  }

  clear(event?: keyof TEventMap): void {
    if (event === undefined) {
      for (const key of Object.keys(this.listeners)) {
        delete this.listeners[key as keyof TEventMap];
      }
      return;
    }
    delete this.listeners[event];
  }

  listenerCount<K extends keyof TEventMap>(event: K): number {
    return this.listeners[event]?.size ?? 0;
  }
}
