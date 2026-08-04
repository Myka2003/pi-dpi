import { loadConfig, saveConfig } from "./config.ts";

export function loadGatewayState(): string {
  return loadConfig().currentGateway;
}

export function saveGatewayState(id: string): void {
  saveConfig({ currentGateway: id });
}

export function clearGatewayState(): boolean {
  const before = loadGatewayState();
  if (before === "") return false;
  saveGatewayState("");
  return true;
}
