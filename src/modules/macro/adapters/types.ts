export type MacroSourceState = "healthy" | "degraded" | "unavailable" | "not_configured" | "unsupported";

export type MacroSeriesMetadata = {
  id: string;
  sourceId: string;
  sourceSeriesId: string;
  name: string;
  frequency: string;
  unit: string | null;
  sourceUrl: string;
};

export type MacroObservation = {
  seriesId: string;
  value: number;
  observedAt: string;
  releasedAt: string | null;
  vintage: string | null;
  sourceUrl: string;
};

export type MacroSourceHealth = {
  sourceId: string;
  state: MacroSourceState;
  checkedAt: string;
  observationCount: number;
  message: string | null;
};

export type MacroAdapterResult = {
  series: MacroSeriesMetadata[];
  observations: MacroObservation[];
  health: MacroSourceHealth;
};

export type MacroFetch = typeof fetch;

export interface MacroSourceAdapter<TRequest> {
  readonly sourceId: string;
  load(request: TRequest): Promise<MacroAdapterResult>;
}
