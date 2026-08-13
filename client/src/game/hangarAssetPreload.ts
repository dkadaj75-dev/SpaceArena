import type { ConfigService, ModuleConfig, ShipConfig } from "@space-arena/shared";
import type { ModelLoadJob } from "../core/modelLoadQueue.js";

export interface HangarLoadoutSelection {
  shipId?: string | null;
  moduleIds?: readonly (string | null)[] | null;
}

/** Owned hulls and only the modules currently fitted to those hulls. */
export function hangarPriorityJobs(
  configs: ConfigService,
  ownedShipIds: ReadonlySet<string>,
  selection: HangarLoadoutSelection,
): ModelLoadJob[] {
  const jobs: ModelLoadJob[] = [];
  const moduleIds = new Set<string>();
  for (const shipId of ownedShipIds) {
    const ship = configs.get<ShipConfig>("ship", shipId);
    if (!ship) continue;
    if (ship.render.model) jobs.push({ id: ship.id, render: ship.render });
    const fitting = ship.id === selection.shipId && selection.moduleIds
      ? selection.moduleIds
      : ship.defaultFitting;
    for (const moduleId of fitting ?? []) if (moduleId) moduleIds.add(moduleId);
  }
  for (const moduleId of moduleIds) {
    const module = configs.get<ModuleConfig>("module", moduleId);
    if (module?.render?.model) jobs.push({ id: module.id, render: module.render });
  }
  return jobs;
}

/** Locked/shop hulls use the same deduplicating background queue. */
export function allHangarShipJobs(configs: ConfigService): ModelLoadJob[] {
  return configs.getAll<ShipConfig>("ship")
    .filter((ship) => typeof ship.render.model === "string")
    .map((ship) => ({ id: ship.id, render: ship.render }));
}
