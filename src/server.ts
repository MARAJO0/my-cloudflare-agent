import { Agent, routeAgentRequest, type AgentNamespace } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";

const tracedAI = wrapAISDK(ai, {
  storeMessages: false,
  storeTools: false,
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

export interface Env {
  MyAgent: AgentNamespace<MyAgent>;
  AI: Ai;
  CLOUDFLARE_API_TOKEN: string;
}

type Site = { nome: string; zoneId: string };

const APELIDOS: Array<{ pergunta: RegExp; dominio: RegExp }> = [
  { pergunta: /salgad|edilene/, dominio: /salgaderia/ },
  { pergunta: /ciss|selva|sobreviv|starlink|spot ?x|pirotecni/, dominio: /ciss/ },
  { pergunta: /florescer/, dominio: /florescer/ },
  { pergunta: /manaus|decora/, dominio: /manaus/ },
];

export class MyAgent extends Agent<Env> {
  cfHeaders() {
    return {
      Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  async listSites(): Promise<Site[] | { erro: string; detalhes: unknown }> {
    const res = await fetch(
      "https://api.cloudflare.com/client/v4/zones?per_page=50",
      { headers: this.cfHeaders() }
    );
    const data: any = await res.json();
    
