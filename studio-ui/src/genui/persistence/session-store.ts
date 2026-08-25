import type { WidgetCanvasCamera, WidgetCanvasItemState } from "../canvas/widget-canvas";
import type { DataBindingReference } from "../contracts";

export interface StoredCanvasInstance {
  canvas_instance_id: string;
  plan_instance_id?: string;
  widget_id: string;
  widget_version: string;
  arguments: Record<string, unknown>;
  data_binding?: DataBindingReference;
  canvas?: WidgetCanvasItemState;
}

export interface CanvasSnapshot {
  schema_version: 3;
  camera: WidgetCanvasCamera;
  active_canvas_instance_id: string | null;
  instances: StoredCanvasInstance[];
}

export interface CanvasSaveResult {
  revision: number;
  updated_at: string;
}

export interface StoredCanvasSnapshot extends CanvasSnapshot, CanvasSaveResult {
  canvas_id: string;
}

export interface CanvasSessionStore {
  load(canvasId: string): Promise<StoredCanvasSnapshot | null>;
  save(
    canvasId: string,
    snapshot: CanvasSnapshot,
    expectedRevision: number | null,
  ): Promise<CanvasSaveResult>;
}

export class CanvasSessionConflictError extends Error {
  constructor(
    readonly expectedRevision: number | null,
    readonly actualRevision: number | null,
  ) {
    super(
      `canvas changed concurrently (expected revision ${String(expectedRevision)}, found ${String(actualRevision)})`,
    );
  }
}

export class MemoryCanvasSessionStore implements CanvasSessionStore {
  readonly #records = new Map<string, StoredCanvasSnapshot>();

  async load(canvasId: string): Promise<StoredCanvasSnapshot | null> {
    const record = this.#records.get(canvasId);
    return record ? structuredClone(record) : null;
  }

  async save(
    canvasId: string,
    snapshot: CanvasSnapshot,
    expectedRevision: number | null,
  ): Promise<CanvasSaveResult> {
    const current = this.#records.get(canvasId);
    const actualRevision = current?.revision ?? null;
    if (actualRevision !== expectedRevision) {
      throw new CanvasSessionConflictError(expectedRevision, actualRevision);
    }
    const result = {
      revision: (actualRevision ?? 0) + 1,
      updated_at: new Date().toISOString(),
    };
    this.#records.set(canvasId, structuredClone({
      ...snapshot,
      canvas_id: canvasId,
      ...result,
    }));
    return result;
  }
}
