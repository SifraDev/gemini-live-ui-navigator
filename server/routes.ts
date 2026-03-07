import type { Express } from "express";
import { type Server } from "http";
import { setupWebSocketServer } from "./agent";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  setupWebSocketServer(httpServer);

  return httpServer;
}
