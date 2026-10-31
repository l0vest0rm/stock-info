/** Local browser execution identity. Old numeric taskId values remain readable
 * as legacy provenance; a local CEA execution always has a UUID runId. */
export interface WebResearchTask {
  taskId?: number | string | null;
  runId?: string | null;
  engine?: 'cea' | null;
  revision?: number | null;
  name?: string;
  status?: string;
  errorMessage?: string | null;
  recoveryRequired?: boolean;
  lastStep?: string | null;
  createdAt?: number | null;
  updatedAt?: number | null;
  completedAt?: number | null;
}
