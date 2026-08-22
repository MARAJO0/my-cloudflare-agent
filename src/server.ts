// forcar rebuild
import { Agent, routeAgentRequest, type AgentNamespace } from "agents";
import * as ai from "ai";
import { wrapAISDK } from "agents/observability/ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";

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
  CLOUDFLARE_ZONE_ID: string;
}

export class MyAgent extends Agent<Env> {
  cfHeaders() {
    return {
      Authorization: `Bearer ${this.env.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json",
    };
  }

  buildTools() {
    return {
      statusDoBotFightMode: ai.tool({
        description:
          "Verifica se o Bot Fight Mode (proteção contra bots) está ativado no site.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/bot_management`,
            { headers: this.cfHeaders() }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui consultar o Bot Fight Mode.", detalhes: data.errors };
          }
          return { botFightModeAtivado: data.result?.fight_mode ?? null };
        },
      }),

      configuracoesDeSeguranca: ai.tool({
        description:
          "Consulta o nível de segurança e o modo SSL configurados no site.",
        inputSchema: z.object({}),
        execute: async () => {
          const res = await fetch(
            `https://api.cloudflare.com/client/v4/zones/${this.env.CLOUDFLARE_ZONE_ID}/settings`,
            { headers: this.cfHeaders() }
          );
          const data: any = await res.json();
          if (!data.success) {
            return { erro: "Não consegui consultar as configurações.", detalhes: data.errors };
          }
          const settings: Array<{ id: string; value: unknown }> = data.result ?? [];
          const find = (id: string) => settings.find((s) => s.id === id)?.value ?? null;
          return {
            nivelDeSeguranca: find("security_level"),
            modoSSL: find("ssl"),
          };
        },
      }),
    };
  }

  async onRequest(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    let message: string | null = null;

    if (request.method === "GET") {
      const url = new URL(request.url);
      message = url.searchParams.get("message");
    } else if (request.method === "POST") {
      const body = await request.json<{ message?: string }>();
      message = body.message ?? null;
    }

    if (!message) {
      return new Response(
        "Manda uma mensagem: adicione ?message=sua+pergunta na URL, ou faça um POST com { \"message\": \"...\" }",
        { status: 400, headers: corsHeaders }
      );
    }

    const workersai = createWorkersAI({ binding: this.env.AI });

    const result = await tracedAI.generateText({
      model: workersai("@cf/meta/llama-3.1-8b-instruct-fast"),
      system:
        "Você ajuda a monitorar a segurança de um site na Cloudflare. Quando o usuário perguntar sobre bots, segurança, SSL ou configurações do site, use as ferramentas disponíveis para responder com dados reais em vez de inventar. Responda em português.",
      prompt: message,
      tools: this.buildTools(),
      stopWhen: ai.stepCountIs(4),
      experimental_telemetry: {
        isEnabled: true,
        functionId: "my-agent.chat",
        metadata: {
          agentName: "my-cloudflare-agent",
          agentId: this.name,
          conversationId: this.name,
        },
      },
    });

    return new Response(result.text, {
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return (
      (await routeAgentRequest(request, env)) ??
      new Response(
        "Not found. Try /agents/my-agent/<conversation-id>?message=oi",
        { status: 404 }
      )
    );
  },
};
