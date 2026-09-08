import { createCli, loadCluster, type ProjectBindings, type Transport } from "../../src/mod.ts";

export interface ExternalConsumer {
  readonly createCli: typeof createCli;
  readonly loadCluster: typeof loadCluster;
  readonly bindings?: ProjectBindings;
  readonly transport?: Transport;
}

export const consumer: ExternalConsumer = { createCli, loadCluster };
